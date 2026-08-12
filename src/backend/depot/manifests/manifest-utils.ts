import { posix, win32 } from 'node:path'
import { CONFIG_DIRECTORY } from '../install/internal-paths.ts'
import type { ManifestFile } from './types.ts'

export const DIRECTORY = 64
export const SYMLINK = 512
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024

export function normalizeManifestSeparators(filename: string): string {
  return filename.replaceAll('\\', '/')
}

export function manifestPathKey(filename: string): string {
  const normalized = canonicalManifestPath(filename)
  return process.platform === 'linux' ? normalized : normalized.toLowerCase()
}

export function canonicalManifestPath(filename: string): string {
  const normalized = normalizeManifestSeparators(filename)
  if (
    !normalized ||
    normalized.includes('\0') ||
    posix.isAbsolute(normalized) ||
    win32.isAbsolute(filename)
  ) {
    throw new Error(`Unsafe manifest path: ${filename}`)
  }
  const canonical = posix.normalize(normalized)
  if (canonical === '.' || canonical === '..' || canonical.startsWith('../')) {
    throw new Error(`Manifest path escapes output directory: ${filename}`)
  }
  if (
    canonical.split('/', 1)[0]?.toLowerCase() === CONFIG_DIRECTORY.toLowerCase()
  ) {
    throw new Error(`Manifest path conflicts with internal state: ${filename}`)
  }
  return canonical
}

export function withImpliedDirectories(files: ManifestFile[]): ManifestFile[] {
  const expanded = new Map<string, ManifestFile>()
  for (const file of files) {
    const segments = normalizeManifestSeparators(file.filename).split('/')
    for (let length = 1; length < segments.length; length++) {
      const filename = segments.slice(0, length).join('/')
      const key = manifestPathKey(filename)
      if (!expanded.has(key)) {
        expanded.set(key, {
          filename,
          size: '0',
          flags: DIRECTORY,
          sha_content: '',
          chunks: [],
        })
      }
    }
    expanded.set(manifestPathKey(file.filename), file)
  }
  return [...expanded.values()]
}
