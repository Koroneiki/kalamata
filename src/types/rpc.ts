export interface AppSummary {
  appId: number
  name: string
  developers: string[]
  publishers: string[]
  releaseDate: number | null
  iconUrls: string[]
  artworkUrl: string | null
}

export type DepotGroup =
  | 'Base Game'
  | 'DLC'
  | 'Steamworks Common Redistributables'
  | 'Unused'

interface AppDepotBase {
  depotId: number
  ownerAppId: number
  group: DepotGroup
  platform: string | null
  language: string | null
  manifestId: string | null
  sizeBytes: string | null
  downloadBytes: string | null
}

export interface EligibleAppDepot extends AppDepotBase {
  eligible: true
  group: 'Base Game' | 'DLC'
  manifestStatus: 'ready' | 'missing' | 'outdated' | 'invalid'
  keyStatus: 'ready' | 'missing' | 'invalid'
  installStatus: 'not-installed' | 'current' | 'outdated'
  selectable: boolean
}

export interface IneligibleAppDepot extends AppDepotBase {
  eligible: false
  group: 'Steamworks Common Redistributables' | 'Unused'
  manifestStatus: null
  keyStatus: null
  installStatus: null
  selectable: false
}

export type AppDepot = EligibleAppDepot | IneligibleAppDepot

export interface AppDetails extends AppSummary {
  installPath: string | null
  depots: AppDepot[]
}

export interface LibraryEntry {
  appId: number
  installPath: string
  createdAt: number
}

export interface StartDownloadRequest {
  appId: number
  installPath: string
  depotIds: number[]
}

export interface RunningDownloadQueue {
  status: 'running'
  appId: number
  installPath: string
  depotIds: number[]
  completedDepotIds: number[]
  currentDepotId: number
  position: number
  total: number
  downloadedBytes: string
  totalBytes: string
  operation: string | null
}

export interface CompletedDownloadQueue {
  status: 'completed'
  appId: number
  installPath: string
  depotIds: number[]
  completedDepotIds: number[]
  downloadedBytes: string
  reusedBytes: string
}

export interface FailedDownloadQueue {
  status: 'failed'
  appId: number
  installPath: string
  depotIds: number[]
  completedDepotIds: number[]
  failedDepotId: number
  failureKind: 'download' | 'persistence'
  error: string
}

export type DownloadQueueState =
  | { status: 'idle' }
  | RunningDownloadQueue
  | CompletedDownloadQueue
  | FailedDownloadQueue

export type AppRpc = {
  bun: {
    requests: {
      getAppSummary: {
        params: { appId: number }
        response: AppSummary
      }
      getAppDetails: {
        params: { appId: number }
        response: AppDetails
      }
      getLibrary: {
        params: Record<string, never>
        response: LibraryEntry[]
      }
      selectInstallDirectory: {
        params: { startingPath?: string }
        response: string | null
      }
      getDownloadState: {
        params: Record<string, never>
        response: DownloadQueueState
      }
      startDownload: {
        params: StartDownloadRequest
        response: RunningDownloadQueue
      }
    }
    messages: Record<never, never>
  }
  webview: {
    requests: Record<never, never>
    messages: {
      downloadStateChanged: DownloadQueueState
    }
  }
}
