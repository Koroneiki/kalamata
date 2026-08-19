import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateArchiveListing,
  validateExtractedTree,
} from '../../../src/backend/cold-client/archive-extractor.ts'
import { removeTemporaryDirectory } from '../../helpers/filesystem.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory)
  directory = undefined
})

test('accepts a deterministic archive inventory', () => {
  expect(
    validateArchiveListing(listing('folder/file.dll', 'folder/other.dll')),
  ).toEqual(['folder/file.dll', 'folder/other.dll'])
})

test('rejects unsafe and duplicate archive paths before extraction', () => {
  for (const path of [
    '../outside.dll',
    '/absolute.dll',
    'C:/absolute.dll',
    'folder/./file.dll',
    'file.dll:stream',
  ]) {
    expect(() => validateArchiveListing(listing(path))).toThrow()
  }
  expect(() =>
    validateArchiveListing(listing('Folder/file.dll', 'folder/FILE.dll')),
  ).toThrow('duplicate')
})

test('rejects archive links and extracted symlinks', async () => {
  for (const property of ['Symbolic Link', 'Hard Link', 'Reparse Point']) {
    expect(() =>
      validateArchiveListing(
        `archive metadata\n----------\nPath = link.dll\n${property} = target.dll\n`,
      ),
    ).toThrow('link or reparse point')
  }

  directory = await mkdtemp(join(tmpdir(), 'cold-client-extract-'))
  const root = join(directory, 'root')
  const outside = join(directory, 'outside.dll')
  await mkdir(root)
  await writeFile(outside, 'outside')
  await symlink(outside, join(root, 'link.dll'))
  await expect(validateExtractedTree(root)).rejects.toThrow('contains a link')
})

function listing(...paths: string[]): string {
  return `archive metadata\n----------\n${paths
    .map((path) => `Path = ${path}\nFolder = -\nAttributes = A`)
    .join('\n\n')}\n`
}
