import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertNoSymlinkTraversal,
  resolveManifestPath,
  resolveOutputPath,
} from '../src/backend/depot/install/filesystem.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

test('rejects manifest path traversal', () => {
  expect(() => resolveManifestPath('/safe/output', '../outside')).toThrow(
    'escapes output',
  )
  expect(() =>
    resolveManifestPath('/safe/output', 'folder\\file.bin'),
  ).not.toThrow()
})

test('rejects normalized internal-state aliases', () => {
  expect(() =>
    resolveOutputPath('/safe/output', 'ordinary/../.Kalamata/config'),
  ).toThrow('conflicts with internal state')
})

test('rejects paths traversing an existing symlink', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-files-'))
  const outside = await mkdtemp(join(tmpdir(), 'depot-outside-'))
  try {
    await mkdir(join(directory, 'nested'))
    await symlink(outside, join(directory, 'nested', 'link'))
    await expect(
      assertNoSymlinkTraversal(directory, 'nested/link/file.bin'),
    ).rejects.toThrow('symbolic link')
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})
