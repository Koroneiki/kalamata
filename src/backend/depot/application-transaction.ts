import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ChunkClient, ContentServer } from './content-client.ts'
import { abortable } from './abortable.ts'
import { CDNClientPool } from './cdn-client-pool.ts'
import { HttpStatusError } from './chunk-download.ts'
import { acquireOutputLock } from './depot-config-store.ts'
import { CONFIG_DIRECTORY } from './depot-paths.ts'
import {
  assertNoSymlinkTraversal,
  preallocate,
  resolveManifestPath,
  resolveOutputPath,
  setExecutable,
  verifyFileSha1,
  writeChunk,
} from './files.ts'
import {
  DIRECTORY,
  SYMLINK,
  manifestPathKey,
  normalizeManifestSeparators,
  withImpliedDirectories,
} from './manifest-utils.ts'
import type { DepotManifest, ManifestChunk, ManifestFile } from './types.ts'

const DOWNLOAD_CONCURRENCY = 8
const TRANSACTION_VERSION = 2
const EXECUTABLE = 32
const USER_CONFIG = 1
const VERSIONED_USER_CONFIG = 2

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
  mountIndex: number
  ownerAppId?: number
}

export interface InstalledApplicationDepot {
  depotId: number
  manifest: DepotManifest
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

interface ProjectionEntry {
  depot: InstalledApplicationDepot
  file: ManifestFile
  key: string
}

interface StagedFile {
  entry: ProjectionEntry
  relativePath: string
  stagingPath: string
}

interface ChunkDestination {
  depot: DesiredApplicationDepot
  appId: number
  file: ManifestFile
  chunk: ManifestChunk
  path: string
}

interface OldMove {
  path: string
  backup: string
}

interface InstallAction {
  path: string
  staging?: string
  directory: boolean
  expectedSize?: string
  expectedSha1?: string
}

interface StagedFileLayout {
  path: string
  size: string
  sha1: string
  chunks: Array<{ key: string; offset: string; size: number }>
}

interface CompletionRecord {
  source: 'local' | 'network'
  networkBytes: string
}

type JournalPhase =
  | 'staging'
  | 'ready'
  | 'filesystem-committed'
  | 'sqlite-committed'
  | 'completed'

interface TransactionJournal {
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

interface ProgressState {
  logicalInstalledCompleted: bigint
  logicalInstalledTotal: bigint
  reusedLocal: bigint
  actualNetwork: bigint
}

interface JournalContext {
  journal: TransactionJournal
  path: string
  write: Promise<void>
  resumed: boolean
}

export async function runApplicationTransaction(
  options: RunApplicationTransactionOptions,
): Promise<ApplicationTransactionResult> {
  const acquire = options.acquireLock ?? acquireOutputLock
  const release = await acquire(options.outputDirectory).catch((error) => {
    throw classify(error, 'filesystem', 'Could not acquire output lock')
  })
  let result: ApplicationTransactionResult
  let releaseError: unknown
  try {
    result = await runUnlocked(options)
  } finally {
    try {
      await release()
    } catch (error) {
      releaseError = error
    }
  }
  if (releaseError)
    throw classify(releaseError, 'filesystem', 'Could not release output lock')
  return result
}

export async function recoverAndRunApplicationTransaction(
  options: RunApplicationTransactionOptions,
): Promise<ApplicationTransactionResult> {
  const acquire = options.acquireLock ?? acquireOutputLock
  const release = await acquire(options.outputDirectory).catch((error) => {
    throw classify(error, 'filesystem', 'Could not acquire output lock')
  })
  let result: ApplicationTransactionResult
  let releaseError: unknown
  try {
    await recoverUnlocked(options.outputDirectory, {
      appId: options.appId,
      reconcile: options.reconcile,
      ...(options.testCrashAt ? { testCrashAt: options.testCrashAt } : {}),
    })
    result = await runUnlocked(options)
  } finally {
    try {
      await release()
    } catch (error) {
      releaseError = error
    }
  }
  if (releaseError)
    throw classify(releaseError, 'filesystem', 'Could not release output lock')
  return result
}

export async function recoverApplicationTransaction(
  outputDirectory: string,
  callbacks: RecoverApplicationTransactionCallbacks,
): Promise<void> {
  const acquire = callbacks.acquireLock ?? acquireOutputLock
  const release = await acquire(outputDirectory).catch((error) => {
    throw classify(
      error,
      'recovery',
      'Could not acquire output lock for recovery',
    )
  })
  let releaseError: unknown
  try {
    await recoverUnlocked(outputDirectory, callbacks)
  } finally {
    try {
      await release()
    } catch (error) {
      releaseError = error
    }
  }
  if (releaseError)
    throw classify(releaseError, 'recovery', 'Could not release recovery lock')
}

export async function getResumableApplicationTransaction(
  outputDirectory: string,
  expectedAppId: number,
): Promise<ResumableApplicationTransaction | null> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return null
  const journal = await readJournal(
    join(root, entries[0]!.name, 'journal.json'),
  )
  assertJournalIdentity(journal, expectedAppId, outputDirectory)
  if (journal.phase !== 'staging') return null
  let completed = BigInt(journal.retainedBytes)
  let reused = BigInt(journal.retainedBytes)
  let network = 0n
  for (const file of journal.stagedFiles) {
    for (const chunk of file.chunks) {
      const record = journal.completedChunks[chunk.key]
      if (!record) continue
      completed += BigInt(chunk.size)
      if (record.source === 'local') reused += BigInt(chunk.size)
    }
  }
  for (const record of Object.values(journal.completedChunks))
    network += BigInt(record.networkBytes)
  return {
    appId: journal.appId,
    kind: journal.kind,
    installPath: journal.installPath,
    desiredDepotIds: journal.desired.map(({ depotId }) => depotId),
    desired: journal.desired,
    paused: journal.paused,
    installedBytesCompleted: completed.toString(),
    installedBytesTotal: journal.logicalInstalledTotal,
    reusedLocalBytes: reused.toString(),
    networkBytes: network.toString(),
  }
}

export async function hasCommitReadyApplicationTransaction(
  outputDirectory: string,
): Promise<boolean> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const transactionRoot = join(root, entry.name)
    if (
      (await pathExists(join(transactionRoot, 'commit-ready'))) ||
      (await pathExists(join(transactionRoot, 'backup')))
    )
      return true
    try {
      const journal = await readJournal(join(transactionRoot, 'journal.json'))
      if (journal.phase !== 'staging') return true
    } catch {
      // A malformed pre-commit journal without commit evidence is discardable.
    }
  }
  return false
}

