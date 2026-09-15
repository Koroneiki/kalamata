import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
import type {
  AcquiredManifest,
  AcquireManifestRequest,
  HubcapUsage,
  ManifestAcquisitionResult,
} from '../../../types/rpc.ts'
import { abortable } from '../../shared/abortable.ts'
import type { SteamSession } from '../../steam/steam-session.ts'
import type { ContentServer } from '../../steam/types.ts'
import { HubcapClient } from '../keys/hubcap-client.ts'
import {
  parseManifestEnvelope,
  validateManifestEnvelope,
} from './manifest-codec.ts'

// Steam CDN manifest URLs require a code obtained from this external compatibility service.
const REQUEST_CODE_URL = 'https://manifest.manifestdex.com'
const REQUEST_CODE_HEADERS = { 'User-Agent': 'ManifestDeX/1.0' }
const MAX_HUBCAP_MANIFEST_BYTES = 256 * 1024 * 1024
const STEAM_HEADERS = {
  Accept: 'text/html,*/*;q=0.9',
  'Accept-Encoding': 'identity',
  'Accept-Charset': 'ISO-8859-1,utf-8,*;q=0.7',
  'User-Agent': 'Valve/Steam HTTP Client 1.0',
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface ZipEntry {
  entryName: string
  isDirectory: boolean
  header?: { size?: number }
}

interface ZipArchive {
  getEntries(): ZipEntry[]
  readFile(entry: ZipEntry): Buffer | null
}

interface ZipArchiveConstructor {
  new (data: Buffer): ZipArchive
}

const require = createRequire(import.meta.url)
const AdmZip: ZipArchiveConstructor = require('adm-zip')

interface HubcapManifestSource {
  archive: Buffer
  usage: HubcapUsage
}

export class ManifestAcquisitionService {
  readonly #inFlight = new Map<string, Promise<ManifestAcquisitionResult>>()
  readonly #hubcapManifestSources = new Map<
    number,
    Promise<HubcapManifestSource>
  >()
  readonly #abortController = new AbortController()
  readonly #hubcap: HubcapClient
  #requestCodeLookup = Promise.resolve()
  #accepting = true

  constructor(
    private readonly session: Pick<SteamSession, 'getClient'>,
    private readonly database: KalamataDatabase,
    private readonly fetcher: Fetcher = fetch,
    private readonly decompress: (
      data: Buffer,
    ) => Promise<Buffer> = decompressManifest,
  ) {
    this.#hubcap = new HubcapClient(fetcher)
  }

  acquire(request: AcquireManifestRequest): Promise<ManifestAcquisitionResult> {
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
  ): Promise<ManifestAcquisitionResult> {
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
        return { manifest: existing }
      } catch {}
    }

    let requestCode: string
    try {
      requestCode = await this.fetchManifestRequestCode(
        request.manifestId,
        signal,
      )
    } catch {
      signal.throwIfAborted()
      return this.acquireFromHubcap(
        request,
        new Error('Manifest request code lookup failed'),
        signal,
      )
    }
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
    return { manifest: await this.ingest(request, contents, signal) }
  }

  private async acquireFromHubcap(
    request: AcquireManifestRequest,
    requestCodeError: Error,
    signal: AbortSignal,
  ): Promise<ManifestAcquisitionResult> {
    const cached = this.#hubcapManifestSources.get(request.appId)
    if (cached) return this.useHubcapSource(request, cached, signal)

    const apiKey = this.database.getHubcapApiKey()
    if (!apiKey) return { manifest: null, hubcap: { status: 'missing-key' } }

    const contentsResult = await this.#hubcap.getManifestContents(
      request.appId,
      apiKey,
      signal,
    )
    const availableSource = this.#hubcapManifestSources.get(request.appId)
    if (availableSource)
      return this.useHubcapSource(request, availableSource, signal)
    if (contentsResult.status === 'invalid-key') {
      return { manifest: null, hubcap: { status: 'invalid-key' } }
    }
    if (contentsResult.status === 'unavailable') {
      return { manifest: null, hubcap: { status: 'stats-unavailable' } }
    }

    const expectedFilename = `${request.depotId}_${request.manifestId}.manifest`
    const available =
      contentsResult.zipExists &&
      contentsResult.manifests.some(
        (manifest) =>
          manifest.depotId === request.depotId &&
          manifest.manifestId === request.manifestId &&
          manifest.filename === expectedFilename,
      )
    if (!available) throw requestCodeError

    const usageResult = await this.#hubcap.getUsage(apiKey, signal)
    const inFlight = this.#hubcapManifestSources.get(request.appId)
    if (inFlight) return this.useHubcapSource(request, inFlight, signal)
    if (usageResult.status !== 'available') {
      return { manifest: null, hubcap: usageResult }
    }

    const { usage } = usageResult
    if (!usage.canMakeRequests || usage.remaining === 0) {
      return {
        manifest: null,
        hubcap: { status: 'quota-exhausted', usage },
      }
    }
    if (usage.remaining <= 10 && !request.approveLowQuotaHubcap) {
      return {
        manifest: null,
        hubcap: { status: 'approval-required', usage },
      }
    }

    const source = this.fetchHubcapManifestSource(request.appId, apiKey, usage)
    this.#hubcapManifestSources.set(request.appId, source)
    source.catch(() => {
      if (this.#hubcapManifestSources.get(request.appId) === source)
        this.#hubcapManifestSources.delete(request.appId)
    })
    return this.useHubcapSource(request, source, signal)
  }

  private async fetchHubcapManifestSource(
    appId: number,
    apiKey: string,
    preflightUsage: HubcapUsage,
  ): Promise<HubcapManifestSource> {
    const archive = await this.#hubcap.getManifestZip(
      appId,
      apiKey,
      this.#abortController.signal,
    )
    const usage = await this.#hubcap.getUsageAfterRequest(
      apiKey,
      preflightUsage,
      this.#abortController.signal,
    )
    return { archive, usage }
  }

  private async useHubcapSource(
    request: AcquireManifestRequest,
    source: Promise<HubcapManifestSource>,
    signal: AbortSignal,
  ): Promise<ManifestAcquisitionResult> {
    const result = await abortable(source, signal)
    const contents = extractManifestFromHubcapZip(
      result.archive,
      request.depotId,
      request.manifestId,
      signal,
    )
    const manifest = await this.ingest(request, contents, signal)
    return { manifest, hubcap: { status: 'fetched', usage: result.usage } }
  }

  private async ingest(
    request: AcquireManifestRequest,
    contents: Buffer,
    signal: AbortSignal,
  ): Promise<AcquiredManifest> {
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

function extractManifestFromHubcapZip(
  data: Buffer,
  depotId: number,
  manifestId: string,
  signal: AbortSignal,
): Buffer {
  signal.throwIfAborted()
  let entries: ZipEntry[]
  let archive: ZipArchive
  try {
    archive = new AdmZip(data)
    entries = archive.getEntries()
  } catch {
    throw new Error('Hubcap manifest response is not a valid ZIP')
  }

  const expectedFilename = `${depotId}_${manifestId}.manifest`
  const matches = entries.filter(
    (entry) => entry.entryName === expectedFilename && !entry.isDirectory,
  )
  if (matches.length !== 1) {
    throw new Error(
      'Hubcap manifest ZIP does not contain the requested manifest',
    )
  }
  const [entry] = matches
  if (
    entry.header?.size !== undefined &&
    entry.header.size > MAX_HUBCAP_MANIFEST_BYTES
  ) {
    throw new Error('Hubcap manifest is too large')
  }

  let contents: Buffer | null
  try {
    contents = archive.readFile(entry)
  } catch {
    throw new Error('Hubcap manifest ZIP could not be read')
  }
  signal.throwIfAborted()
  if (!contents) throw new Error('Hubcap manifest ZIP could not be read')
  if (contents.length > MAX_HUBCAP_MANIFEST_BYTES) {
    throw new Error('Hubcap manifest is too large')
  }
  return contents
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
