import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseManifest,
  readDepotKey,
  validateManifest,
} from '../src/backend/local-inputs.ts'
import type { DepotManifest } from '../src/backend/types.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('readDepotKey', () => {
  test('selects and decodes the requested key', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-key-'))
    const path = join(directory, 'steam.keys')
    const expected = 'ab'.repeat(32)
    await writeFile(path, `100;${'01'.repeat(32)}\n200;${expected}\n`)

    expect((await readDepotKey(path, 200)).toString('hex')).toBe(expected)
  })

  test('rejects malformed matching keys', async () => {
    directory = await mkdtemp(join(tmpdir(), 'depot-key-'))
    const path = join(directory, 'steam.keys')
    await writeFile(path, '200;abcd\n')

    await expect(readDepotKey(path, 200)).rejects.toThrow('64 hexadecimal')
  })
})

test('parses and validates the checked-in Balatro manifest without network access', async () => {
  const key = Buffer.from(
    '16261e41d3e864018778d4a1d81658521a67d9ffb8543ea7e3e21f0685721af1',
    'hex',
  )
  const contents = await readFile(
    join(import.meta.dir, 'fixtures', '2379781_3512319404653808464.manifest'),
  )
  const manifest = parseManifest(contents, key)

  expect(() => validateManifest(manifest, 2379781)).not.toThrow()
  expect(manifest.files).toHaveLength(14)
  expect(
    manifest.files.reduce((sum, file) => sum + file.chunks.length, 0),
  ).toBe(75)
  expect(manifest.cb_disk_original).toBe('66662933')
})

test('rejects chunk gaps and manifest symlinks', () => {
  const manifest = basicManifest()
  manifest.files[0]!.chunks[0]!.offset = '1'
  expect(() => validateManifest(manifest, 20)).toThrow('exactly cover')

  manifest.files[0]!.chunks[0]!.offset = '0'
  manifest.files[0]!.flags = 512
  manifest.files[0]!.linktarget = 'target'
  expect(() => validateManifest(manifest, 20)).toThrow(
    'symlinks are not supported',
  )
})

test('rejects non-decimal manifest integers', () => {
  for (const value of ['', ' ', '0x3', '3e0']) {
    const manifest = basicManifest()
    manifest.files[0]!.size = value
    expect(() => validateManifest(manifest, 20)).toThrow('invalid size')
  }
})

test('rejects manifest paths that differ only by separators', () => {
  const manifest = basicManifest()
  manifest.files.push({ ...manifest.files[0]!, filename: 'folder\\file.bin' })
  manifest.files[0]!.filename = 'folder/file.bin'

  expect(() => validateManifest(manifest, 20)).toThrow('duplicate path')
})

function basicManifest(): DepotManifest {
  return {
    depot_id: 20,
    gid_manifest: '123',
    filenames_encrypted: false,
    cb_disk_original: '3',
    cb_disk_compressed: '3',
    files: [
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
    ],
  }
}