export async function archiveUnresolvedApplicationTransaction(
  outputDirectory: string,
): Promise<ApplicationDepotRecord[] | null> {
  return withOutputLock(outputDirectory, () =>
    archiveUnresolvedApplicationTransactionUnlocked(outputDirectory),
  )
}

async function archiveUnresolvedApplicationTransactionUnlocked(
  outputDirectory: string,
): Promise<ApplicationDepotRecord[] | null> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return readRepairFallbackDesired(outputDirectory)
    throw error
  }
  const entry = entries.find((candidate) => candidate.isDirectory())
  if (!entry) return readRepairFallbackDesired(outputDirectory)
  const transactionRoot = join(root, entry.name)
  let desired: ApplicationDepotRecord[] | null = null
  try {
    desired = (await readJournal(join(transactionRoot, 'journal.json'))).desired
  } catch {
    // A malformed commit cannot provide a target identity; Repair falls back
    // to the recorded installed version while preserving the evidence.
  }
  const archiveRoot = join(
    outputDirectory,
    CONFIG_DIRECTORY,
    'repair-fallback',
  )
  await mkdir(archiveRoot, { recursive: true })
  await rename(transactionRoot, join(archiveRoot, entry.name))
  return desired
}

async function readRepairFallbackDesired(
  outputDirectory: string,
): Promise<ApplicationDepotRecord[] | null> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'repair-fallback')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const entry = entries.find((candidate) => candidate.isDirectory())
  if (!entry) return null
  try {
    return (await readJournal(join(root, entry.name, 'journal.json'))).desired
  } catch {
    return null
  }
}

export async function clearRepairFallback(
  outputDirectory: string,
): Promise<void> {
  await withOutputLock(outputDirectory, () =>
    rm(join(outputDirectory, CONFIG_DIRECTORY, 'repair-fallback'), {
      recursive: true,
      force: true,
    }),
  )
}

export async function discardPrecommitApplicationTransaction(
  outputDirectory: string,
): Promise<void> {
  await withOutputLock(outputDirectory, () =>
    discardPrecommitApplicationTransactionUnlocked(outputDirectory),
  )
}

async function discardPrecommitApplicationTransactionUnlocked(
  outputDirectory: string,
): Promise<void> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const transactionRoot = join(root, entry.name)
    const journal = await readJournal(join(transactionRoot, 'journal.json'))
    if (journal.phase !== 'staging')
      throw new ApplicationTransactionError(
        'recovery',
        'Commit-ready transaction cannot be cancelled',
      )
    await rm(transactionRoot, { recursive: true, force: true })
  }
}

async function withOutputLock<T>(
  outputDirectory: string,
  action: () => Promise<T>,
): Promise<T> {
  const release = await acquireOutputLock(outputDirectory)
  try {
    return await action()
  } finally {
    await release()
  }
}

async function runUnlocked(
  options: RunApplicationTransactionOptions,
): Promise<ApplicationTransactionResult> {
  options.onEvent?.({ type: 'phase', phase: 'planning' })
  throwIfAborted(options.signal)

  let source: Map<string, ProjectionEntry>
  let target: Map<string, ProjectionEntry>
  try {
    source = buildProjection(options.installedDepots, options.appId)
    target = buildProjection(options.desiredDepots, options.appId)
    validateDesiredDepots(options.desiredDepots)
    for (const entry of target.values())
      resolveOutputPath(options.outputDirectory, entry.file.filename)
  } catch (error) {
    throw classify(error, 'planning', 'Could not build application projection')
  }

  const progress: ProgressState = {
    logicalInstalledCompleted: 0n,
    logicalInstalledTotal: sumProjectionFiles(target),
    reusedLocal: 0n,
    actualNetwork: 0n,
  }
  emitProgress(options, progress)
  if (options.kind === 'repair')
    options.onEvent?.({ type: 'phase', phase: 'verifying' })

  const changed: ProjectionEntry[] = []
  for (const entry of target.values()) {
    throwIfAborted(options.signal)
    const wantsDirectory = isDirectory(entry.file)
    const path = resolveOutputPath(options.outputDirectory, entry.file.filename)
    const info = await safeLstat(path)
    const previous = source.get(entry.key)
    if (info?.isSymbolicLink())
      throw new ApplicationTransactionError(
        'planning',
        `Managed path became a symbolic link: ${entry.file.filename}`,
      )
    if (
      !wantsDirectory &&
      info?.isFile() &&
      isConfigFile(entry.file) &&
      (isUserConfig(entry.file) || sameManifestOwner(previous, entry))
    ) {
      const size = BigInt(entry.file.size)
      progress.logicalInstalledCompleted += size
      progress.reusedLocal += size
      emitProgress(options, progress)
      continue
    }
    if (options.kind !== 'repair' && sameManifestOwner(previous, entry)) {
      const size = BigInt(entry.file.size)
      progress.logicalInstalledCompleted += size
      progress.reusedLocal += size
      emitProgress(options, progress)
      continue
    }
    if (wantsDirectory) {
      if (info?.isDirectory() && !info.isSymbolicLink()) continue
      changed.push(entry)
      continue
    }
    if (!info?.isFile() || info.isSymbolicLink()) {
      changed.push(entry)
      continue
    }
    try {
      await verifyFileSha1(path, entry.file.sha_content, options.signal)
      if (!executableModeMatches(info.mode, entry.file)) {
        changed.push(entry)
        continue
      }
      const size = BigInt(entry.file.size)
      progress.logicalInstalledCompleted += size
      progress.reusedLocal += size
      emitProgress(options, progress)
    } catch (error) {
      if (isFilesystemError(error))
        throw classify(
          error,
          'filesystem',
          `Could not verify ${entry.file.filename}`,
        )
      changed.push(entry)
    }
  }

  const changedFiles = changed.filter((entry) => !isDirectory(entry.file))
  if (changed.length === 0 && !filesystemChangesNeeded(source, target)) {
    const desired = desiredRecords(options.desiredDepots)
    options.onEvent?.({ type: 'phase', phase: 'reconciling' })
    await callPersistence(options.reconcile, desired, 'SQLite reconciliation')
    options.onEvent?.({ type: 'phase', phase: 'completed' })
    return {
      transactionId: null,
      logicalInstalledBytes: progress.logicalInstalledTotal.toString(),
      reusedLocalBytes: progress.reusedLocal.toString(),
      networkBytes: '0',
    }
  }

  const sourceRecords = desiredRecords(options.installedDepots)
  const desired = desiredRecords(options.desiredDepots)
  const stagedFiles = stagedFileLayout(changedFiles)
  const requiredBytes = changedFiles.reduce(
    (sum, entry) => sum + BigInt(entry.file.size),
    0n,
  )
  await validateObstructions(options.outputDirectory, source, changed)
  const resumed = await loadResumableJournal(options, {
    source: sourceRecords,
    desired,
    stagedFiles,
  })
  const allocatedBytes = resumed
    ? await stagedAllocatedBytes(options.outputDirectory, resumed)
    : 0n
  await assertSpace(
    options.outputDirectory,
    requiredBytes > allocatedBytes ? requiredBytes - allocatedBytes : 0n,
  )
  const id = resumed?.id ?? randomUUID()
  const transactionRoot = join(
    options.outputDirectory,
    CONFIG_DIRECTORY,
    'transactions',
    id,
  )
  const stagingRoot = join(transactionRoot, 'staging')
  const backupRoot = join(transactionRoot, 'backup')
  const journalPath = join(transactionRoot, 'journal.json')
  let journal: TransactionJournal =
    resumed ??
    {
      version: TRANSACTION_VERSION,
      id,
      generation: randomUUID(),
      appId: options.appId,
      kind: options.kind,
      installPath: resolve(options.outputDirectory),
      phase: 'staging',
      paused: false,
      source: sourceRecords,
      desired,
      stagedFiles,
      completedChunks: {},
      logicalInstalledTotal: progress.logicalInstalledTotal.toString(),
      retainedBytes: progress.logicalInstalledCompleted.toString(),
      oldMoves: [],
      installs: [],
      obsoleteDirectories: [],
    }
  const journalContext = {
    journal,
    path: journalPath,
    write: Promise.resolve(),
    resumed: resumed !== undefined,
  }

  try {
    await mkdir(stagingRoot, { recursive: true })
    journalContext.journal = { ...journalContext.journal, paused: false }
    await checkpointJournal(journalContext)
    options.onEvent?.({ type: 'phase', phase: 'staging' })

    const staged = await prepareStagedFiles(
      options,
      source,
      changedFiles,
      stagingRoot,
      progress,
      journalContext,
    )
    throwIfAborted(options.signal)
    const actions = await planCommitActions(
      options.outputDirectory,
      source,
      target,
      changed,
      staged,
      backupRoot,
    )
    throwIfAborted(options.signal)
    options.onEvent?.({ type: 'phase', phase: 'committing' })
    journal = { ...journalContext.journal, ...actions, phase: 'ready' }
    journalContext.journal = journal
    await writeJournal(journalPath, journal)
    await writeFile(join(transactionRoot, 'commit-ready'), '')
    options.testCrashAt?.('ready-to-commit')

    await rollForward(transactionRoot, journalPath, journal, options)
    options.onEvent?.({ type: 'phase', phase: 'completed' })
    return {
      transactionId: id,
      logicalInstalledBytes: progress.logicalInstalledTotal.toString(),
      reusedLocalBytes: progress.reusedLocal.toString(),
      networkBytes: progress.actualNetwork.toString(),
    }
  } catch (error) {
    if (journalContext.journal.phase === 'staging') {
      if (
        isAbort(error, options.signal) &&
        !isPause(error, options.signal) &&
        !isShutdown(error, options.signal)
      ) {
        await rm(transactionRoot, { recursive: true, force: true }).catch(
          () => {},
        )
      } else {
        journalContext.journal = {
          ...journalContext.journal,
          paused: isPause(error, options.signal),
        }
        await checkpointJournal(journalContext).catch(() => {})
      }
    }
    if (error instanceof ApplicationTransactionError) throw error
    if (isAbort(error, options.signal))
      throw new ApplicationTransactionError(
        'cancellation',
        'Transaction cancelled',
        {
          cause: error,
        },
      )
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
      throw new ApplicationTransactionError(
        'insufficient-space',
        'Insufficient space while staging application',
        { cause: error },
      )
    throw classify(error, 'filesystem', 'Application transaction failed')
  }
}

