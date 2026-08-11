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
  mountIndex: number
  ownerAppId: number
  ownerAppName: string | null
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
  inLibrary: boolean
  installPath: string | null
  selectedDepotIds: number[]
  depots: AppDepot[]
}

export interface LibraryEntry {
  appId: number
  installPath: string | null
  createdAt: number
}

export interface StartDownloadRequest {
  appId: number
  installPath: string
  depotIds: number[]
}

export interface QueueDepotUpdateRequest {
  appId: number
  desiredDepotIds: number[]
}

export interface RepairApplicationRequest {
  appId: number
}

export type OperationKind = 'download' | 'reconcile' | 'repair'

export type OperationPhase =
  | 'planning'
  | 'staging'
  | 'downloading'
  | 'verifying'
  | 'committing'
  | 'reconciling'

export type OperationErrorKind =
  | 'planning'
  | 'unavailable-resource'
  | 'insufficient-space'
  | 'steam'
  | 'unavailable-content'
  | 'transfer-exhausted'
  | 'integrity'
  | 'filesystem'
  | 'cancellation'
  | 'recovery'
  | 'persistence'

export interface ActiveOperationState {
  status: 'active'
  kind: OperationKind
  phase: OperationPhase
  appId: number
  installPath: string
  desiredDepotIds: number[]
  installedBytesCompleted: string
  installedBytesTotal: string
  reusedLocalBytes: string
  networkBytes: string
}

export interface PausedOperationState
  extends Omit<ActiveOperationState, 'status'> {
  status: 'paused'
}

export interface ResumableOperationState
  extends Omit<ActiveOperationState, 'status'> {
  status: 'resumable'
  error: { kind: OperationErrorKind; message: string }
}

export type OperationState =
  | { status: 'idle' }
  | ActiveOperationState
  | PausedOperationState
  | ResumableOperationState
  | {
      status: 'completed'
      kind: OperationKind
      appId: number
      installPath: string
      desiredDepotIds: number[]
      installedBytes: string
      reusedLocalBytes: string
      networkBytes: string
    }
  | {
      status: 'cancelled'
      kind: OperationKind
      appId: number
      installPath: string
      desiredDepotIds: number[]
      error: { kind: 'cancellation'; message: string }
    }
  | {
      status: 'failed'
      kind: OperationKind
      appId: number
      installPath: string
      desiredDepotIds: number[]
      error: { kind: OperationErrorKind; message: string }
    }
  | {
      status: 'repair-required'
      appId: number
      installPath: string
      error: { kind: 'recovery'; message: string }
    }

export type CancelOperationResult =
  | { accepted: true }
  | {
      accepted: false
      reason: 'no-active-operation' | 'commit-in-progress'
    }

export type PauseOperationResult =
  | { accepted: true }
  | {
      accepted: false
      reason: 'no-active-operation' | 'invalid-phase'
    }

export type ResumeOperationResult =
  | { accepted: true }
  | { accepted: false; reason: 'no-resumable-operation' }

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
      addLibraryEntry: {
        params: { appId: number }
        response: LibraryEntry
      }
      removeLibraryEntry: {
        params: { appId: number }
        response: void
      }
      setSelectedDepots: {
        params: { appId: number; depotIds: number[] }
        response: number[]
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
      queueDepotUpdate: {
        params: QueueDepotUpdateRequest
        response: ActiveOperationState
      }
      repairApplication: {
        params: RepairApplicationRequest
        response: ActiveOperationState
      }
      cancelOperation: {
        params: Record<string, never>
        response: CancelOperationResult
      }
      pauseOperation: {
        params: Record<string, never>
        response: PauseOperationResult
      }
      resumeOperation: {
        params: Record<string, never>
        response: ResumeOperationResult
      }
      getOperationState: {
        params: Record<string, never>
        response: OperationState
      }
    }
    messages: Record<never, never>
  }
  webview: {
    requests: Record<never, never>
    messages: {
      downloadStateChanged: DownloadQueueState
      operationStateChanged: OperationState
    }
  }
}
