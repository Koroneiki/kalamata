import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { abortable } from '../shared/abortable.ts'
import {
  ApplicationTransactionError,
  type ApplicationDepotRecord,
  type ApplicationTransactionEvent,
  type ApplicationTransactionResult,
  type DesiredApplicationDepot,
  type InstalledApplicationDepot,
} from './install/transaction/types.ts'
import { recoverAndRunApplicationTransaction } from './install/transaction/transaction.ts'
import { parseManifest, validateManifest } from './manifests/manifest-codec.ts'
import type { DepotManifest } from './manifests/types.ts'
import { SteamContentClient } from './transfer/steam-content-client.ts'
import type { ChunkClient, ContentServer } from './transfer/chunk-client.ts'
import type { SteamSession } from '../steam/steam-session.ts'

export interface ApplicationDepotInput {
  depotId: number
  ownerAppId: number
  manifestId: string
  manifestPath: string
  depotKey: Buffer
}

export interface ReconcileApplicationOptions {
  kind: 'download' | 'reconcile' | 'repair'
  appId: number
  outputDirectory: string
  installedDepots: ApplicationDepotInput[]
  desiredDepots: ApplicationDepotInput[]
  signal?: AbortSignal
  onEvent?: (event: ApplicationTransactionEvent) => void
  reconcile: (desired: ApplicationDepotRecord[]) => Promise<void>
}

export class DepotDownloadService {
  constructor(private readonly session: SteamSession) {}

  loadApplicationDepots(
    inputs: ApplicationDepotInput[],
  ): Promise<InstalledApplicationDepot[]> {
    // Repeated identities may have different owners, but must use one path and key.
    const manifests = new Map<
      string,
      { input: ApplicationDepotInput; manifest: Promise<DepotManifest> }
    >()
    return Promise.all(
      inputs.map(async (input) => {
        const key = `${input.depotId}:${input.manifestId}`
        let loaded = manifests.get(key)
        if (loaded) {
          if (
            loaded.input.manifestPath !== input.manifestPath ||
            !loaded.input.depotKey.equals(input.depotKey)
          ) {
            throw new Error(`Conflicting inputs for depot ${input.depotId}`)
          }
        } else {
          loaded = { input, manifest: loadApplicationManifest(input) }
          manifests.set(key, loaded)
        }
        return {
          depotId: input.depotId,
          ownerAppId: input.ownerAppId,
          manifest: await loaded.manifest,
        }
      }),
    )
  }

  async reconcileApplication(
    options: ReconcileApplicationOptions,
  ): Promise<ApplicationTransactionResult> {
    validateApplicationOptions(options)
    let result: ApplicationTransactionResult
    {
      throwIfAborted(options.signal)
      const loaded = await this.loadApplicationDepots([
        ...options.installedDepots,
        ...options.desiredDepots,
      ])
      const installedDepots = loaded.slice(0, options.installedDepots.length)
      const desiredInputs = loaded.slice(options.installedDepots.length)
      throwIfAborted(options.signal)

      const clients: LazySteamContentClient[] = []
      const agents = {
        http: new http.Agent({ keepAlive: true }),
        https: new https.Agent({ keepAlive: true }),
      }
      const controller = new AbortController()
      const onAbort = () =>
        controller.abort(
          options.signal?.reason ??
            new DOMException('Application operation aborted', 'AbortError'),
        )
      if (options.signal?.aborted) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
      const removeDisconnectListener = this.session.onDisconnect((error) =>
        controller.abort(
          new ApplicationTransactionError(
            'steam',
            'Steam disconnected during the application operation',
            { cause: error },
          ),
        ),
      )
      try {
        const desiredDepots: DesiredApplicationDepot[] = desiredInputs.map(
          (depot, index) => {
            const client = new LazySteamContentClient(
              this.session,
              options.desiredDepots[index]!.depotKey,
              controller.signal,
              agents,
            )
            clients.push(client)
            return { ...depot, client }
          },
        )
        result = await recoverAndRunApplicationTransaction({
          kind: options.kind,
          appId: options.appId,
          outputDirectory: options.outputDirectory,
          installedDepots,
          desiredDepots,
          signal: controller.signal,
          reconcile: options.reconcile,
          ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        })
      } finally {
        removeDisconnectListener()
        options.signal?.removeEventListener('abort', onAbort)
        for (const client of clients) client.dispose()
        agents.http.destroy()
        agents.https.destroy()
      }
    }
    return result
  }
}

class LazySteamContentClient implements ChunkClient {
  #client: Promise<SteamContentClient> | undefined

  constructor(
    private readonly session: SteamSession,
    private readonly depotKey: Buffer,
    private readonly operationSignal: AbortSignal,
    private readonly agents: { http: http.Agent; https: https.Agent },
  ) {}

  async getContentServers(appId: number) {
    return (await this.getClient()).getContentServers(appId)
  }

  async downloadChunk(
    appId: number,
    depotId: number,
    sha: string,
    server: ContentServer,
    signal?: AbortSignal,
    expectedSize?: number,
  ) {
    return (await this.getClient()).downloadChunk(
      appId,
      depotId,
      sha,
      server,
      signal,
      expectedSize,
    )
  }

  dispose(): void {
    void this.#client?.then((client) => client.dispose()).catch(() => {})
  }

  private getClient(): Promise<SteamContentClient> {
    this.#client ??= abortable(this.session.getClient(), this.operationSignal)
      .then((user) => new SteamContentClient(user, this.depotKey, this.agents))
      .catch((error) => {
        if (this.operationSignal.aborted) throw this.operationSignal.reason
        throw new ApplicationTransactionError(
          'steam',
          'Steam connection or authorization failed',
          { cause: error },
        )
      })
    return this.#client
  }
}

async function loadApplicationManifest(
  input: ApplicationDepotInput,
): Promise<DepotManifest> {
  const contents = await readFile(input.manifestPath)
  const manifest = parseManifest(contents, Buffer.from(input.depotKey))
  validateManifest(manifest, input.depotId, input.manifestId)
  return manifest
}

function validateApplicationOptions(
  options: ReconcileApplicationOptions,
): void {
  if (!Number.isInteger(options.appId) || options.appId <= 0)
    throw new Error('appId must be a positive integer')
  if (!options.outputDirectory) throw new Error('outputDirectory is required')
  for (const depot of [...options.installedDepots, ...options.desiredDepots]) {
    if (!Number.isInteger(depot.depotId) || depot.depotId <= 0)
      throw new Error('depotId must be a positive integer')
    if (!Buffer.isBuffer(depot.depotKey) || depot.depotKey.length !== 32)
      throw new Error('depotKey must be a 32-byte Buffer')
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
