import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { z } from 'zod'
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
import { GITHUB_REPOSITORIES, githubAppFile } from '../keys/github-sources.ts'
import { HubcapArchive } from '../keys/hubcap-archive.ts'
import type { JobContext } from '../../downloads/background-download-coordinator.ts'
import { writeHttpTransfer } from '../../downloads/http-transfer.ts'
import {
  parseManifestEnvelope,
  validateManifestEnvelope,
} from './manifest-codec.ts'

// Steam CDN manifest URLs require a code obtained from this external compatibility service.
const REQUEST_CODE_SOURCES = [
  {
    name: '20770407',
    url: (gid: string, depotId: number) =>
      `https://20770407.xyz/manifest/${depotId}/${gid}`,
  },
  {
    name: 'ManifestDeX',
    url: (gid: string) => `https://manifest.manifestdex.com/${gid}`,
    headers: { 'User-Agent': 'ManifestDeX/1.0' },
  },
  {
    name: 'wudrm',
    url: (gid: string) => `http://gmrc.wudrm.com/manifest/${gid}`,
  },
  {
    name: 'steam.run',
    url: (gid: string) => `https://manifest.steam.run/api/manifest/${gid}`,
    json: true,
  },
] as const
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

class InvalidManifestError extends Error {}

export class ManifestAcquisitionService {
  readonly #inFlight = new Map<string, Promise<ManifestAcquisitionResult>>()
  readonly #abortController = new AbortController()
  readonly #hubcap: HubcapClient
  readonly #archive: HubcapArchive
  #requestCodeLookup = Promise.resolve()
  #accepting = true

