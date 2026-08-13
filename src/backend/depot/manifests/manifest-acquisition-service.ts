import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KalamataDatabase } from '../../../db/database.ts'
import {
  ingestManifestFile,
  validateManagedManifest,
} from '../../../db/manifest-files.ts'
import {
  depotKeyFromHex,
  validateId,
  validateManifestId,
} from '../../../db/validation.ts'
import { abortable } from '../../shared/abortable.ts'
import type { SteamSession } from '../../steam/steam-session.ts'
import type { ContentServer } from '../../steam/types.ts'
import {
  parseManifestEnvelope,
  validateManifestEnvelope,
} from './manifest-codec.ts'

// Steam CDN manifest URLs require a code obtained from this external compatibility service.
const REQUEST_CODE_URL = 'https://manifest.opensteamtool.com'
const REQUEST_CODE_HEADERS = { 'User-Agent': 'OpenSteamTool/1.0' }
const STEAM_HEADERS = {
  Accept: 'text/html,*/*;q=0.9',
  'Accept-Encoding': 'identity',
  'Accept-Charset': 'ISO-8859-1,utf-8,*;q=0.7',
  'User-Agent': 'Valve/Steam HTTP Client 1.0',
}

export interface AcquireManifestRequest {
  appId: number
  depotId: number
  manifestId: string
}

export interface AcquiredManifest {
  depotId: number
  manifestId: string
  relativePath: string
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class ManifestAcquisitionService {
  readonly #inFlight = new Map<string, Promise<AcquiredManifest>>()
  readonly #abortController = new AbortController()
  #requestCodeLookup = Promise.resolve()
  #accepting = true

  constructor(
    private readonly session: Pick<SteamSession, 'getClient'>,
    private readonly database: KalamataDatabase,
    private readonly fetcher: Fetcher = fetch,
    private readonly decompress: (
      data: Buffer,
    ) => Promise<Buffer> = decompressManifest,
  ) {}

  acquire(request: AcquireManifestRequest): Promise<AcquiredManifest> {
    if (!this.#accepting) {
      return Promise.reject(new Error('Manifest acquisition is shutting down'))
    }
    // Manifest identity is depot-scoped; appId only supplies Steam request context.
    const key = `${request.depotId}:${request.manifestId}`
    const current = this.#inFlight.get(key)
    if (current) return current

    const acquisition = this.acquireIndependent(request).finally(() => {
      if (this.#inFlight.get(key) === acquisition) this.#inFlight.delete(key)
    })
    this.#inFlight.set(key, acquisition)
    return acquisition
  }

  async shutdown(): Promise<void> {
    this.#accepting = false
    this.#abortController.abort(new Error('Manifest acquisition was cancelled'))
    await Promise.allSettled(this.#inFlight.values())
  }

  private async acquireIndependent(
    request: AcquireManifestRequest,
  ): Promise<AcquiredManifest> {
    const signal = this.#abortController.signal
    signal.throwIfAborted()
    validateId(request.appId, 'appId')
    validateId(request.depotId, 'depotId')
    validateManifestId(request.manifestId)
    const existing = this.database
      .getManifestRows(request.depotId)
      .find(({ manifestId }) => manifestId === request.manifestId)
    if (existing) {
      // Use the same validity boundary as app details: keep ready files, but let acquisition repair invalid ones.
      const keyText = this.database.getDepotKey(request.depotId)
      let key: Buffer | undefined
      if (keyText !== null) {
        try {
          key = depotKeyFromHex(keyText)
        } catch {
          key = undefined
        }
      }
      try {
        await validateManagedManifest(
          this.database.dataRoot,
          request.depotId,
          request.manifestId,
          existing.relativePath,
          key,
        )
        return existing
      } catch {}
    }

    const requestCode = await this.fetchManifestRequestCode(
      request.manifestId,
      signal,
    )
    const client = await abortable(this.session.getClient(), signal)
    const { servers } = await abortable(
      client.getContentServers(request.appId),
      signal,
    )
    const server = selectContentServer(servers)
    const vhost = server.vhost || server.Host
    const token =
      server.usetokenauth === 1
        ? (
            await abortable(
              client.getCDNAuthToken(request.appId, request.depotId, vhost),
              signal,
            )
          ).token
        : ''
    const protocol = server.https_support === 'mandatory' ? 'https' : 'http'
    const response = await abortable(
      this.fetcher(
        `${protocol}://${server.Host}/depot/${request.depotId}/manifest/${request.manifestId}/5/${requestCode}${token}`,
        { headers: { ...STEAM_HEADERS, Host: vhost }, signal },
      ),
      signal,
    )
    if (!response.ok) {
      throw new Error(`Steam manifest download failed (${response.status})`)
    }

    const contents = await abortable(
      abortable(response.arrayBuffer(), signal).then((body) =>
        this.decompress(Buffer.from(body)),
      ),
      signal,
    )
    validateManifestEnvelope(
      parseManifestEnvelope(contents),
      request.depotId,
      request.manifestId,
    )
    const sourceName = `.manifest-${randomUUID()}.tmp`
    const incoming = join(this.database.dataRoot, 'manifest-files', sourceName)
    try {
      await writeFile(incoming, contents, { signal })
      return await ingestManifestFile(
        this.database,
        incoming,
        Date.now(),
        signal,
      )
    } finally {
      await rm(incoming, { force: true })
    }
  }

  private fetchManifestRequestCode(
    manifestId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const lookup = this.#requestCodeLookup.then(() =>
      fetchManifestRequestCode(manifestId, this.fetcher, signal),
    )
    this.#requestCodeLookup = lookup.then(
      () => undefined,
      () => undefined,
    )
    return abortable(lookup, signal)
  }
}

async function decompressManifest(data: Buffer): Promise<Buffer> {
  // The lzma fallback loaded by this module overwrites onmessage under Bun.
  const previousOnMessage = globalThis.onmessage
  const { default: compression } =
    await import('steam-user/components/cdn_compression.js').finally(() => {
      globalThis.onmessage = previousOnMessage
    })
  return compression.unzip(data)
}

async function fetchManifestRequestCode(
  manifestId: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<string> {
  const response = await abortable(
    fetcher(`${REQUEST_CODE_URL}/${manifestId}`, {
      headers: REQUEST_CODE_HEADERS,
      signal,
    }),
    signal,
  )
  if (!response.ok) {
    throw new Error(`Manifest request code lookup failed (${response.status})`)
  }
  const code = (await abortable(response.text(), signal)).trim()
  if (!/^\d+$/u.test(code)) {
    throw new Error('Manifest request code lookup returned an invalid response')
  }
  return code
}

function selectContentServer(servers: ContentServer[]): ContentServer {
  const server = [...servers]
    .filter(({ Host }) => Host.length > 0)
    .sort(
      (left, right) =>
        (left.weightedload ?? Number.POSITIVE_INFINITY) -
        (right.weightedload ?? Number.POSITIVE_INFINITY),
    )[0]
  if (!server) throw new Error('No Steam content servers available')
  return server
}
