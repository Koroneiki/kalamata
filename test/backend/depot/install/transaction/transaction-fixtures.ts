import { mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { runApplicationTransaction } from '../../../../../src/backend/depot/install/transaction/transaction.ts'
import type {
  DesiredApplicationDepot,
  InstalledApplicationDepot,
} from '../../../../../src/backend/depot/install/transaction/types.ts'
import type {
  ChunkClient,
  ContentServer,
} from '../../../../../src/backend/depot/transfer/chunk-client.ts'
import type {
  DepotManifest,
  ManifestChunk,
  ManifestFile,
} from '../../../../../src/backend/depot/manifests/types.ts'

export function run(
  outputDirectory: string,
  installedDepots: InstalledApplicationDepot[],
  desiredDepots: DesiredApplicationDepot[],
  overrides: Partial<Parameters<typeof runApplicationTransaction>[0]> = {},
) {
  return runApplicationTransaction({
    appId: 100,
    kind: 'reconcile',
    outputDirectory,
    installedDepots,
    desiredDepots,
    reconcile: async () => {},
    ...overrides,
  })
}

export function depot(
  depotId: number,
  manifestId: string,
  files: Record<string, string>,
  client = fakeClient(files),
): DesiredApplicationDepot {
  return {
    depotId,
    appId: 100,
    ownerAppId: 100,
    manifest: manifest(depotId, manifestId, files),
    client,
  }
}

function manifest(
  depotId: number,
  manifestId: string,
  files: Record<string, string>,
): DepotManifest {
  const entries = Object.entries(files).map(([filename, value]) =>
    manifestFile(filename, value),
  )
  const size = entries.reduce((sum, file) => sum + Number(file.size), 0)
  return {
    depot_id: depotId,
    gid_manifest: manifestId,
    filenames_encrypted: false,
    cb_disk_original: String(size),
    cb_disk_compressed: String(size),
    files: entries,
  }
}

function manifestFile(filename: string, value: string): ManifestFile {
  const data = Buffer.from(value)
  const item = chunk(createHash('sha1').update(data).digest('hex'), 0, data)
  return {
    filename,
    size: String(data.length),
    flags: 0,
    sha_content: createHash('sha1').update(data).digest('hex'),
    chunks: data.length === 0 ? [] : [item],
  }
}

function chunk(sha: string, offset: number, value: Buffer): ManifestChunk {
  return {
    sha,
    offset: String(offset),
    cb_original: value.length,
    cb_compressed: value.length,
    crc: adler(value),
  }
}

export function fakeClient(files: Record<string, string>): ChunkClient {
  const chunks = new Map(
    Object.values(files).map((value) => {
      const data = Buffer.from(value)
      return [createHash('sha1').update(data).digest('hex'), data]
    }),
  )
  const server: ContentServer = { Host: 'cdn.test' }
  return {
    getContentServers: async () => ({ servers: [server] }),
    downloadChunk: mock(async (_appId, _depotId, sha) => {
      const data = chunks.get(sha)
      if (!data) throw new Error(`missing ${sha}`)
      return { chunk: data }
    }),
  }
}

export function enospcClient(): ChunkClient {
  const server: ContentServer = { Host: 'cdn.test' }
  return {
    getContentServers: async () => ({ servers: [server] }),
    downloadChunk: mock(async () => {
      const error = new Error('disk full') as NodeJS.ErrnoException
      error.code = 'ENOSPC'
      throw error
    }),
  }
}

function adler(value: Buffer): number {
  let a = 0
  let b = 0
  for (const byte of value) {
    a = (a + byte) % 65_521
    b = (b + a) % 65_521
  }
  return (a | (b << 16)) >>> 0
}
