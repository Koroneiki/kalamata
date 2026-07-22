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

export type DownloadEvent =
  | { type: 'file-validating'; path: string }
  | { type: 'file-complete'; path: string }
  | { type: 'file-deleted'; path: string }
  | { type: 'progress'; downloaded: number; total: number }
  | { type: 'retry'; chunk: string; attempt: number }

export interface DownloadDepotOptions {
  appId: number
  depotId: number
  manifestPath: string
  depotKeyPath: string
  outputDirectory: string
  fileListPath?: string
  verifyAll?: boolean
  maxDownloads?: number
  signal?: AbortSignal
  onEvent?: (event: DownloadEvent) => void
}

export interface DownloadResult {
  manifestId: string
  downloadedBytes: number
  reusedBytes: number
}