async function prepareStagedFiles(
  options: RunApplicationTransactionOptions,
  source: Map<string, ProjectionEntry>,
  changedFiles: ProjectionEntry[],
  stagingRoot: string,
  progress: ProgressState,
  journal: JournalContext,
): Promise<StagedFile[]> {
  const staged: StagedFile[] = []
  const destinations = new Map<string, ChunkDestination[]>()
  for (const entry of changedFiles) {
    throwIfAborted(options.signal)
    const relativePath = normalizeManifestSeparators(entry.file.filename)
    const stagingPath = resolveManifestPath(stagingRoot, relativePath)
    if (!journal.resumed) await preallocate(stagingPath, fileSize(entry.file))
    staged.push({ entry, relativePath, stagingPath })
    const depot = entry.depot as DesiredApplicationDepot
    for (const chunk of entry.file.chunks) {
      const key = chunkKey(chunk)
      const group = destinations.get(key) ?? []
      group.push({
        depot,
        appId: depot.ownerAppId ?? depot.appId ?? options.appId,
        file: entry.file,
        chunk,
        path: stagingPath,
      })
      destinations.set(key, group)
    }
  }

  const sourceCandidates = buildChunkCandidates(source, options.outputDirectory)
  const downloads = new Map<string, ChunkDestination[]>()
  for (const [key, group] of destinations) {
    throwIfAborted(options.signal)
    const completed = journal.journal.completedChunks[key]
    if (completed) {
      const logicalBytes = group.reduce(
        (sum, destination) =>
          sum + BigInt(destination.chunk.cb_original),
        0n,
      )
      progress.logicalInstalledCompleted += logicalBytes
      if (completed.source === 'local') progress.reusedLocal += logicalBytes
      progress.actualNetwork += BigInt(completed.networkBytes)
      continue
    }
    const candidate = await reusableChunk(
      sourceCandidates.get(key) ?? [],
      options.signal,
    )
    if (!candidate) {
      downloads.set(key, group)
      continue
    }
    const data = candidate.data
    for (const destination of group) {
      await writeChunk(destination.path, destination.chunk, data)
      const bytes = BigInt(destination.chunk.cb_original)
      progress.reusedLocal += bytes
      progress.logicalInstalledCompleted += bytes
    }
    await completeChunk(journal, key, 'local', 0)
    emitProgress(options, progress)
  }

  emitProgress(options, progress)
  if (downloads.size > 0)
    options.onEvent?.({ type: 'phase', phase: 'downloading' })
  await downloadChunks(options, downloads, progress, journal)

  options.onEvent?.({ type: 'phase', phase: 'verifying' })
  for (const item of staged) {
    throwIfAborted(options.signal)
    try {
      await setExecutable(item.stagingPath, item.entry.file)
    } catch (error) {
      if (isFilesystemError(error)) throw error
      throw new ApplicationTransactionError(
        'integrity',
        `Staged file failed SHA-1 verification: ${item.relativePath}`,
        { cause: error },
      )
    }
  }
  return staged
}

