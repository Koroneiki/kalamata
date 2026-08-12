import type { ChunkClient } from '../../transfer/chunk-client.ts'
import type {
  DepotManifest,
  ManifestChunk,
  ManifestFile,
} from '../../manifests/types.ts'

export type ApplicationTransactionErrorKind =
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

export class ApplicationTransactionError extends Error {
  readonly kind: ApplicationTransactionErrorKind

  constructor(
    kind: ApplicationTransactionErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ApplicationTransactionError'
    this.kind = kind
  }
}

export interface ApplicationDepotRecord {
  depotId: number
  manifestId: string
  pinned?: boolean
  mountIndex: number
  ownerAppId?: number
}

export interface InstalledApplicationDepot {
  depotId: number
  manifest: DepotManifest
  pinned?: boolean
  appId?: number
  ownerAppId?: number
}

export interface DesiredApplicationDepot extends InstalledApplicationDepot {
  client: ChunkClient
}

export interface ApplicationTransactionProgress {
  type: 'progress'
  logicalInstalledCompleted: string
  logicalInstalledTotal: string
  reusedLocal: string
  actualNetwork: string
}

export type ApplicationTransactionEvent =
  | ApplicationTransactionProgress
  | {
      type: 'phase'
      phase:
        | 'planning'
        | 'staging'
        | 'downloading'
        | 'verifying'
        | 'committing'
        | 'persisting-local'
        | 'reconciling'
        | 'completed'
    }

export type ApplicationTransactionCrashBoundary =
  | 'ready-to-commit'
  | 'old-moved'
  | 'some-new-installed'
  | 'filesystem-committed'
  | 'local-config-committed'
  | 'sqlite-reconciled'

export interface RunApplicationTransactionOptions {
  kind: 'download' | 'reconcile' | 'repair'
  appId: number
  outputDirectory: string
  installedDepots: InstalledApplicationDepot[]
  desiredDepots: DesiredApplicationDepot[]
  signal?: AbortSignal
  onEvent?: (event: ApplicationTransactionEvent) => void
  reconcile: (desired: ApplicationDepotRecord[]) => Promise<void>
  acquireLock?: (outputDirectory: string) => Promise<() => Promise<void>>
  testCrashAt?: (boundary: ApplicationTransactionCrashBoundary) => void
}

export interface RecoverApplicationTransactionCallbacks {
  appId: number
  reconcile: (desired: ApplicationDepotRecord[]) => Promise<void>
  acquireLock?: (outputDirectory: string) => Promise<() => Promise<void>>
  testCrashAt?: (boundary: ApplicationTransactionCrashBoundary) => void
}

export interface ApplicationTransactionResult {
  transactionId: string | null
  logicalInstalledBytes: string
  reusedLocalBytes: string
  networkBytes: string
}

export interface ResumableApplicationTransaction {
  appId: number
  kind: RunApplicationTransactionOptions['kind']
  installPath: string
  desiredDepotIds: number[]
  desired: ApplicationDepotRecord[]
  paused: boolean
  installedBytesCompleted: string
  installedBytesTotal: string
  reusedLocalBytes: string
  networkBytes: string
}

export interface ProjectionEntry {
  depot: InstalledApplicationDepot
  file: ManifestFile
  key: string
}

export interface StagedFile {
  entry: ProjectionEntry
  relativePath: string
  stagingPath: string
}

export interface ChunkDestination {
  depot: DesiredApplicationDepot
  appId: number
  file: ManifestFile
  chunk: ManifestChunk
  path: string
}

export interface OldMove {
  path: string
  backup: string
}

export interface InstallAction {
  path: string
  staging?: string
  directory: boolean
  expectedSize?: string
  expectedSha1?: string
}

export interface StagedFileLayout {
  path: string
  size: string
  sha1: string
  chunks: Array<{ key: string; offset: string; size: number }>
}

export interface CompletionRecord {
  source: 'local' | 'network'
  networkBytes: string
}

export type JournalPhase =
  | 'staging'
  | 'ready'
  | 'filesystem-committed'
  | 'sqlite-committed'
  | 'completed'

export interface TransactionJournal {
  version: 2
  id: string
  generation: string
  appId: number
  kind: RunApplicationTransactionOptions['kind']
  installPath: string
  phase: JournalPhase
  paused: boolean
  source: ApplicationDepotRecord[]
  desired: ApplicationDepotRecord[]
  stagedFiles: StagedFileLayout[]
  completedChunks: Record<string, CompletionRecord>
  logicalInstalledTotal: string
  retainedBytes: string
  oldMoves: OldMove[]
  installs: InstallAction[]
  obsoleteDirectories: string[]
}

export interface ProgressState {
  logicalInstalledCompleted: bigint
  logicalInstalledTotal: bigint
  reusedLocal: bigint
  actualNetwork: bigint
}

export interface JournalContext {
  journal: TransactionJournal
  path: string
  write: Promise<void>
  resumed: boolean
}

export function emitProgress(
  options: RunApplicationTransactionOptions,
  progress: ProgressState,
): void {
  options.onEvent?.({
    type: 'progress',
    logicalInstalledCompleted: progress.logicalInstalledCompleted.toString(),
    logicalInstalledTotal: progress.logicalInstalledTotal.toString(),
    reusedLocal: progress.reusedLocal.toString(),
    actualNetwork: progress.actualNetwork.toString(),
  })
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof ApplicationTransactionError) throw signal.reason
  throw new ApplicationTransactionError(
    'cancellation',
    'Transaction cancelled',
    { cause: signal.reason },
  )
}

export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof ApplicationTransactionError &&
      error.kind === 'cancellation') ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

export function isPause(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.reason instanceof Error &&
    signal.reason.name === 'PauseError' &&
    (error === signal.reason || isAbort(error, signal))
  )
}

export function isShutdown(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.reason instanceof Error &&
    signal.reason.name === 'ShutdownError' &&
    (error === signal.reason || isAbort(error, signal))
  )
}

export function isFilesystemError(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException)?.code === 'string'
}

export function classify(
  error: unknown,
  kind: ApplicationTransactionErrorKind,
  message: string,
): ApplicationTransactionError {
  if (error instanceof ApplicationTransactionError) return error
  if (isAbort(error))
    return new ApplicationTransactionError(
      'cancellation',
      'Transaction cancelled',
      { cause: error },
    )
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC')
    return new ApplicationTransactionError('insufficient-space', message, {
      cause: error,
    })
  return new ApplicationTransactionError(kind, message, { cause: error })
}
