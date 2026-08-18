import type { ChunkClient } from '../../transfer/chunk-client.ts'
import type {
  DepotManifest,
  ManifestChunk,
  ManifestFile,
} from '../../manifests/types.ts'
import { z } from 'zod'

const filesystemErrorSchema = z.object({ code: z.string() })

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
  estimatedDownloadBytes: string | null
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
  estimatedDownloadBytes: string
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
  estimatedDownloadBytes: string | null
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
  estimatedDownloadBytes?: string
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
  estimatedDownload: bigint | null
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
    estimatedDownloadBytes: progress.estimatedDownload?.toString() ?? null,
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

export function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (cause instanceof ApplicationTransactionError &&
      cause.kind === 'cancellation') ||
    (cause instanceof DOMException && cause.name === 'AbortError') ||
    (cause instanceof Error && cause.name === 'AbortError')
  )
}

export function isPause(cause: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.reason instanceof Error &&
    signal.reason.name === 'PauseError' &&
    (cause === signal.reason || isAbort(cause, signal))
  )
}

export function isShutdown(cause: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.reason instanceof Error &&
    signal.reason.name === 'ShutdownError' &&
    (cause === signal.reason || isAbort(cause, signal))
  )
}

export function filesystemErrorCode(cause: unknown): string | undefined {
  const parsed = filesystemErrorSchema.safeParse(cause)
  return parsed.success ? parsed.data.code : undefined
}

export function isFilesystemError(cause: unknown): boolean {
  return filesystemErrorCode(cause) !== undefined
}

export function classify(
  cause: unknown,
  kind: ApplicationTransactionErrorKind,
  message: string,
): ApplicationTransactionError {
  if (cause instanceof ApplicationTransactionError) return cause
  if (isAbort(cause))
    return new ApplicationTransactionError(
      'cancellation',
      'Transaction cancelled',
      { cause },
    )
  if (filesystemErrorCode(cause) === 'ENOSPC')
    return new ApplicationTransactionError('insufficient-space', message, {
      cause,
    })
  return new ApplicationTransactionError(kind, message, { cause })
}
