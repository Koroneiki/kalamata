import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KalamataDatabase } from '../../../db/database.ts'
import { ingestManifestFile } from '../../../db/manifest-files.ts'
import { validateId, validateManifestId } from '../../../db/validation.ts'
import type { SteamSession } from '../../steam/steam-session.ts'
import type { ContentServer } from '../../steam/types.ts'
import {
  parseManifestEnvelope,
  validateManifestEnvelope,
} from './manifest-codec.ts'

const REQUEST_CODE_URL = 'http://gmrc.wudrm.com/manifest'
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
  constructor(
    private readonly session: Pick<SteamSession, 'getClient'>,
    private readonly database: KalamataDatabase,
    private readonly fetcher: Fetcher = fetch,
    private readonly decompress: (data: Buffer) => Promise<Buffer> =
      decompressManifest,
  ) {}

  async acquire(request: AcquireManifestRequest): Promise<AcquiredManifest> {
    validateId(request.appId, 'appId')
    validateId(request.depotId, 'depotId')
    validateManifestId(request.manifestId)
    if (this.database.hasManifest(request.depotId, request.manifestId)) {
      throw new Error('Manifest is already managed')
    }

    const requestCode = await fetchManifestRequestCode(
      request.manifestId,
      this.fetcher,
    )
    const client = await this.session.getClient()
    const { servers } = await client.getContentServers(request.appId)
    const server = selectContentServer(servers)
    const vhost = server.vhost || server.Host
    const token =
      server.usetokenauth === 1
        ? (await client.getCDNAuthToken(request.appId, request.depotId, vhost))
            .token
        : ''
    const protocol = server.https_support === 'mandatory' ? 'https' : 'http'
    const response = await this.fetcher(
      `${protocol}://${server.Host}/depot/${request.depotId}/manifest/${request.manifestId}/5/${requestCode}${token}`,
      { headers: { ...STEAM_HEADERS, Host: vhost } },
    )
    if (!response.ok) {
      throw new Error(`Steam manifest download failed (${response.status})`)
    }

    const contents = await this.decompress(
      Buffer.from(await response.arrayBuffer()),
    )
    validateManifestEnvelope(
      parseManifestEnvelope(contents),
      request.depotId,
      request.manifestId,
    )
    const sourceName = `.manifest-${randomUUID()}.tmp`
    const incoming = join(this.database.dataRoot, 'manifest-files', sourceName)
    try {
      await writeFile(incoming, contents)
      return await ingestManifestFile(this.database, incoming)
    } finally {
      await rm(incoming, { force: true })
    }
  }
}

async function decompressManifest(data: Buffer): Promise<Buffer> {
  // The lzma fallback loaded by this module overwrites onmessage under Bun.
  const previousOnMessage = globalThis.onmessage
  const { default: compression } = await import(
    'steam-user/components/cdn_compression.js'
  ).finally(() => {
    globalThis.onmessage = previousOnMessage
  })
  return compression.unzip(data)
}

async function fetchManifestRequestCode(
  manifestId: string,
  fetcher: Fetcher,
): Promise<string> {
  const response = await fetcher(`${REQUEST_CODE_URL}/${manifestId}`, {
    headers: { ...STEAM_HEADERS, Referer: 'http://gmrc.wudrm.com' },
  })
  if (!response.ok) {
    throw new Error(`Manifest request code lookup failed (${response.status})`)
  }
  const code = (await response.text()).trim()
  if (!/^\d+$/u.test(code)) {
    throw new Error('Manifest request code lookup returned an invalid response')
  }
  return code
}

function selectContentServer(servers: ContentServer[]): ContentServer {
  const server = [...servers]
    .filter(({ Host }) => typeof Host === 'string' && Host.length > 0)
    .sort(
      (left, right) =>
        (left.weightedload ?? Number.POSITIVE_INFINITY) -
        (right.weightedload ?? Number.POSITIVE_INFINITY),
    )[0]
  if (!server) throw new Error('No Steam content servers available')
  return server
}