async function downloadChunks(
  options: RunApplicationTransactionOptions,
  downloads: Map<string, ChunkDestination[]>,
  progress: ProgressState,
  journal: JournalContext,
): Promise<void> {
  const jobs = [...downloads.values()]
  const serverPools = new Map<string, Promise<CDNClientPool | null>>()
  let next = 0
  const controller = new AbortController()
  const abort = () =>
    controller.abort(
      options.signal?.reason ??
        new DOMException('Transaction aborted', 'AbortError'),
    )
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })

  const worker = async () => {
    while (true) {
      throwIfAborted(controller.signal)
      const group = jobs[next++]
      if (!group) return
      try {
        const downloaded = await fetchChunk(
          group,
          controller.signal,
          serverPools,
        )
        throwIfAborted(controller.signal)
        progress.actualNetwork += BigInt(downloaded.networkBytes)
        for (const destination of group) {
          await writeChunk(
            destination.path,
            destination.chunk,
            downloaded.chunk,
          )
          progress.logicalInstalledCompleted += BigInt(
            destination.chunk.cb_original,
          )
        }
        await completeChunk(
          journal,
          chunkKey(group[0]!.chunk),
          'network',
          downloaded.networkBytes,
        )
        emitProgress(options, progress)
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error)
        throw error
      }
    }
  }

  try {
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) },
        worker,
      ),
    )
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw controller.signal.reason ?? failed.reason
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

async function fetchChunk(
  destinations: ChunkDestination[],
  signal: AbortSignal,
  serverPools: Map<string, Promise<CDNClientPool | null>>,
): Promise<{ chunk: Buffer; networkBytes: number }> {
  let lastError: unknown
  let foundServers = false
  const resources = uniqueResources(destinations)
  for (const resource of resources) {
    throwIfAborted(signal)
    let pool: CDNClientPool | null
    try {
      const cacheKey = `${resource.appId}:${resource.depot.depotId}`
      let request = serverPools.get(cacheKey)
      if (!request) {
        request = abortable(
          resource.depot.client.getContentServers(resource.appId),
          signal,
        ).then(({ servers }) =>
          servers.length > 0 ? new CDNClientPool(servers) : null,
        )
        serverPools.set(cacheKey, request)
      }
      pool = await abortable(request, signal)
    } catch (error) {
      if (isAbort(error, signal)) throw error
      lastError = new ApplicationTransactionError(
        'steam',
        `Could not list content servers for app ${resource.appId}`,
        { cause: error },
      )
      continue
    }
    if (!pool) continue
    foundServers = true
    const attempted = new Set<ContentServer>()
    for (let attempt = 0; attempt < pool.attemptsPerChunk; attempt++) {
      throwIfAborted(signal)
      const server = pool.getConnection(attempted)
      attempted.add(server)
      try {
        const first = destinations[0]!
        let downloaded
        try {
          downloaded = await resource.depot.client.downloadChunk(
            resource.appId,
            resource.depot.depotId,
            first.chunk.sha,
            server,
            signal,
            Number(first.chunk.cb_original),
          )
        } catch (error) {
          if (
            !(error instanceof HttpStatusError) ||
            error.retryAfterMs === null
          )
            throw error
          await sleep(error.retryAfterMs, undefined, { signal })
          downloaded = await resource.depot.client.downloadChunk(
            resource.appId,
            resource.depot.depotId,
            first.chunk.sha,
            server,
            signal,
            Number(first.chunk.cb_original),
          )
        }
        if (downloaded.chunk.length !== Number(first.chunk.cb_original)) {
          throw new ApplicationTransactionError(
            'unavailable-content',
            `Chunk ${first.chunk.sha} has an unexpected size`,
          )
        }
        pool.returnConnection(server)
        return {
          chunk: downloaded.chunk,
          networkBytes: networkByteCount(
            downloaded.networkBytes,
            downloaded.chunk.length,
          ),
        }
      } catch (error) {
        if (isAbort(error, signal)) throw error
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
          throw new ApplicationTransactionError(
            'insufficient-space',
            'Insufficient space while transferring staged content',
            { cause: error },
          )
        lastError = error
        pool.returnBrokenConnection(server)
      }
    }
  }
  if (!foundServers)
    throw new ApplicationTransactionError(
      'unavailable-resource',
      'No eligible Steam content servers are available',
      { cause: lastError },
    )
  if (
    lastError instanceof HttpStatusError &&
    (lastError.statusCode === 401 || lastError.statusCode === 403)
  )
    throw new ApplicationTransactionError(
      'steam',
      'Steam content authorization was exhausted',
      { cause: lastError },
    )
  if (lastError instanceof HttpStatusError && lastError.statusCode === 404)
    throw new ApplicationTransactionError(
      'unavailable-content',
      `Chunk ${destinations[0]!.chunk.sha} is unavailable`,
      { cause: lastError },
    )
  throw new ApplicationTransactionError(
    'transfer-exhausted',
    `Every eligible server failed for chunk ${destinations[0]!.chunk.sha}`,
    { cause: lastError },
  )
}

async function planCommitActions(
  outputDirectory: string,
  source: Map<string, ProjectionEntry>,
  target: Map<string, ProjectionEntry>,
  changed: ProjectionEntry[],
  staged: StagedFile[],
  backupRoot: string,
): Promise<
  Pick<TransactionJournal, 'oldMoves' | 'installs' | 'obsoleteDirectories'>
