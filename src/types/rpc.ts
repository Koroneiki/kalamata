export interface AppSummary {
  appId: number
  name: string
  developers: string[]
  publishers: string[]
  releaseDate: number | null
  iconUrls: string[]
  artworkUrl: string | null
}

export type DepotPlatform = 'windows' | 'macos' | 'linux'

export interface AppSettings {
  automaticManifestAcquisition: boolean
  hideRedistributables: boolean
  hideUnknownDepots: boolean
  hideUnusedDepots: boolean
  platforms: DepotPlatform[]
}

export type DepotGroup =
  | 'Base Game'
  | 'DLC'
  | 'Unknown'
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
  installedManifestId?: string | null
  pinned?: boolean
  sizeBytes: string | null
  downloadBytes: string | null
}

export interface EligibleAppDepot extends AppDepotBase {
  eligible: true
  group: 'Base Game' | 'DLC'
  manifestStatus: 'ready' | 'missing' | 'outdated' | 'invalid'
  keyStatus: 'present' | 'missing' | 'invalid'
  installStatus: 'not-installed' | 'current' | 'outdated'
  selectable: boolean
}

export interface IneligibleAppDepot extends AppDepotBase {
  eligible: false
  group: 'Unknown' | 'Steamworks Common Redistributables' | 'Unused'
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
  manifestTargets?: DepotManifestTarget[]
}

export interface QueueDepotUpdateRequest {
  appId: number
  desiredDepotIds: number[]
  manifestTargets?: DepotManifestTarget[]
}

export interface PreviewApplicationOperationRequest {
  appId: number
  desiredDepotIds: number[]
  manifestTargets?: DepotManifestTarget[]
}

export interface DepotManifestTarget {
  depotId: number
  manifestId: string
}

export interface ApplicationOperationPreview {
  depots: Array<{
    depotId: number
    action: 'install' | 'remove' | 'update'
  }>
  counts: {
    install: number
    remove: number
    update: number
  }
  logicalSizeDeltaBytes: string
  networkPayloadUpperBoundBytes: string | null
  stagingLogicalUpperBoundBytes: string
}

export interface RepairApplicationRequest {
  appId: number
}

export interface AcquireManifestRequest {
  appId: number
  depotId: number
  manifestId: string
}

export interface AcquiredManifest {
  depotId: number
  manifestId: string
  relativePath: string
}

export interface AcquireDepotKeysRequest {
  appId: number
  depotIds: number[]
}

export interface AcquiredDepotKeys {
  acquiredDepotIds: number[]
  missingDepotIds: number[]
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

export interface PausedOperationState extends Omit<
  ActiveOperationState,
  'status'
> {
  status: 'paused'
}

export interface ResumableOperationState extends Omit<
  ActiveOperationState,
  'status'
> {
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
      getSettings: {
        params: Record<string, never>
        response: AppSettings
      }
      updateSettings: {
        params: AppSettings
        response: AppSettings
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
      setDepotPinned: {
        params: { appId: number; depotId: number; pinned: boolean }
        response: void
      }
      selectInstallDirectory: {
        params: { startingPath?: string }
        response: string | null
      }
      startDownload: {
        params: StartDownloadRequest
        response: ActiveOperationState
      }
      queueDepotUpdate: {
        params: QueueDepotUpdateRequest
        response: ActiveOperationState
      }
      previewApplicationOperation: {
        params: PreviewApplicationOperationRequest
        response: ApplicationOperationPreview
      }
      repairApplication: {
        params: RepairApplicationRequest
        response: ActiveOperationState
      }
      acquireManifest: {
        params: AcquireManifestRequest
        response: AcquiredManifest
      }
      acquireDepotKeys: {
        params: AcquireDepotKeysRequest
        response: AcquiredDepotKeys
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
      operationStateChanged: OperationState
    }
  }
}
