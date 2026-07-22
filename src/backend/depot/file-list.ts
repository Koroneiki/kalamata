import { readFile } from 'node:fs/promises'
import { normalizeManifestSeparators } from './manifest-utils.ts'

export type FileFilter = (filename: string) => boolean

export async function readFileFilter(path?: string): Promise<FileFilter> {
  if (!path) return () => true

  const literalPaths = new Set<string>()
  const patterns: RegExp[] = []
  for (const [index, rawLine] of (await readFile(path, 'utf8'))
    .split(/\r?\n/u)
    .entries()) {
    if (!rawLine.trim()) continue
    if (rawLine.startsWith('regex:')) {
      try {
        patterns.push(new RegExp(rawLine.slice('regex:'.length), 'iu'))
      } catch (error) {
        throw new Error(`Invalid regular expression in ${path}:${index + 1}`, {
          cause: error,
        })
      }
    } else {
      literalPaths.add(normalizeForMatch(rawLine))
    }
  }

  return (filename) => {
    const normalized = normalizeManifestSeparators(filename)
    return (
      literalPaths.has(normalized.toLowerCase()) ||
      patterns.some((pattern) => pattern.test(normalized))
    )
  }
}

function normalizeForMatch(filename: string): string {
  return normalizeManifestSeparators(filename).toLowerCase()
}
