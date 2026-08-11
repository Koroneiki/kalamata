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
import { downloadDepotContent } from './legacy/content-downloader.ts'
import { readFileFilter } from './manifests/file-list.ts'
import {
  parseManifest,
  validateManifest,
} from './manifests/manifest-codec.ts'
import { SteamContentClient } from './transfer/steam-content-client.ts'
import type { ChunkClient, ContentServer } from './transfer/chunk-client.ts'
import type { SteamSession } from '../steam/steam-session.ts'
import type {
  DownloadDepotOptions,
  DownloadResult,
} from './manifests/types.ts'

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

  async download(options: DownloadDepotOptions): Promise<DownloadResult> {
    validateOptions(options)
    throwIfAborted(options.signal)
    const [manifestContents, fileFilter] = await Promise.all([
      readFile(options.manifestPath),
      readFileFilter(options.fileListPath),
    ])
    throwIfAborted(options.signal)
    const key = Buffer.from(options.depotKey)
    const manifest = parseManifest(manifestContents, key)
    validateManifest(manifest, options.depotId)
    throwIfAborted(options.signal)

    const controller = new AbortController()
    const onAbort = () =>
      controller.abort(
        options.signal?.reason ??
          new DOMException('Download aborted', 'AbortError'),
      )
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const removeDisconnectListener = this.session.onDisconnect((error) =>
      controller.abort(error),
    )
    try {
      const client = new SteamContentClient(await this.session.getClient(), key)
      try {
        throwIfAborted(controller.signal)
        return await downloadDepotContent(
          client,
          options,
          {
            manifest,
            manifestContents,
            depotKey: key,
            fileFilter,
          },
          controller.signal,
        )
      } finally {
        client.dispose()
      }
    } finally {
      removeDisconnectListener()
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async reconcileApplication(
    options: ReconcileApplicationOptions,
  ): Promise<ApplicationTransactionResult> {
    validateApplicationOptions(options)
    let result: ApplicationTransactionResult
    {
      throwIfAborted(options.signal)
      const manifestCache = new Map<
        string,
        Promise<InstalledApplicationDepot>
      >()
      const installedDepots = await Promise.all(
        options.installedDepots.map((depot) =>
          loadApplicationDepot(depot, manifestCache),
        ),
      )
      const desiredInputs = await Promise.all(
        options.desiredDepots.map((depot) =>
          loadApplicationDepot(depot, manifestCache),
        ),
      )
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
    this.#client ??= abortable(
      this.session.getClient(),
      this.operationSignal,
    )
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

async function loadApplicationDepot(
  input: ApplicationDepotInput,
  cache: Map<string, Promise<InstalledApplicationDepot>>,
): Promise<InstalledApplicationDepot> {
  const key = `${input.depotId}:${input.manifestId}`
  let loaded = cache.get(key)
  if (!loaded) {
    loaded = (async () => {
      const contents = await readFile(input.manifestPath)
      const manifest = parseManifest(contents, Buffer.from(input.depotKey))
      validateManifest(manifest, input.depotId)
      if (manifest.gid_manifest !== input.manifestId)
        throw new Error(`Depot ${input.depotId} manifest identity changed`)
      return {
        depotId: input.depotId,
        ownerAppId: input.ownerAppId,
        manifest,
      }
    })()
    cache.set(key, loaded)
  }
  return loaded
}

function validateOptions(options: DownloadDepotOptions): void {
  for (const [name, value] of [
    ['appId', options.appId],
    ['depotId', options.depotId],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
      throw new Error(`${name} must be a positive 32-bit integer`)
    }
  }
  if (!options.manifestPath || !options.outputDirectory) {
    throw new Error('manifestPath and outputDirectory are required')
  }
  if (!Buffer.isBuffer(options.depotKey) || options.depotKey.length !== 32) {
    throw new Error('depotKey must be a 32-byte Buffer')
  }
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
