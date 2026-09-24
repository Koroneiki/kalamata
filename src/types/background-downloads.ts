export type BackgroundDownloadKind =
  | 'application-update'
  | 'dependency'
  | 'manifest'
  | 'depot-keys'
  | 'cold-client'

export interface BackgroundDownloadJob {
  id: string
  key: string
  kind: BackgroundDownloadKind
  title: string
  appId: number | null
  depotId: number | null
  itemCount?: number
  manifestProgress?: {
    finishedCount: number
    currentIndex: number | null
    currentDepotId: number | null
    transferredBytes: number
    totalBytes: number | null
  }
  status: 'queued' | 'active' | 'completed' | 'failed'
  phase: string
  source: string | null
  transferredBytes: number
  totalBytes: number | null
  error: string | null
  finishedAt: number | null
}

export interface BackgroundDownloadsSnapshot {
  jobs: BackgroundDownloadJob[]
}
