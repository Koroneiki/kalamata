import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadDepotContent } from '../src/backend/depot/content-downloader.ts'
import { DepotConfigStore } from '../src/backend/depot/depot-config-store.ts'
import type { ChunkClient } from '../src/backend/depot/download-core.ts'
import type {
  DepotManifest,
  DownloadDepotOptions,
} from '../src/backend/depot/types.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

test('caches the local manifest and records completion after a successful run', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-content-'))
  const contents = Buffer.from('local manifest bytes')

  await downloadDepotContent(fakeClient(), options(directory), {
    manifest: emptyManifest(),
    manifestContents: contents,
    depotKey: Buffer.alloc(32),
    fileFilter: () => true,
  })

  expect(
    await readFile(join(directory, '.DepotDownloader/20_123.manifest')),
  ).toEqual(contents)
  expect(
    JSON.parse(
      await readFile(
        join(directory, '.DepotDownloader/depot.config.json'),
        'utf8',
      ),
    ),
  ).toEqual({
    version: 1,
    installedManifestIds: { '20': '123' },
  })
})

test('leaves an incomplete marker when downloading fails', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-content-'))
  const manifest = emptyManifest()
  manifest.files = [
    {
      filename: 'file.bin',
      size: '3',
      flags: 0,
      sha_content: '01'.repeat(20),
      chunks: [
        {
          sha: '02'.repeat(20),
          crc: 1,
          offset: '0',
          cb_original: 3,
          cb_compressed: 3,
        },
      ],
    },
  ]
  const client = fakeClient()
  client.downloadChunk = mock(async () => {
    throw new Error('offline')
  })

  await expect(
    downloadDepotContent(client, options(directory), {
      manifest,
      manifestContents: Buffer.from('manifest'),
      depotKey: Buffer.alloc(32),
      fileFilter: () => true,
    }),
  ).rejects.toThrow('Failed to download chunk')

  expect(
    JSON.parse(
      await readFile(
        join(directory, '.DepotDownloader/depot.config.json'),
        'utf8',
      ),
    ),
  ).toEqual({
    version: 1,
    installedManifestIds: { '20': null },
  })
  expect(
    await readFile(join(directory, '.DepotDownloader/20_123.manifest')),
  ).toEqual(Buffer.from('manifest'))
})

test('ignores an invalid cached previous manifest', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-content-'))
  const store = await DepotConfigStore.load(directory)
  await store.saveManifest(20, '999', Buffer.from('not a manifest'))
  await store.setInstalledManifestId(20, '999')

  await downloadDepotContent(fakeClient(), options(directory), {
    manifest: emptyManifest(),
    manifestContents: Buffer.from('current manifest'),
    depotKey: Buffer.alloc(32),
    fileFilter: () => true,
  })

  expect(
    JSON.parse(
      await readFile(
        join(directory, '.DepotDownloader/depot.config.json'),
        'utf8',
      ),
    ),
  ).toEqual({ version: 1, installedManifestIds: { '20': '123' } })
})

test('does not record a filtered download as a complete manifest', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-content-'))
  const filteredOptions = {
    ...options(directory),
    fileListPath: 'selection.txt',
  }

  await downloadDepotContent(fakeClient(), filteredOptions, {
    manifest: emptyManifest(),
    manifestContents: Buffer.from('current manifest'),
    depotKey: Buffer.alloc(32),
    fileFilter: () => true,
  })

  const config = JSON.parse(
    await readFile(
      join(directory, '.DepotDownloader/depot.config.json'),
      'utf8',
    ),
  )
  expect(config.installedManifestIds['20']).toBeNull()
})

function options(outputDirectory: string): DownloadDepotOptions {
  return {
    appId: 10,
    depotId: 20,
    manifestPath: 'unused',
    depotKey: Buffer.alloc(32),
    outputDirectory,
  }
}

function emptyManifest(): DepotManifest {
  return {
    depot_id: 20,
    gid_manifest: '123',
    filenames_encrypted: false,
    cb_disk_original: '0',
    cb_disk_compressed: '0',
    files: [],
  }
}

function fakeClient(): ChunkClient {
  return {
    getContentServers: async () => ({
      servers: [{ Host: 'cdn.example.test' }],
    }),
    downloadChunk: async () => ({ chunk: Buffer.alloc(0) }),
  }
}
