import ContentManifest from 'steam-user/components/content_manifest.js'
import {
  DIRECTORY,
  MAX_CHUNK_BYTES,
  SYMLINK,
  manifestPathKey,
} from './manifest-utils.ts'
import {
  depotManifestSchema,
  type DepotManifest,
  type ManifestChunk,
  type ManifestFile,
} from './types.ts'
import { manifestIdSchema, sha1Schema } from '../../../types/schemas.ts'

const END_OF_MANIFEST_MAGIC = 0x32c415ab

export function parseManifest(contents: Buffer, key: Buffer): DepotManifest {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Depot key must be a 32-byte Buffer')
  }
  assertCompleteManifest(contents)
  const manifest = depotManifestSchema.parse(ContentManifest.parse(contents))
  if (manifest.filenames_encrypted) {
    ContentManifest.decryptFilenames(manifest, key)
  }
  return manifest
}

export function parseManifestEnvelope(contents: Buffer): DepotManifest {
  assertCompleteManifest(contents)
  return depotManifestSchema.parse(ContentManifest.parse(contents))
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
  if (!manifest.gid_manifest) {
    throw new Error('Manifest is missing required metadata or files')
  }
  if (!manifestIdSchema.safeParse(manifest.gid_manifest).success) {
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
    validateManifestFile(file, filenames)
  }

  validateManifestPaths(filenames)
}

type ManifestPathEntry = { filename: string; directory: boolean }

function validateManifestFile(
  file: ManifestFile,
  filenames: Map<string, ManifestPathEntry>,
): void {
  if (!file.filename) {
    throw new Error('Manifest contains a file with no filename')
  }
  if (!Number.isInteger(file.flags)) {
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
  if (!(file.flags & DIRECTORY)) validateFileContents(file)
}

function validateFileContents(file: ManifestFile): void {
  const size = parseSafeIntegerText(file.size, `size for ${file.filename}`)
  if (!sha1Schema.safeParse(file.sha_content).success) {
    throw new Error(
      `Manifest contains an invalid file hash for ${file.filename}`,
    )
  }

  let previousEnd = 0
  for (const chunk of [...file.chunks].sort(
    (left, right) => Number(left.offset) - Number(right.offset),
  )) {
    previousEnd = validateManifestChunk(chunk, file.filename, size, previousEnd)
  }
  if (previousEnd !== size)
    throw new Error(`Manifest chunks do not exactly cover ${file.filename}`)
}

function validateManifestChunk(
  chunk: ManifestChunk,
  filename: string,
  fileSize: number,
  previousEnd: number,
): number {
  if (!sha1Schema.safeParse(chunk.sha).success)
    throw new Error(`Manifest contains an invalid chunk hash for ${filename}`)
  const offset = parseSafeIntegerText(
    chunk.offset,
    `chunk offset for ${filename}`,
  )
  const originalSize = validateSafeInteger(
    chunk.cb_original,
    `chunk size for ${filename}`,
  )
  const compressedSize = validateSafeInteger(
    chunk.cb_compressed,
    `compressed chunk size for ${filename}`,
  )
  validateChunkSizes(originalSize, compressedSize, filename)
  validateChunkChecksum(chunk.crc, filename)
  if (offset !== previousEnd || offset + originalSize > fileSize) {
    throw new Error(`Manifest chunks do not exactly cover ${filename}`)
  }
  return offset + originalSize
}

function validateChunkSizes(
  originalSize: number,
  compressedSize: number,
  filename: string,
): void {
  if (
    originalSize < 1 ||
    originalSize > MAX_CHUNK_BYTES ||
    compressedSize < 1 ||
    compressedSize > MAX_CHUNK_BYTES
  ) {
    throw new Error(
      `Manifest contains an unsupported chunk size for ${filename}`,
    )
  }
}

function validateChunkChecksum(checksum: number, filename: string): void {
  if (!Number.isInteger(checksum) || checksum < 0 || checksum > 0xffffffff) {
    throw new Error(
      `Manifest contains an invalid chunk checksum for ${filename}`,
    )
  }
}

function validateManifestPaths(
  filenames: Map<string, ManifestPathEntry>,
): void {
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

function parseSafeIntegerText(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`Manifest contains an invalid ${label}`)
  }
  return validateSafeInteger(Number(value), label)
}

function validateSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Manifest contains an invalid ${label}`)
  return value
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