> {
  const changedKeys = new Set(changed.map((entry) => entry.key))
  const oldPaths = new Set<string>()

  for (const entry of source.values()) {
    if (isDirectory(entry.file)) continue
    const wanted = target.get(entry.key)
    if (!wanted) {
      if (isUserConfig(entry.file)) continue
      const info = await safeLstat(
        resolveOutputPath(outputDirectory, entry.file.filename),
      )
      if (info?.isSymbolicLink())
        throw new ApplicationTransactionError(
          'planning',
          `Managed path became a symbolic link: ${entry.file.filename}`,
        )
      if (!info || info.isDirectory()) continue
    }
    if (!wanted || isDirectory(wanted.file) || changedKeys.has(entry.key))
      oldPaths.add(normalizeManifestSeparators(entry.file.filename))
  }
  for (const entry of changed) {
    const path = resolveOutputPath(outputDirectory, entry.file.filename)
    const info = await safeLstat(path)
    if (!info) continue
    if (info.isSymbolicLink())
      throw new ApplicationTransactionError(
        'planning',
        `Target path is a symbolic link: ${entry.file.filename}`,
      )
    if (!isDirectory(entry.file) && info.isDirectory()) {
      await assertDirectoryIsManaged(
        outputDirectory,
        entry.file.filename,
        source,
      )
      oldPaths.add(normalizeManifestSeparators(entry.file.filename))
    } else if (isDirectory(entry.file) && !info.isDirectory()) {
      oldPaths.add(normalizeManifestSeparators(entry.file.filename))
    } else if (!isDirectory(entry.file)) {
      oldPaths.add(normalizeManifestSeparators(entry.file.filename))
    }
  }

  const roots = removeNestedPaths([...oldPaths])
  const oldMoves = roots.map((relativePath) => ({
    path: relativePath,
    backup: normalizeManifestSeparators(join('backup', relativePath)),
  }))
  const stagedByKey = new Map(staged.map((item) => [item.entry.key, item]))
  const installs: InstallAction[] = changed
    .sort(
      (left, right) =>
        pathDepth(left.file.filename) - pathDepth(right.file.filename),
    )
    .map((entry) => {
      const item = stagedByKey.get(entry.key)
      return {
        path: normalizeManifestSeparators(entry.file.filename),
        staging: item
          ? normalizeManifestSeparators(
              relative(resolve(dirname(backupRoot)), item.stagingPath),
            )
          : undefined,
        directory: isDirectory(entry.file),
        ...(!isDirectory(entry.file)
          ? {
              expectedSize: entry.file.size,
              expectedSha1: entry.file.sha_content.toLowerCase(),
            }
          : {}),
      }
    })
  const obsoleteDirectories = [...source.values()]
    .filter((entry) => isDirectory(entry.file) && !target.has(entry.key))
    .map((entry) => normalizeManifestSeparators(entry.file.filename))
    .sort((left, right) => pathDepth(right) - pathDepth(left))
  return { oldMoves, installs, obsoleteDirectories }
}

async function validateObstructions(
  outputDirectory: string,
  source: Map<string, ProjectionEntry>,
  changed: ProjectionEntry[],
): Promise<void> {
  for (const entry of changed) {
    const info = await safeLstat(
      resolveOutputPath(outputDirectory, entry.file.filename),
    )
    if (!info) continue
    if (info.isSymbolicLink())
      throw new ApplicationTransactionError(
        'planning',
        `Target path is a symbolic link: ${entry.file.filename}`,
      )
    if (!source.has(entry.key) && info.isDirectory() && !isDirectory(entry.file))
      await assertDirectoryIsManaged(
        outputDirectory,
        entry.file.filename,
        source,
      )
    if (!isDirectory(entry.file) && info.isDirectory())
      await assertDirectoryIsManaged(
        outputDirectory,
        entry.file.filename,
        source,
      )
  }
}

async function rollForward(
  transactionRoot: string,
  journalPath: string,
  initial: TransactionJournal,
  callbacks: Pick<
    RunApplicationTransactionOptions,
    'reconcile' | 'testCrashAt'
  >,
): Promise<void> {
  // Backups remain until local configuration and SQLite both reconcile.
  let journal = initial
  const outputDirectory = resolve(transactionRoot, '..', '..', '..')

  if (journal.phase === 'ready') {
    for (const action of journal.oldMoves) {
      const live = resolveOutputPath(outputDirectory, action.path)
      const backup = resolveManifestPath(transactionRoot, action.backup)
      if (await pathExists(backup)) continue
      const install = journal.installs.find((item) => item.path === action.path)
      if (
        install?.staging &&
        !(await pathExists(
          resolveManifestPath(transactionRoot, install.staging),
        ))
      )
        continue
      if (!(await pathExists(live))) continue
      await revalidateDestructivePath(outputDirectory, action.path)
      await mkdir(dirname(backup), { recursive: true })
      await rename(live, backup)
    }
    callbacks.testCrashAt?.('old-moved')

    let installed = 0
    for (const action of journal.installs) {
      const live = resolveOutputPath(outputDirectory, action.path)
      if (action.directory) {
        const info = await safeLstat(live)
        if (!info) await mkdir(live, { recursive: true })
        else if (!info.isDirectory() || info.isSymbolicLink())
          throw new ApplicationTransactionError(
            'recovery',
            `Cannot install directory at ${action.path}`,
          )
      } else {
        const staging = resolveManifestPath(transactionRoot, action.staging!)
        if (await pathExists(staging)) {
          await assertNoSymlinkTraversal(outputDirectory, action.path)
          await mkdir(dirname(live), { recursive: true })
          await rename(staging, live)
        } else {
          await verifyCommittedFile(live, action)
        }
      }
      installed++
      if (installed === 1) callbacks.testCrashAt?.('some-new-installed')
    }
    for (const path of journal.obsoleteDirectories) {
      await revalidateDestructivePath(outputDirectory, path)
      await rmdir(resolveOutputPath(outputDirectory, path)).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code ?? '')) throw error
      })
    }
    journal = { ...journal, phase: 'filesystem-committed' }
    await writeJournal(journalPath, journal)
    callbacks.testCrashAt?.('filesystem-committed')
  }

  if (journal.phase === 'filesystem-committed') {
    await callPersistence(
      callbacks.reconcile,
      journal.desired,
      'SQLite reconciliation',
    )
    journal = { ...journal, phase: 'sqlite-committed' }
    await writeJournal(journalPath, journal)
    callbacks.testCrashAt?.('sqlite-reconciled')
  }
  if (journal.phase === 'sqlite-committed') {
    journal = { ...journal, phase: 'completed' }
    await writeJournal(journalPath, journal)
  }
  if (journal.phase === 'completed')
    await rm(transactionRoot, { recursive: true, force: true })
}

async function recoverUnlocked(
  outputDirectory: string,
  callbacks: RecoverApplicationTransactionCallbacks,
): Promise<void> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw classify(
      error,
      'recovery',
      'Could not inspect application transactions',
    )
  }
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory())
      throw new ApplicationTransactionError(
        'recovery',
        `Unexpected transaction entry: ${entry.name}`,
      )
    const transactionRoot = join(root, entry.name)
    const journalPath = join(transactionRoot, 'journal.json')
    let journal: TransactionJournal
    try {
      journal = await readJournal(journalPath)
    } catch (error) {
      if (
        !(await pathExists(join(transactionRoot, 'commit-ready'))) &&
        !(await pathExists(join(transactionRoot, 'backup')))
      ) {
        await rm(transactionRoot, { recursive: true, force: true })
        continue
      }
      throw error
    }
    if (journal.id !== entry.name)
      throw new ApplicationTransactionError(
        'recovery',
        'Transaction journal ID mismatch',
      )
    assertJournalIdentity(journal, callbacks.appId, outputDirectory)
    if (journal.phase === 'staging') {
      continue
    }
    try {
      // Once commit was ready, recovery always rolls forward deterministically.
      await rollForward(transactionRoot, journalPath, journal, callbacks)
    } catch (error) {
      if (error instanceof ApplicationTransactionError) throw error
      throw classify(
        error,
        'recovery',
        `Could not recover transaction ${entry.name}`,
      )
    }
  }
}

