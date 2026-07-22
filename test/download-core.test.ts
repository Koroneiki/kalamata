import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  downloadManifest,
  type ChunkClient,
  type ContentServer,
} from '../src/backend/download-core.ts'
import type {
  DepotManifest,
  ManifestChunk,
  ManifestFile,
} from '../src/backend/types.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('downloadManifest', () => {
  test('preallocates and downloads chunks at their offsets', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    const client = fakeClient({ first: 'abc', second: 'xyz' })
    const file = manifestFile('nested/file.bin', [
      chunk('first', 0, 'abc'),
      chunk('second', 3, 'xyz'),
    ])

    const result = await downloadManifest(
      client,
      manifest(file),
      options(directory, false),
    )

    expect(await readFile(join(directory, 'nested/file.bin'), 'utf8')).toBe(
      'abcxyz',
    )
    expect(result).toEqual({
      manifestId: '123',
      downloadedBytes: 6,
      reusedBytes: 0,
    })
  })

  test('trusts an existing file recorded by the same manifest when verifyAll is disabled', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await writeFile(join(directory, 'file.bin'), 'wrong!')
    const client = fakeClient({ wanted: 'right!' })
    const file = manifestFile('file.bin', [chunk('wanted', 0, 'right!')])

    const result = await downloadManifest(client, manifest(file), {
      ...options(directory, false),
      previousManifest: manifest(file),
    })

    expect(await readFile(join(directory, 'file.bin'), 'utf8')).toBe('wrong!')
    expect(result.reusedBytes).toBe(6)
    expect(client.downloadChunk).not.toHaveBeenCalled()
  })

  test('validates unknown existing files even when verifyAll is disabled', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await writeFile(join(directory, 'file.bin'), 'wrong!')
    const client = fakeClient({ wanted: 'right!' })
    const file = manifestFile('file.bin', [chunk('wanted', 0, 'right!')])

    await downloadManifest(client, manifest(file), options(directory, false))

    expect(await readFile(join(directory, 'file.bin'), 'utf8')).toBe('right!')
    expect(client.downloadChunk).toHaveBeenCalledTimes(1)
  })

  test('reuses valid chunks and replaces corrupt chunks when verifyAll is enabled', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await writeFile(join(directory, 'file.bin'), 'abcBAD')
    const client = fakeClient({ second: 'xyz' })
    const file = manifestFile('file.bin', [
      chunk('first', 0, 'abc'),
      chunk('second', 3, 'xyz'),
    ])

    const result = await downloadManifest(
      client,
      manifest(file),
      options(directory, true),
    )

    expect(await readFile(join(directory, 'file.bin'), 'utf8')).toBe('abcxyz')
    expect(result.downloadedBytes).toBe(3)
    expect(result.reusedBytes).toBe(3)
    expect(client.downloadChunk).toHaveBeenCalledTimes(1)
  })

  test('moves valid old chunks and downloads only new chunks for a changed file', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await writeFile(join(directory, 'file.bin'), 'abcxyz')
    const oldFile = manifestFile('file.bin', [
      chunk('first', 0, 'abc'),
      chunk('second', 3, 'xyz'),
    ])
    oldFile.sha_content = 'old'
    const newFile = manifestFile('file.bin', [
      chunk('second', 0, 'xyz'),
      chunk('first', 3, 'abc'),
      chunk('third', 6, 'NEW'),
    ])
    newFile.sha_content = 'new'
    const client = fakeClient({ third: 'NEW' })

    const result = await downloadManifest(client, manifest(newFile), {
      ...options(directory, false),
      previousManifest: manifest(oldFile),
    })

    expect(await readFile(join(directory, 'file.bin'), 'utf8')).toBe(
      'xyzabcNEW',
    )
    expect(result).toEqual({
      manifestId: '123',
      downloadedBytes: 3,
      reusedBytes: 6,
    })
    expect(client.downloadChunk).toHaveBeenCalledTimes(1)
  })

  test('deletes obsolete manifest files but leaves unrelated files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await writeFile(join(directory, 'obsolete.bin'), 'old')
    await writeFile(join(directory, 'unrelated.bin'), 'keep')
    const oldFile = manifestFile('obsolete.bin', [chunk('old', 0, 'old')])
    const current = manifest(manifestFile('kept.bin', []))

    await downloadManifest(fakeClient({}), current, {
      ...options(directory, false),
      previousManifest: manifest(oldFile),
    })

    expect(await Bun.file(join(directory, 'obsolete.bin')).exists()).toBe(false)
    expect(await readFile(join(directory, 'unrelated.bin'), 'utf8')).toBe(
      'keep',
    )
  })

  test('does not delete a current file when manifest separators change', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await mkdir(join(directory, 'folder'))
    await writeFile(join(directory, 'folder/file.bin'), 'abc')
    const currentFile = manifestFile('folder/file.bin', [
      chunk('first', 0, 'abc'),
    ])
    const previousFile = { ...currentFile, filename: 'folder\\file.bin' }
    const client = fakeClient({})

    await downloadManifest(client, manifest(currentFile), {
      ...options(directory, false),
      previousManifest: manifest(previousFile),
    })

    expect(await readFile(join(directory, 'folder/file.bin'), 'utf8')).toBe(
      'abc',
    )
    expect(client.downloadChunk).not.toHaveBeenCalled()
  })

  test('limits downloads and cleanup to files selected by the filter', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await writeFile(join(directory, 'excluded-old.bin'), 'old')
    const included = manifestFile('included.bin', [chunk('included', 0, 'yes')])
    const excluded = manifestFile('excluded.bin', [chunk('excluded', 0, 'no')])
    const previous = manifest(
      manifestFile('excluded-old.bin', [chunk('old', 0, 'old')]),
    )

    await downloadManifest(
      fakeClient({ included: 'yes' }),
      manifestFiles([included, excluded]),
      {
        ...options(directory, false),
        previousManifest: previous,
        fileFilter: (filename) => filename === 'included.bin',
      },
    )

    expect(await readFile(join(directory, 'included.bin'), 'utf8')).toBe('yes')
    expect(await Bun.file(join(directory, 'excluded.bin')).exists()).toBe(false)
    expect(await readFile(join(directory, 'excluded-old.bin'), 'utf8')).toBe(
      'old',
    )
  })

  test('cancels an active sibling download after a fatal worker failure', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    const server: ContentServer = { Host: 'cdn.example.test' }
    let siblingAborted = false
    const client: ChunkClient = {
      getContentServers: async () => ({ servers: [server] }),
      downloadChunk: async (_appId, _depotId, sha, _server, signal) => {
        if (sha === 'bad') throw new Error('offline')
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            siblingAborted = true
            reject(signal?.reason)
          }
          if (signal?.aborted) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
        })
      },
    }
    const bad = manifestFile('bad.bin', [chunk('bad', 0, 'bad')])
    const hanging = manifestFile('hanging.bin', [chunk('hanging', 0, 'wait')])

    await expect(
      downloadManifest(
        client,
        manifestFiles([bad, hanging]),
        options(directory, false),
      ),
    ).rejects.toThrow('Failed to download chunk bad')
    expect(siblingAborted).toBe(true)
  })

  test('downloads one copy of a chunk referenced by multiple files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    const client = fakeClient({ shared: 'same' })
    const shared = chunk('shared', 0, 'same')

    const result = await downloadManifest(
      client,
      manifestFiles([
        manifestFile('first.bin', [shared]),
        manifestFile('second.bin', [shared]),
      ]),
      options(directory, false),
    )

    expect(client.downloadChunk).toHaveBeenCalledTimes(1)
    expect(result.downloadedBytes).toBe(8)
    expect(await readFile(join(directory, 'first.bin'), 'utf8')).toBe('same')
    expect(await readFile(join(directory, 'second.bin'), 'utf8')).toBe('same')
  })

  test('does not trust an unchanged file with the wrong size', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await writeFile(join(directory, 'file.bin'), 'short')
    const client = fakeClient({ wanted: 'right!' })
    const file = manifestFile('file.bin', [chunk('wanted', 0, 'right!')])

    await downloadManifest(client, manifest(file), {
      ...options(directory, false),
      previousManifest: manifest(file),
    })

    expect(await readFile(join(directory, 'file.bin'), 'utf8')).toBe('right!')
    expect(client.downloadChunk).toHaveBeenCalledTimes(1)
  })

  test('installs a known file-to-directory transition', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-download-'))
    await writeFile(join(directory, 'content'), 'old')
    const oldFile = manifestFile('content', [chunk('old', 0, 'old')])
    const directoryEntry: ManifestFile = {
      filename: 'content',
      size: '0',
      flags: 64,
      sha_content: '',
      chunks: [],
    }
    const child = manifestFile('content/new.bin', [chunk('new', 0, 'new')])

    await downloadManifest(
      fakeClient({ new: 'new' }),
      manifestFiles([child, directoryEntry]),
      {
        ...options(directory, false),
        previousManifest: manifest(oldFile),
      },
    )

    expect(await readFile(join(directory, 'content/new.bin'), 'utf8')).toBe(
      'new',
    )
  })
})

