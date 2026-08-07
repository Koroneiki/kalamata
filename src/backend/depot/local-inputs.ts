import { readFile } from 'node:fs/promises'
import ContentManifest from 'steam-user/components/content_manifest.js'
import {
  DIRECTORY,
  MAX_CHUNK_BYTES,
  SYMLINK,
  manifestPathKey,
} from './manifest-utils.ts'
import type { DepotManifest } from './types.ts'

export async function readDepotKey(
  path: string,
  depotId: number,
): Promise<Buffer> {
  const contents = await readFile(path, 'utf8')
  const keys = new Map<number, Buffer>()

  for (const rawLine of contents.split(/[\r\n]+/u)) {
    const line = rawLine.trim()
    if (!line) continue

    const [id, hex, extra] = line.split(';')
    if (extra !== undefined || !id || !hex) {
      throw new Error(`Invalid depot key line: ${rawLine}`)
    }

    if (!/^\d+$/u.test(id))
      throw new Error(`Invalid depot ID in key line: ${rawLine}`)
    const parsedId = Number(id)
    if (
      !Number.isSafeInteger(parsedId) ||
      parsedId < 0 ||
      parsedId > 0xffffffff
    ) {
      throw new Error(`Invalid depot ID in key line: ${rawLine}`)
    }
    if (!/^[0-9a-f]{64}$/iu.test(hex)) {
      throw new Error(
        `Depot ${parsedId} key must contain exactly 64 hexadecimal characters`,
      )
    }
    if (keys.has(parsedId))
      throw new Error(`Duplicate key for depot ${parsedId}`)
    keys.set(parsedId, Buffer.from(hex, 'hex'))
  }

  const key = keys.get(depotId)
  if (key) return key
  throw new Error(`No key for depot ${depotId} in ${path}`)
}

export function parseManifest(contents: Buffer, key: Buffer): DepotManifest {
  const manifest = ContentManifest.parse(contents)
  if (manifest.filenames_encrypted) {
    ContentManifest.decryptFilenames(manifest, key)
  }
  return manifest
}

export function validateManifest(
  manifest: DepotManifest,
  depotId: number,
): void {
  if (manifest.depot_id !== depotId) {
    throw new Error(
      `Manifest belongs to depot ${manifest.depot_id}, expected ${depotId}`,
    )
  }
  if (!manifest.gid_manifest || !Array.isArray(manifest.files)) {
    throw new Error('Manifest is missing required metadata or files')
  }
  if (!/^\d+$/u.test(manifest.gid_manifest))
    throw new Error('Manifest has an invalid manifest ID')

  const filenames = new Set<string>()
  for (const file of manifest.files) {
    if (!file || typeof file.filename !== 'string' || !file.filename) {
      throw new Error('Manifest contains a file with no filename')
    }
    if (!Number.isInteger(file.flags) || !Array.isArray(file.chunks)) {
      throw new Error(`Manifest contains invalid metadata for ${file.filename}`)
    }
    const filenameKey = manifestPathKey(file.filename)
    if (filenames.has(filenameKey))
      throw new Error(`Manifest contains duplicate path ${file.filename}`)
    filenames.add(filenameKey)
    if (file.flags & SYMLINK) {
      throw new Error(`Manifest symlinks are not supported: ${file.filename}`)
    }
    if (file.flags & DIRECTORY) continue

    const size = parseSafeInteger(file.size, `size for ${file.filename}`)
    if (!/^[0-9a-f]{40}$/iu.test(file.sha_content)) {
      throw new Error(
        `Manifest contains an invalid file hash for ${file.filename}`,
      )
    }
    let previousEnd = 0
    for (const chunk of [...file.chunks].sort(
      (left, right) => Number(left.offset) - Number(right.offset),
    )) {
      if (!/^[0-9a-f]{40}$/iu.test(chunk.sha))
        throw new Error(
          `Manifest contains an invalid chunk hash for ${file.filename}`,
        )
      const offset = parseSafeInteger(
        chunk.offset,
        `chunk offset for ${file.filename}`,
      )
      const originalSize = parseSafeInteger(
        chunk.cb_original,
        `chunk size for ${file.filename}`,
      )
      const compressedSize = parseSafeInteger(
        chunk.cb_compressed,
        `compressed chunk size for ${file.filename}`,
      )
      if (
        originalSize < 1 ||
        originalSize > MAX_CHUNK_BYTES ||
        compressedSize < 1 ||
        compressedSize > MAX_CHUNK_BYTES
      ) {
        throw new Error(
          `Manifest contains an unsupported chunk size for ${file.filename}`,
        )
      }
      if (
        !Number.isInteger(chunk.crc) ||
        chunk.crc < 0 ||
        chunk.crc > 0xffffffff
      ) {
        throw new Error(
          `Manifest contains an invalid chunk checksum for ${file.filename}`,
        )
      }
      if (offset !== previousEnd || offset + originalSize > size) {
        throw new Error(`Manifest chunks do not exactly cover ${file.filename}`)
      }
      previousEnd = offset + originalSize
    }
    if (previousEnd !== size)
      throw new Error(`Manifest chunks do not exactly cover ${file.filename}`)
  }
}

function parseSafeInteger(value: string | number, label: string): number {
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`Manifest contains an invalid ${label}`)
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`Manifest contains an invalid ${label}`)
  return parsed
}