function buildProjection(
  depots: InstalledApplicationDepot[],
  defaultAppId: number,
): Map<string, ProjectionEntry> {
  const projection = new Map<string, ProjectionEntry>()
  const depotIds = new Set<number>()
  for (const depot of depots) {
    validateDepot(depot, defaultAppId)
    if (depotIds.has(depot.depotId))
      throw new Error(`Duplicate depot ${depot.depotId}`)
    depotIds.add(depot.depotId)
    for (const file of withImpliedDirectories(depot.manifest.files)) {
      const key = manifestPathKey(file.filename)
      projection.set(key, { depot, file, key })
    }
  }
  for (const [key] of projection) {
    let separator = key.lastIndexOf('/')
    while (separator !== -1) {
      const parent = projection.get(key.slice(0, separator))
      if (parent && !isDirectory(parent.file)) {
        projection.delete(key)
        break
      }
      separator = key.lastIndexOf('/', separator - 1)
    }
  }
  return projection
}

function assertJournalIdentity(
  journal: TransactionJournal,
  expectedAppId: number,
  outputDirectory: string,
): void {
  if (
    journal.appId !== expectedAppId ||
    journal.installPath !== resolve(outputDirectory)
  )
    throw new ApplicationTransactionError(
      'recovery',
      'Transaction journal does not belong to this application installation',
    )
}

function validateDepot(
  depot: InstalledApplicationDepot,
  defaultAppId: number,
): void {
  if (!Number.isSafeInteger(depot.depotId) || depot.depotId < 0)
    throw new Error(`Invalid depot ID ${depot.depotId}`)
  if (depot.manifest.depot_id !== depot.depotId)
    throw new Error(`Manifest does not belong to depot ${depot.depotId}`)
  if (!Number.isSafeInteger(depot.appId ?? defaultAppId))
    throw new Error('Invalid app ID')
  for (const file of depot.manifest.files) {
    if (file.flags & SYMLINK)
      throw new Error(
        `Manifest symbolic links are unavailable: ${file.filename}`,
      )
    fileSize(file)
  }
}

function validateDesiredDepots(depots: DesiredApplicationDepot[]): void {
  for (const depot of depots) {
    if (!depot.client)
      throw new Error(`Depot ${depot.depotId} has no chunk client`)
  }
}

function desiredRecords(
  depots: InstalledApplicationDepot[],
): ApplicationDepotRecord[] {
  return depots.map((depot, mountIndex) => ({
    depotId: depot.depotId,
    manifestId: depot.manifest.gid_manifest,
    mountIndex,
    ownerAppId: depot.ownerAppId ?? depot.appId,
  }))
}

function filesystemChangesNeeded(
  source: Map<string, ProjectionEntry>,
  target: Map<string, ProjectionEntry>,
): boolean {
  for (const [key] of source) if (!target.has(key)) return true
  return false
}

function buildChunkCandidates(
  source: Map<string, ProjectionEntry>,
  outputDirectory: string,
): Map<string, { path: string; file: ManifestFile; chunk: ManifestChunk }[]> {
  const result = new Map<
    string,
    { path: string; file: ManifestFile; chunk: ManifestChunk }[]
  >()
  for (const entry of source.values()) {
    if (isDirectory(entry.file)) continue
    const path = resolveOutputPath(outputDirectory, entry.file.filename)
    for (const chunk of entry.file.chunks) {
      const key = chunkKey(chunk)
      const group = result.get(key) ?? []
      group.push({ path, file: entry.file, chunk })
      result.set(key, group)
    }
  }
  return result
}

async function reusableChunk(
  candidates: { path: string; file: ManifestFile; chunk: ManifestChunk }[],
  signal?: AbortSignal,
): Promise<
  | { path: string; file: ManifestFile; chunk: ManifestChunk; data: Buffer }
  | undefined
