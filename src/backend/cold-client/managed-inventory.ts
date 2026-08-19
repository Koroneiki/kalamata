import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { managedCoreFilesSchema } from '../../types/cold-client.ts'
import {
  canonicalManifestPath,
  manifestPathKey,
} from '../depot/manifests/manifest-utils.ts'
import { filesystemErrorCode } from '../depot/install/transaction/types.ts'

export async function collectManagedCoreFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const seen = new Set<string>()
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => comparePaths(left.name, right.name))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
        throw new Error('ColdClient core contains a link or reparse point')
      }
      const relativePath = canonicalManifestPath(
        relative(root, absolutePath).split(sep).join('/'),
        'win32',
      )
      const key = manifestPathKey(relativePath, 'win32')
      if (seen.has(key))
        throw new Error(`ColdClient core repeats ${relativePath}`)
      seen.add(key)
      if (metadata.isDirectory()) {
        if (key !== 'steam_settings') await visit(absolutePath)
      } else if (metadata.isFile()) {
        if (
          key !== 'coldclientloader.ini' &&
          !key.startsWith('steam_settings/')
        ) {
          files.push(relativePath)
        }
      } else {
        throw new Error('ColdClient core contains an unsupported file type')
      }
    }
  }
  await visit(root)
  return managedCoreFilesSchema.parse(files.toSorted(comparePaths))
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function assertRequiredManagedCoreFiles(
  files: string[],
  architecture: 'x86' | 'x64',
): void {
  const keys = new Set(files.map((path) => path.toLowerCase()))
  const required = [
    `steamclient_loader_${architecture}.exe`,
    'steamclient.dll',
    'steamclient64.dll',
  ]
  for (const path of required) {
    if (!keys.has(path)) throw new Error(`ColdClient core is missing ${path}`)
  }
  if (![...keys].some((path) => path.startsWith('extra_dlls/'))) {
    throw new Error('ColdClient core is missing official extra DLLs')
  }
  const unused =
    architecture === 'x86'
      ? 'steamclient_loader_x64.exe'
      : 'steamclient_loader_x86.exe'
  if (keys.has(unused))
    throw new Error('ColdClient core contains the unused loader')
}

export async function assertCoreUpdateOwnership(
  liveRoot: string,
  previousManagedFiles: string[],
  targetManagedFiles: string[],
): Promise<void> {
  const previous = managedPathMap(previousManagedFiles)
  const target = managedPathMap(targetManagedFiles)

  for (const path of previous.values()) {
    const metadata = await lstatOrNull(pathInRoot(liveRoot, path))
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
      throw new Error(`ColdClient managed path conflicts with ${path}`)
    }
  }

  for (const [key, path] of target) {
    await assertDirectoryAncestors(liveRoot, path)
    if (previous.has(key)) continue
    if (await lstatOrNull(pathInRoot(liveRoot, path))) {
      throw new Error(`ColdClient custom path conflicts with ${path}`)
    }
  }
}

function managedPathMap(paths: string[]): Map<string, string> {
  const validated = managedCoreFilesSchema.parse(paths)
  return new Map(
    validated.map((path) => [manifestPathKey(path, 'win32'), path]),
  )
}

async function assertDirectoryAncestors(
  root: string,
  path: string,
): Promise<void> {
  const segments = path.split('/')
  for (let length = 1; length < segments.length; length++) {
    const ancestor = pathInRoot(root, segments.slice(0, length).join('/'))
    const metadata = await lstatOrNull(ancestor)
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
      throw new Error(`ColdClient path has an unsafe ancestor: ${path}`)
    }
  }
}

function pathInRoot(root: string, path: string): string {
  return join(root, ...path.split('/'))
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return null
    throw error
  }
}
