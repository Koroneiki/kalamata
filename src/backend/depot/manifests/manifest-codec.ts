import ContentManifest from 'steam-user/components/content_manifest.js'
import {
  DIRECTORY,
  MAX_CHUNK_BYTES,
  SYMLINK,
  manifestPathKey,
} from './manifest-utils.ts'
import type { DepotManifest } from './types.ts'

const END_OF_MANIFEST_MAGIC = 0x32c415ab

export function parseManifest(contents: Buffer, key: Buffer): DepotManifest {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Depot key must be a 32-byte Buffer')
  }
  assertCompleteManifest(contents)
  const manifest = ContentManifest.parse(contents)
  if (manifest.filenames_encrypted) {
    ContentManifest.decryptFilenames(manifest, key)
  }
  return manifest
}

export function parseManifestEnvelope(contents: Buffer): DepotManifest {
  assertCompleteManifest(contents)
  return ContentManifest.parse(contents)
}

export function validateManifestEnvelope(
  manifest: DepotManifest,
  depotId: number,
  manifestId?: string,
): void {
  if (manifest.depot_id !== depotId) {
    throw new Error(
      `Manifest belongs to depot ${manifest.depot_id}, expected ${depotId}`,
    )
  }
  if (!manifest.gid_manifest || !Array.isArray(manifest.files)) {
    throw new Error('Manifest is missing required metadata or files')
  }
  if (!/^\d+$/u.test(manifest.gid_manifest)) {
    throw new Error('Manifest has an invalid manifest ID')
  }
  if (manifestId !== undefined && manifest.gid_manifest !== manifestId) {
    throw new Error(
      `Manifest has ID ${manifest.gid_manifest}, expected ${manifestId}`,
    )
  }
}

export function validateManifest(
  manifest: DepotManifest,
  depotId: number,
  manifestId?: string,
): void {
  validateManifestEnvelope(manifest, depotId, manifestId)

  const filenames = new Map<string, { filename: string; directory: boolean }>()
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
    filenames.set(filenameKey, {
      filename: file.filename,
      directory: Boolean(file.flags & DIRECTORY),
    })
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

  for (const [filenameKey, entry] of filenames) {
    let separator = filenameKey.lastIndexOf('/')
    while (separator !== -1) {
      const parent = filenames.get(filenameKey.slice(0, separator))
      if (parent && !parent.directory) {
        throw new Error(
          `Manifest path ${entry.filename} is nested beneath file ${parent.filename}`,
        )
      }
      separator = filenameKey.lastIndexOf('/', separator - 1)
    }
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

function assertCompleteManifest(contents: Buffer): void {
  // steam-user accepts EOF without this marker, including truncated containers.
  if (
    contents.length < 4 ||
    contents.readUint32LE(contents.length - 4) !== END_OF_MANIFEST_MAGIC
  ) {
    throw new Error('Manifest is missing the end-of-manifest marker')
  }
}