> {
  for (const candidate of candidates) {
    throwIfAborted(signal)
    try {
      const data = await readChunk(candidate.path, candidate.chunk)
      if (
        createHash('sha1').update(data).digest('hex') ===
        candidate.chunk.sha.toLowerCase()
      )
        return { ...candidate, data }
    } catch (error) {
      if (
        isFilesystemError(error) &&
        !['ENOENT', 'ENOTDIR', 'EISDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
    }
  }
  return undefined
}

async function readChunk(path: string, chunk: ManifestChunk): Promise<Buffer> {
  const data = Buffer.alloc(Number(chunk.cb_original))
  const handle = await open(path, 'r')
  try {
    let read = 0
    while (read < data.length) {
      const result = await handle.read(
        data,
        read,
        data.length - read,
        Number(chunk.offset) + read,
      )
      if (result.bytesRead === 0)
        throw new ApplicationTransactionError(
          'integrity',
          `Could not read reusable chunk ${chunk.sha}`,
        )
      read += result.bytesRead
    }
  } finally {
    await handle.close()
  }
  return data
}

function uniqueResources(destinations: ChunkDestination[]) {
  const resources = new Map<
    string,
    { depot: DesiredApplicationDepot; appId: number }
  >()
  for (const destination of destinations) {
    const appId = destination.appId
    resources.set(`${appId}:${destination.depot.depotId}`, {
      depot: destination.depot,
      appId,
    })
  }
  return [...resources.values()]
}

async function assertDirectoryIsManaged(
  outputDirectory: string,
  filename: string,
  source: Map<string, ProjectionEntry>,
): Promise<void> {
  const root = resolveOutputPath(outputDirectory, filename)
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = normalizeManifestSeparators(
        relative(outputDirectory, path),
      )
      if (!source.has(manifestPathKey(relativePath)))
        throw new ApplicationTransactionError(
          'planning',
          `Cannot replace directory containing unrelated path: ${relativePath}`,
        )
      if (entry.isSymbolicLink())
        throw new ApplicationTransactionError(
          'planning',
          `Cannot replace directory containing symbolic link: ${relativePath}`,
        )
      if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(root)
}

async function revalidateDestructivePath(
  outputDirectory: string,
  filename: string,
): Promise<void> {
  // Another local process can still swap a path after lstat; the output lock is
  // the coordination boundary because Node exposes no portable renameat2-style API.
  await assertNoSymlinkTraversal(outputDirectory, filename)
  const path = resolveOutputPath(outputDirectory, filename)
  const info = await safeLstat(path)
  if (info?.isSymbolicLink())
    throw new ApplicationTransactionError(
      'filesystem',
      `Destructive path became a symbolic link: ${filename}`,
    )
}

async function assertSpace(path: string, required: bigint): Promise<void> {
  try {
    const info = await statfs(path, { bigint: true })
    const available = info.bavail * info.bsize
    if (required > available)
      throw new ApplicationTransactionError(
        'insufficient-space',
        `Staging requires ${required} bytes but only ${available} are available`,
      )
  } catch (error) {
    if (error instanceof ApplicationTransactionError) throw error
    // statfs is best-effort; actual allocation still reports ENOSPC.
  }
}

function stagedFileLayout(entries: ProjectionEntry[]): StagedFileLayout[] {
  return entries.map(({ file }) => ({
    path: normalizeManifestSeparators(file.filename),
    size: file.size,
    sha1: file.sha_content.toLowerCase(),
    chunks: file.chunks.map((chunk) => ({
      key: chunkKey(chunk),
      offset: chunk.offset,
      size: chunk.cb_original,
    })),
  }))
}

async function loadResumableJournal(
  options: RunApplicationTransactionOptions,
  expected: Pick<TransactionJournal, 'source' | 'desired' | 'stagedFiles'>,
): Promise<TransactionJournal | undefined> {
  const root = join(
    options.outputDirectory,
    CONFIG_DIRECTORY,
    'transactions',
  )
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (entries.length === 0) return undefined
  if (entries.length !== 1 || !entries[0]!.isDirectory())
    throw new ApplicationTransactionError(
      'recovery',
      'Application has ambiguous pending transaction state',
    )
  const transactionRoot = join(root, entries[0]!.name)
  let journal: TransactionJournal
  try {
    journal = await readJournal(join(transactionRoot, 'journal.json'))
  } catch {
    await rm(transactionRoot, { recursive: true, force: true })
    return undefined
  }
  if (journal.phase !== 'staging')
    throw new ApplicationTransactionError(
      'recovery',
      'Commit-ready transaction must be reconciled before resuming',
    )
  const matches =
    journal.id === entries[0]!.name &&
    journal.appId === options.appId &&
    journal.kind === options.kind &&
    journal.installPath === resolve(options.outputDirectory) &&
    JSON.stringify(journal.source) === JSON.stringify(expected.source) &&
    JSON.stringify(journal.desired) === JSON.stringify(expected.desired) &&
    JSON.stringify(journal.stagedFiles) === JSON.stringify(expected.stagedFiles)
  if (!matches || !(await validateStagingLedger(transactionRoot, journal))) {
    await rm(transactionRoot, { recursive: true, force: true })
    return undefined
  }
  return journal
}

async function validateStagingLedger(
  transactionRoot: string,
  journal: TransactionJournal,
): Promise<boolean> {
  const chunks = new Set(
    journal.stagedFiles.flatMap((file) => file.chunks.map(({ key }) => key)),
  )
  if (Object.keys(journal.completedChunks).some((key) => !chunks.has(key)))
    return false
  for (const file of journal.stagedFiles) {
    const info = await safeLstat(
      resolveManifestPath(join(transactionRoot, 'staging'), file.path),
    )
    if (!info?.isFile() || BigInt(info.size) !== BigInt(file.size)) return false
  }
  return true
}

async function stagedAllocatedBytes(
  outputDirectory: string,
  journal: TransactionJournal,
): Promise<bigint> {
  const stagingRoot = join(
    outputDirectory,
    CONFIG_DIRECTORY,
    'transactions',
    journal.id,
    'staging',
  )
  let allocated = 0n
  for (const file of journal.stagedFiles) {
    const info = await lstat(resolveManifestPath(stagingRoot, file.path))
    const blocks = Number.isSafeInteger(info.blocks) ? BigInt(info.blocks) : 0n
    const size = BigInt(file.size)
    const physical = blocks * 512n
    allocated += physical < size ? physical : size
  }
  return allocated
}

async function completeChunk(
  context: JournalContext,
  key: string,
  source: CompletionRecord['source'],
  networkBytes: number,
): Promise<void> {
  context.journal = {
    ...context.journal,
    completedChunks: {
      ...context.journal.completedChunks,
      [key]: { source, networkBytes: String(networkBytes) },
    },
  }
  await checkpointJournal(context)
}

async function checkpointJournal(context: JournalContext): Promise<void> {
  context.write = context.write.then(() =>
    writeJournal(context.path, context.journal),
  )
  await context.write
}

async function writeJournal(
  path: string,
  journal: TransactionJournal,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  const contents = `${JSON.stringify(journal, null, 2)}\n`
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readJournal(path: string): Promise<TransactionJournal> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ApplicationTransactionError(
      'recovery',
      `Malformed journal ${path}`,
      {
        cause: error,
      },
    )
  }
  if (!isJournal(parsed))
    throw new ApplicationTransactionError(
      'recovery',
      `Malformed journal ${path}`,
    )
  return parsed
}

function isJournal(value: unknown): value is TransactionJournal {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<TransactionJournal>
  const phases: JournalPhase[] = [
    'staging',
    'ready',
    'filesystem-committed',
    'sqlite-committed',
    'completed',
  ]
  return (
    item.version === TRANSACTION_VERSION &&
    typeof item.id === 'string' &&
    typeof item.generation === 'string' &&
    Number.isSafeInteger(item.appId) &&
    ['download', 'reconcile', 'repair'].includes(item.kind ?? '') &&
    typeof item.installPath === 'string' &&
    typeof item.paused === 'boolean' &&
    phases.includes(item.phase as JournalPhase) &&
    Array.isArray(item.source) &&
    item.source.every(isDepotRecord) &&
    Array.isArray(item.desired) &&
    item.desired.every(isDepotRecord) &&
    Array.isArray(item.stagedFiles) &&
    item.stagedFiles.every(isStagedFileLayout) &&
    Boolean(item.completedChunks) &&
    typeof item.completedChunks === 'object' &&
    !Array.isArray(item.completedChunks) &&
    Object.values(item.completedChunks ?? {}).every(isCompletionRecord) &&
    typeof item.logicalInstalledTotal === 'string' &&
    /^\d+$/u.test(item.logicalInstalledTotal) &&
    typeof item.retainedBytes === 'string' &&
    /^\d+$/u.test(item.retainedBytes) &&
    Array.isArray(item.oldMoves) &&
    item.oldMoves.every(
      (action) =>
        action &&
        typeof action.path === 'string' &&
        typeof action.backup === 'string' &&
        safeJournalPath(action.path) &&
        safeJournalPath(action.backup),
    ) &&
    Array.isArray(item.installs) &&
    item.installs.every(
      (action) =>
        action &&
        typeof action.path === 'string' &&
        typeof action.directory === 'boolean' &&
        (action.staging === undefined || typeof action.staging === 'string') &&
        (action.expectedSize === undefined ||
          (typeof action.expectedSize === 'string' &&
            /^\d+$/u.test(action.expectedSize))) &&
        (action.expectedSha1 === undefined ||
          (typeof action.expectedSha1 === 'string' &&
            /^[0-9a-f]{40}$/u.test(action.expectedSha1))) &&
        safeJournalPath(action.path) &&
        (action.staging === undefined || safeJournalPath(action.staging)),
    ) &&
    Array.isArray(item.obsoleteDirectories) &&
    item.obsoleteDirectories.every(
      (path) => typeof path === 'string' && safeJournalPath(path),
    )
  )
}

function isStagedFileLayout(value: unknown): value is StagedFileLayout {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<StagedFileLayout>
  return (
    typeof item.path === 'string' &&
    safeJournalPath(item.path) &&
    typeof item.size === 'string' &&
    /^\d+$/u.test(item.size) &&
    typeof item.sha1 === 'string' &&
    /^[0-9a-f]{40}$/u.test(item.sha1) &&
    Array.isArray(item.chunks) &&
    item.chunks.every(
      (chunk) =>
        chunk &&
        typeof chunk.key === 'string' &&
        typeof chunk.offset === 'string' &&
        /^\d+$/u.test(chunk.offset) &&
        Number.isSafeInteger(chunk.size) &&
        chunk.size >= 0,
    )
  )
}

function isCompletionRecord(value: unknown): value is CompletionRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<CompletionRecord>
  return (
    (item.source === 'local' || item.source === 'network') &&
    typeof item.networkBytes === 'string' &&
    /^\d+$/u.test(item.networkBytes)
  )
}

