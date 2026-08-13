import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseManifest,
  parseManifestEnvelope,
  validateManifest,
} from '../src/backend/depot/manifests/manifest-codec.ts'
import type { DepotManifest } from '../src/backend/depot/manifests/types.ts'
import {
  canonicalManifestPath,
  manifestPathKey,
} from '../src/backend/depot/manifests/manifest-utils.ts'

const fixturePath = join(
  import.meta.dir,
  'fixtures',
  '2379781_3512319404653808464.manifest',
)

test.skipIf(!(await Bun.file(fixturePath).exists()))(
  'parses and validates the local Balatro manifest without network access',
  async () => {
    const key = Buffer.from(
      '16261e41d3e864018778d4a1d81658521a67d9ffb8543ea7e3e21f0685721af1',
      'hex',
    )
    const contents = await readFile(fixturePath)
    const manifest = parseManifest(contents, key)

    expect(() => validateManifest(manifest, 2379781)).not.toThrow()
    expect(manifest.files).toHaveLength(14)
    expect(
      manifest.files.reduce((sum, file) => sum + file.chunks.length, 0),
    ).toBe(75)
    expect(manifest.cb_disk_original).toBe('66662933')
  },
)

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

test('rejects a manifest with a different embedded depot ID', () => {
  expect(() => validateManifest(basicManifest(), 21)).toThrow(
    'Manifest belongs to depot 20, expected 21',
  )
})

test('rejects manifest paths that differ only by separators', () => {
  const manifest = basicManifest()
  manifest.files.push({ ...manifest.files[0]!, filename: 'folder\\file.bin' })
  manifest.files[0]!.filename = 'folder/file.bin'

  expect(() => validateManifest(manifest, 20)).toThrow('duplicate path')
})

test('rejects canonical path collisions and unsafe paths', () => {
  for (const [left, right] of [
    ['a/../file.bin', 'file.bin'],
    ['a/./file.bin', 'a/file.bin'],
    ['a//file.bin', 'a/file.bin'],
  ]) {
    const manifest = basicManifest()
    manifest.files[0]!.filename = left
    manifest.files.push({ ...manifest.files[0]!, filename: right })
    expect(() => validateManifest(manifest, 20)).toThrow('duplicate path')
  }

  for (const filename of ['../file.bin', '/file.bin', 'C:\\file.bin']) {
    const manifest = basicManifest()
    manifest.files[0]!.filename = filename
    expect(() => validateManifest(manifest, 20)).toThrow(/Unsafe|escapes/u)
  }

  const internal = basicManifest()
  internal.files[0]!.filename = '.Kalamata/state'
  expect(() => validateManifest(internal, 20)).toThrow('internal state')
})

test('rejects entries nested beneath a regular file', () => {
  const manifest = basicManifest()
  manifest.files[0]!.filename = 'file'
  manifest.files.push({ ...manifest.files[0]!, filename: 'file/nested.bin' })

  expect(() => validateManifest(manifest, 20)).toThrow('nested beneath file')
})

test('rejects Windows path aliases and reserved components', () => {
  for (const filename of [
    'file.',
    'file ',
    'folder/file:stream',
    'CON',
    'aux.txt',
    'COM1/config',
    'COM¹/config',
    'LPT².txt',
    'CLOCK$',
    'CONIN$',
    'CONOUT$.txt',
    'name?.bin',
  ]) {
    expect(() => canonicalManifestPath(filename, 'win32')).toThrow(
      'Unsafe Windows manifest path',
    )
  }

  expect(manifestPathKey('Folder/File.bin', 'win32')).toBe(
    manifestPathKey('folder/file.BIN', 'win32'),
  )
})

test('detects macOS Unicode normalization aliases', () => {
  expect(manifestPathKey('café/file.bin', 'darwin')).toBe(
    manifestPathKey('cafe\u0301/file.bin', 'darwin'),
  )
})

test.skipIf(!(await Bun.file(fixturePath).exists()))(
  'rejects a manifest without its end marker',
  async () => {
    const contents = await readFile(fixturePath)
    expect(() => parseManifestEnvelope(contents.subarray(0, -4))).toThrow(
      'end-of-manifest marker',
    )
  },
)

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