  constructor(
    private readonly session: Pick<SteamSession, 'getClient'>,
    private readonly database: KalamataDatabase,
    private readonly fetcher: Fetcher = fetch,
    private readonly decompress: (
      data: Buffer,
    ) => Promise<Buffer> = decompressManifest,
    archive?: HubcapArchive,
  ) {
    this.#hubcap = new HubcapClient(fetcher)
    this.#archive = archive ?? new HubcapArchive(fetcher)
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

  acquireWithContext(
    request: AcquireManifestRequest,
    context: JobContext,
  ): Promise<ManifestAcquisitionResult> {
    if (!this.#accepting)
      throw new Error('Manifest acquisition is shutting down')
    return this.acquireIndependent(request, context)
  }

  async shutdown(): Promise<void> {
    this.#accepting = false
    this.#abortController.abort(new Error('Manifest acquisition was cancelled'))
    await Promise.allSettled(this.#inFlight.values())
    await this.#archive.shutdown()
  }

  private async acquireIndependent(
    request: AcquireManifestRequest,
    context?: JobContext,
  ): Promise<ManifestAcquisitionResult> {
    const signal = context?.signal ?? this.#abortController.signal
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

    const steam = await this.acquireFromSteamCodes(request, signal, context)
    if (steam.manifest) return { manifest: steam.manifest }
    const github = await this.acquireFromGitHub(request, signal, context)
    if (github) return { manifest: github }
    const result = await this.acquireFromHubcap(
      request,
      steam.invalidManifest ?? steam.failure,
      signal,
      context,
    )
    if (steam.invalidManifest && result.hubcap?.status === 'missing-key')
      throw steam.invalidManifest
    return result
  }

  private async acquireFromSteamCodes(
    request: AcquireManifestRequest,
    signal: AbortSignal,
    context?: JobContext,
  ): Promise<{
    manifest: AcquiredManifest | null
    failure: Error
    invalidManifest?: InvalidManifestError
  }> {
    let failure = new Error('Manifest request code lookup failed')
    let invalidManifest: InvalidManifestError | undefined
    for (const source of REQUEST_CODE_SOURCES) {
      try {
        context?.setSource(source.name)
        const code = await this.fetchManifestRequestCode(
          source,
          request,
          signal,
        )
        return {
          manifest: await this.downloadFromSteam(
            request,
            code,
            signal,
            context,
          ),
          failure,
        }
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof InvalidManifestError) invalidManifest ??= error
        failure = error instanceof Error ? error : failure
      }
    }
    return { manifest: null, failure, invalidManifest }
  }

  private async acquireFromGitHub(
    request: AcquireManifestRequest,
    signal: AbortSignal,
    context?: JobContext,
  ): Promise<AcquiredManifest | null> {
    const branches = [
      ...new Set(
        [request.appId, request.parentAppId].filter(
          (id): id is number => id !== undefined,
        ),
      ),
    ]
    const filename = `${request.depotId}_${request.manifestId}.manifest`
    for (const repo of GITHUB_REPOSITORIES) {
      for (const appId of branches) {
        try {
          context?.setSource(`GitHub: ${repo}`)
          const response = await this.fetcher(
            githubAppFile(repo, appId, filename),
            { signal },
          )
          if (!response.ok) continue
          const body = Buffer.from(
            await abortable(response.arrayBuffer(), signal),
          )
          return await this.ingest(request, body, signal, context)
        } catch {
          signal.throwIfAborted()
        }
      }
    }
    return null
  }

  private async downloadFromSteam(
    request: AcquireManifestRequest,
    requestCode: string,
    signal: AbortSignal,
    context?: JobContext,
  ): Promise<AcquiredManifest> {
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

    context?.setSource('Steam CDN')
    let body: Buffer
    if (context) {
      try {
        body = await writeHttpTransfer({
          response,
          workspace: context.workspace,
          filename: 'manifest.download',
          signal,
          progress: (bytes, total) =>
            context.progress('downloading', bytes, total),
        }).then(({ path }) => readFile(path))
      } finally {
        // The next request-code source reuses this workspace after a failed attempt.
        await rm(join(context.workspace, 'manifest.download'), { force: true })
      }
    } else {
      body = Buffer.from(await abortable(response.arrayBuffer(), signal))
    }
    const contents = await abortable(this.decompress(body), signal)
    context?.progress('verifying')
    return this.ingest(request, contents, signal, context)
  }

  private async acquireFromHubcap(
    request: AcquireManifestRequest,
    requestCodeError: Error,
    signal: AbortSignal,
    context?: JobContext,
  ): Promise<ManifestAcquisitionResult> {
    context?.setSource('Hubcap API')
    context?.progress('downloading')
    const apiKey = this.database.getHubcapApiKey()
    if (!apiKey) return { manifest: null, hubcap: { status: 'missing-key' } }
    if (this.#archive.has(request.appId, apiKey))
      return this.useHubcapSource(request, apiKey, undefined, signal, context)

    const contentsResult = await this.#hubcap.getManifestContents(
      request.appId,
      apiKey,
      signal,
    )
    if (this.#archive.has(request.appId, apiKey))
      return this.useHubcapSource(request, apiKey, undefined, signal, context)
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
    if (this.#archive.has(request.appId, apiKey))
      return this.useHubcapSource(request, apiKey, undefined, signal, context)
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

    return this.useHubcapSource(request, apiKey, usage, signal, context)
  }

  private async useHubcapSource(
    request: AcquireManifestRequest,
    apiKey: string,
    usage: HubcapUsage | undefined,
    signal: AbortSignal,
    context?: JobContext,
  ): Promise<ManifestAcquisitionResult> {
    const result = await this.#archive.get(request.appId, apiKey, usage, signal)
    const contents = extractManifestFromHubcapZip(
      result.archive,
      request.depotId,
      request.manifestId,
      signal,
    )
    context?.progress('verifying')
    const manifest = await this.ingest(request, contents, signal, context)
    return { manifest, hubcap: { status: 'fetched', usage: result.usage } }
  }

  private async ingest(
    request: AcquireManifestRequest,
    contents: Buffer,
    signal: AbortSignal,
    context?: JobContext,
  ): Promise<AcquiredManifest> {
    try {
      validateManifestEnvelope(
        parseManifestEnvelope(contents),
        request.depotId,
        request.manifestId,
      )
    } catch (error) {
      throw new InvalidManifestError(
        error instanceof Error ? error.message : 'Invalid manifest',
        { cause: error },
      )
    }
    const sourceName = `.manifest-${randomUUID()}.tmp`
    const incoming = join(
      context?.workspace ?? join(this.database.dataRoot, 'manifest-files'),
      sourceName,
    )
    try {
      await writeFile(incoming, contents, { signal })
      context?.beginPublish()
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
    source: (typeof REQUEST_CODE_SOURCES)[number],
    request: AcquireManifestRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const lookup = this.#requestCodeLookup.then(() =>
      fetchManifestRequestCode(source, request, this.fetcher, signal),
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
  source: (typeof REQUEST_CODE_SOURCES)[number],
  request: AcquireManifestRequest,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<string> {
  const response = await abortable(
    fetcher(source.url(request.manifestId, request.depotId), {
      headers: 'headers' in source ? source.headers : undefined,
      signal,
    }),
    signal,
  )
  if (!response.ok) {
    throw new Error(`Manifest request code lookup failed (${response.status})`)
  }
  const body = (await abortable(response.text(), signal)).trim()
  const code =
    'json' in source
      ? z.object({ content: z.string() }).parse(JSON.parse(body)).content
      : body
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