function safeJournalPath(path: string): boolean {
  if (!path || path.includes('\0')) return false
  const normalized = normalizeManifestSeparators(path)
  return !normalized.startsWith('/') && !normalized.split('/').includes('..')
}

function isDepotRecord(value: unknown): value is ApplicationDepotRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ApplicationDepotRecord>
  return (
    Number.isSafeInteger(item.depotId) &&
    typeof item.manifestId === 'string' &&
    /^\d+$/u.test(item.manifestId) &&
    Number.isSafeInteger(item.mountIndex) &&
    (item.mountIndex ?? -1) >= 0 &&
    (item.ownerAppId === undefined || Number.isSafeInteger(item.ownerAppId))
  )
}

async function callPersistence(
  callback: (desired: ApplicationDepotRecord[]) => Promise<void>,
  desired: ApplicationDepotRecord[],
  name: string,
): Promise<void> {
  try {
    await callback(desired)
  } catch (error) {
    throw new ApplicationTransactionError(
      'persistence',
      `Could not commit ${name}`,
      { cause: error },
    )
  }
}

function emitProgress(
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

function sumProjectionFiles(projection: Map<string, ProjectionEntry>): bigint {
  let total = 0n
  for (const entry of projection.values())
    if (!isDirectory(entry.file)) total += BigInt(entry.file.size)
  return total
}

function removeNestedPaths(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort(
    (left, right) => pathDepth(left) - pathDepth(right),
  )
  return sorted.filter(
    (path, index) =>
      !sorted.slice(0, index).some((parent) => path.startsWith(`${parent}/`)),
  )
}

function fileSize(file: ManifestFile): number {
  const size = Number(file.size)
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error(`Invalid size for ${file.filename}`)
  return size
}

function chunkKey(chunk: ManifestChunk): string {
  return `${chunk.sha.toLowerCase()}:${chunk.cb_original}`
}

function isDirectory(file: ManifestFile): boolean {
  return Boolean(file.flags & DIRECTORY)
}

function isUserConfig(file: ManifestFile): boolean {
  return Boolean(file.flags & USER_CONFIG)
}

function isConfigFile(file: ManifestFile): boolean {
  return Boolean(file.flags & (USER_CONFIG | VERSIONED_USER_CONFIG))
}

function sameManifestOwner(
  previous: ProjectionEntry | undefined,
  target: ProjectionEntry,
): boolean {
  return (
    previous?.depot.depotId === target.depot.depotId &&
    previous.depot.manifest.gid_manifest === target.depot.manifest.gid_manifest
  )
}

async function verifyCommittedFile(
  path: string,
  action: InstallAction,
): Promise<void> {
  const info = await safeLstat(path)
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    action.expectedSize === undefined ||
    BigInt(info.size) !== BigInt(action.expectedSize) ||
    action.expectedSha1 === undefined
  )
    throw new ApplicationTransactionError(
      'recovery',
      `Installed file identity is uncertain for ${action.path}`,
    )
  try {
    await verifyFileSha1(path, action.expectedSha1)
  } catch (error) {
    throw new ApplicationTransactionError(
      'recovery',
      `Installed file identity is uncertain for ${action.path}`,
      { cause: error },
    )
  }
}

function executableModeMatches(mode: number, file: ManifestFile): boolean {
  if (process.platform === 'win32') return true
  return Boolean(mode & 0o111) === Boolean(file.flags & EXECUTABLE)
}

function pathDepth(path: string): number {
  return normalizeManifestSeparators(path).split('/').length
}

function networkByteCount(value: number | undefined, fallback: number): number {
  const bytes = value ?? fallback
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new ApplicationTransactionError(
      'unavailable-content',
      'Content server returned an invalid network byte count',
    )
  return bytes
}

async function safeLstat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return undefined
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await safeLstat(path))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof ApplicationTransactionError) throw signal.reason
  throw new ApplicationTransactionError(
    'cancellation',
    'Transaction cancelled',
    {
      cause: signal.reason,
    },
  )
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof ApplicationTransactionError &&
      error.kind === 'cancellation') ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function isPause(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.reason instanceof Error &&
    signal.reason.name === 'PauseError' &&
    (error === signal.reason || isAbort(error, signal))
  )
}

function isShutdown(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.reason instanceof Error &&
    signal.reason.name === 'ShutdownError' &&
    (error === signal.reason || isAbort(error, signal))
  )
}

function isFilesystemError(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException)?.code === 'string'
}

function classify(
  error: unknown,
  kind: ApplicationTransactionErrorKind,
  message: string,
): ApplicationTransactionError {
  if (error instanceof ApplicationTransactionError) return error
  if (isAbort(error))
    return new ApplicationTransactionError(
      'cancellation',
      'Transaction cancelled',
      {
        cause: error,
      },
    )
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC')
    return new ApplicationTransactionError('insufficient-space', message, {
      cause: error,
    })
  return new ApplicationTransactionError(kind, message, { cause: error })
}
