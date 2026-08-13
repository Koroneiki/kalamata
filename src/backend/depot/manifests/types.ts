import { z } from 'zod'

export interface ManifestChunk {
  sha: string
  crc: number
  offset: string
  cb_original: number
  cb_compressed: number
}

export interface ManifestFile {
  filename: string
  size: string
  flags: number
  sha_content: string
  linktarget?: string
  chunks: ManifestChunk[]
}

export interface DepotManifest {
  depot_id: number
  gid_manifest: string
  filenames_encrypted: boolean
  cb_disk_original: string
  cb_disk_compressed: string
  files: ManifestFile[]
}

const manifestChunkSchema: z.ZodType<ManifestChunk> = z.looseObject({
  sha: z.string(),
  crc: z.number(),
  offset: z.string(),
  cb_original: z.number(),
  cb_compressed: z.number(),
})
const manifestFileSchema: z.ZodType<ManifestFile> = z.looseObject({
  filename: z.string(),
  size: z.string(),
  flags: z.number(),
  sha_content: z.string(),
  linktarget: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((value) => value ?? undefined),
  chunks: z.array(manifestChunkSchema),
})
export const depotManifestSchema: z.ZodType<DepotManifest> = z.looseObject({
  depot_id: z.number(),
  gid_manifest: z.string(),
  filenames_encrypted: z.boolean(),
  cb_disk_original: z.string(),
  cb_disk_compressed: z.string(),
  files: z.array(manifestFileSchema),
})
