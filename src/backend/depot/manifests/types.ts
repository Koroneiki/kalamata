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