function options(outputDirectory: string, verifyAll: boolean) {
  return { appId: 10, depotId: 20, outputDirectory, verifyAll, maxDownloads: 2 }
}

function manifest(file: ManifestFile): DepotManifest {
  return manifestFiles([file])
}

function manifestFiles(files: ManifestFile[]): DepotManifest {
  return {
    depot_id: 20,
    gid_manifest: '123',
    filenames_encrypted: false,
    cb_disk_original: String(
      files.reduce((sum, file) => sum + Number(file.size), 0),
    ),
    cb_disk_compressed: String(
      files.reduce((sum, file) => sum + Number(file.size), 0),
    ),
    files,
  }
}

function manifestFile(filename: string, chunks: ManifestChunk[]): ManifestFile {
  const contents = Buffer.concat(
    chunks.map((item) =>
      Buffer.from(
        item.sha === 'first' ? 'abc' : item.sha === 'second' ? 'xyz' : '',
      ),
    ),
  )
  return {
    filename,
    size: String(chunks.reduce((sum, item) => sum + item.cb_original, 0)),
    flags: 0,
    sha_content: createHash('sha1').update(contents).digest('hex'),
    chunks,
  }
}

function chunk(sha: string, offset: number, value: string): ManifestChunk {
  return {
    sha,
    offset: String(offset),
    cb_original: value.length,
    cb_compressed: value.length,
    crc: adler(Buffer.from(value)),
  }
}

function adler(value: Buffer): number {
  let a = 0
  let b = 0
  for (const byte of value) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return (a | (b << 16)) >>> 0
}

function fakeClient(chunks: Record<string, string>) {
  const server: ContentServer = { Host: 'cdn.example.test' }
  const client: ChunkClient & { downloadChunk: ReturnType<typeof mock> } = {
    getContentServers: async () => ({ servers: [server] }),
    downloadChunk: mock(
      async (_appId: number, _depotId: number, sha: string) => {
        const value = chunks[sha]
        if (value === undefined) throw new Error(`Missing test chunk ${sha}`)
        return { chunk: Buffer.from(value) }
      },
    ),
  }
  return client
}
