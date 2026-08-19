import { randomUUID } from 'node:crypto'
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { manifestPathKey } from '../../manifests/manifest-utils.ts'
import { CONFIG_DIRECTORY } from '../internal-paths.ts'
import { acquireOutputLock } from '../output-lock.ts'
import { resolveOutputPath } from '../filesystem.ts'
import {
  planCommitActions,
  rollForward,
  validateObstructions,
} from './commit.ts'
import {
  TRANSACTION_VERSION,
  callPersistence,
  checkpointJournal,
  loadResumableJournal,
  stagedAllocatedBytes,
  writeJournal,
} from './journal.ts'
import {
  buildProjection,
  desiredRecords,
  filesystemChangesNeeded,
  isDirectory,
  sameManifestOwner,
  stagedFileLayout,
  sumProjectionFiles,
  uniqueCompressedChunkSizes,
  validateDesiredDepots,
} from './projection.ts'
import { projectionEntryNeedsStaging } from './local-state.ts'
import { recoverUnlocked } from './recovery.ts'
import { prepareStagedFiles } from './staging.ts'
import {
  ApplicationTransactionError,
  classify,
  emitProgress,
  isAbort,
  filesystemErrorCode,
  isFilesystemError,
  isPause,
  isShutdown,
  throwIfAborted,
  type ApplicationTransactionResult,
  type JournalContext,
  type ProgressState,
  type ProjectionEntry,
  type RecoverApplicationTransactionCallbacks,
  type RunApplicationTransactionOptions,
  type TransactionJournal,
} from './types.ts'

export async function runApplicationTransaction(
  options: RunApplicationTransactionOptions,
): Promise<ApplicationTransactionResult> {
  return withTransactionLock(options, () => runUnlocked(options))
}

export async function recoverAndRunApplicationTransaction(
  options: RunApplicationTransactionOptions,
): Promise<ApplicationTransactionResult> {
  return withTransactionLock(options, async () => {
    const recoveryOptions: RecoverApplicationTransactionCallbacks = {
      appId: options.appId,
      reconcile: options.reconcile,
    }
    if (options.testCrashAt) recoveryOptions.testCrashAt = options.testCrashAt
    await recoverUnlocked(options.outputDirectory, recoveryOptions)
    return runUnlocked(options)
  })
}

async function withTransactionLock<T>(
  options: Pick<
    RunApplicationTransactionOptions,
    'outputDirectory' | 'acquireLock'
  >,
  action: () => Promise<T>,
): Promise<T> {
  const acquire = options.acquireLock ?? acquireOutputLock
  const release = await acquire(options.outputDirectory).catch((error) => {
    throw classify(error, 'filesystem', 'Could not acquire output lock')
  })
  let result: T
  let releaseError: unknown
  try {
    result = await action()
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

async function runUnlocked(
  options: RunApplicationTransactionOptions,
): Promise<ApplicationTransactionResult> {
  options.onEvent?.({ type: 'phase', phase: 'planning' })
  throwIfAborted(options.signal)

  const { source, target } = buildValidatedProjections(options)
  const sourceRecords = desiredRecords(options.installedDepots)
  const desired = desiredRecords(options.desiredDepots)
  const resumed = await loadResumableJournal(
    options,
    { source: sourceRecords, desired },
    target,
    options.kind === 'repair'
      ? (journal) => retainedRepairFilesMatch(options, source, target, journal)
      : undefined,
  )
  const retainedBytes = resumed ? BigInt(resumed.retainedBytes) : 0n
  const progress: ProgressState = {
    logicalInstalledCompleted: retainedBytes,
    logicalInstalledTotal: sumProjectionFiles(target),
    reusedLocal: retainedBytes,
    actualNetwork: 0n,
    estimatedDownload: null,
  }
  emitProgress(options, progress)
  if (options.kind === 'repair')
    options.onEvent?.({ type: 'phase', phase: 'verifying' })

  const changed = await findChangedEntries(
    options,
    source,
    target,
    progress,
    resumed,
  )
  const changedFiles = changed.filter((entry) => !isDirectory(entry.file))
  progress.estimatedDownload = [
    ...uniqueCompressedChunkSizes(changedFiles).values(),
  ].reduce((total, size) => total + BigInt(size), 0n)
  emitProgress(options, progress)
  if (changed.length === 0 && !filesystemChangesNeeded(source, target)) {
    options.onEvent?.({ type: 'phase', phase: 'reconciling' })
    await callPersistence(options.reconcile, desired, 'SQLite reconciliation')
    options.onEvent?.({ type: 'phase', phase: 'completed' })
    return {
      transactionId: null,
      logicalInstalledBytes: progress.logicalInstalledTotal.toString(),
      reusedLocalBytes: progress.reusedLocal.toString(),
      networkBytes: '0',
      estimatedDownloadBytes: '0',
    }
  }

  const transaction = await prepareTransaction(
    options,
    source,
    target,
    changed,
    changedFiles,
    progress,
    resumed,
  )
  return executeTransaction(
    options,
    source,
    target,
    changed,
    changedFiles,
    progress,
    transaction,
  )
}

async function retainedRepairFilesMatch(
  options: RunApplicationTransactionOptions,
  source: Map<string, ProjectionEntry>,
  target: Map<string, ProjectionEntry>,
  journal: TransactionJournal,
): Promise<boolean> {
  const staged = new Set(
    journal.stagedFiles.map(({ path }) => manifestPathKey(path)),
  )
  for (const [key, entry] of target) {
    if (isDirectory(entry.file) || staged.has(key)) continue
    if (await entryNeedsStaging(options, entry, source.get(key))) return false
  }
  return true
}

function buildValidatedProjections(options: RunApplicationTransactionOptions) {
  try {
    const source = buildProjection(options.installedDepots, options.appId)
    const target = buildProjection(options.desiredDepots, options.appId)
    validateDesiredDepots(options.desiredDepots)
    for (const entry of target.values())
      resolveOutputPath(options.outputDirectory, entry.file.filename)
    return { source, target }
  } catch (error) {
    throw classify(error, 'planning', 'Could not build application projection')
  }
}

async function findChangedEntries(
  options: RunApplicationTransactionOptions,
  source: Map<string, ProjectionEntry>,
  target: Map<string, ProjectionEntry>,
  progress: ProgressState,
  resumed?: TransactionJournal,
): Promise<ProjectionEntry[]> {
  if (resumed) {
    const changedFiles = resumed.stagedFiles.map(({ path }) =>
      target.get(manifestPathKey(path))!,
    )
    const directories = new Map(
      [...target].filter(([, entry]) => isDirectory(entry.file)),
    )
    return [
      ...changedFiles,
      ...(await findChangedEntries(options, source, directories, progress)),
    ]
  }
  const changed: ProjectionEntry[] = []
  for (const entry of target.values()) {
    const previous = source.get(entry.key)
    if (await entryNeedsStaging(options, entry, previous)) {
      changed.push(entry)
      continue
    }
    if (!isDirectory(entry.file) || sameManifestOwner(previous, entry)) {
      const size = BigInt(entry.file.size)
      progress.logicalInstalledCompleted += size
      progress.reusedLocal += size
      emitProgress(options, progress)
    }
  }
  return changed
}

async function entryNeedsStaging(
  options: RunApplicationTransactionOptions,
  entry: ProjectionEntry,
  previous?: ProjectionEntry,
): Promise<boolean> {
  try {
    return await projectionEntryNeedsStaging(
      entry,
      previous,
      options.outputDirectory,
      options.kind,
      options.signal,
    )
  } catch (error) {
    if (isFilesystemError(error))
      throw classify(
        error,
        'filesystem',
        `Could not verify ${entry.file.filename}`,
      )
    throw error
  }
}

interface PreparedTransaction {
  id: string
  transactionRoot: string
  stagingRoot: string
  backupRoot: string
  journalPath: string
  journalContext: JournalContext
}

interface TransactionFailure {
  cause: unknown
}

async function prepareTransaction(
  options: RunApplicationTransactionOptions,
  source: Map<string, ProjectionEntry>,
  target: Map<string, ProjectionEntry>,
  changed: ProjectionEntry[],
  changedFiles: ProjectionEntry[],
  progress: ProgressState,
  resumed: TransactionJournal | undefined,
): Promise<PreparedTransaction> {
  const sourceRecords = desiredRecords(options.installedDepots)
  const desired = desiredRecords(options.desiredDepots)
  const stagedFiles = stagedFileLayout(changedFiles)
  const requiredBytes = changedFiles.reduce(
    (sum, entry) => sum + BigInt(entry.file.size),
    0n,
  )
  await validateObstructions(options.outputDirectory, source, changed)
  if (resumed) {
    const compressedSizes = uniqueCompressedChunkSizes(changedFiles)
    progress.estimatedDownload =
      resumed.estimatedDownloadBytes === undefined
        ? [...compressedSizes].reduce(
            (total, [key, size]) =>
              resumed.completedChunks[key]?.source === 'local'
                ? total - BigInt(size)
                : total,
            progress.estimatedDownload ?? 0n,
          )
        : BigInt(resumed.estimatedDownloadBytes)
  }
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
  const journal: TransactionJournal = resumed
    ? {
        ...resumed,
        estimatedDownloadBytes: progress.estimatedDownload?.toString(),
      }
    : {
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
        estimatedDownloadBytes: progress.estimatedDownload?.toString(),
        retainedBytes: progress.logicalInstalledCompleted.toString(),
        retainedFileCount:
          [...target.values()].filter((entry) => !isDirectory(entry.file))
            .length - stagedFiles.length,
        oldMoves: [],
        installs: [],
        obsoleteDirectories: [],
      }
  const journalContext: JournalContext = {
    journal,
    path: journalPath,
    write: Promise.resolve(),
    resumed: resumed !== undefined,
  }
  return {
    id,
    transactionRoot,
    stagingRoot,
    backupRoot,
    journalPath,
    journalContext,
  }
}

async function executeTransaction(
  options: RunApplicationTransactionOptions,
  source: Map<string, ProjectionEntry>,
  target: Map<string, ProjectionEntry>,
  changed: ProjectionEntry[],
  changedFiles: ProjectionEntry[],
  progress: ProgressState,
  transaction: PreparedTransaction,
): Promise<ApplicationTransactionResult> {
  const {
    id,
    transactionRoot,
    stagingRoot,
    backupRoot,
    journalPath,
    journalContext,
  } = transaction
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
    const journal: TransactionJournal = {
      ...journalContext.journal,
      ...actions,
      phase: 'ready',
    }
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
      estimatedDownloadBytes: progress.estimatedDownload?.toString() ?? '0',
    }
  } catch (error) {
    const failure: TransactionFailure = { cause: error }
    await cleanupInterruptedStaging(
      options,
      transactionRoot,
      journalContext,
      failure,
    )
    throwTransactionFailure(options, failure)
  }
}

async function cleanupInterruptedStaging(
  options: RunApplicationTransactionOptions,
  transactionRoot: string,
  journalContext: JournalContext,
  failure: TransactionFailure,
): Promise<void> {
  if (journalContext.journal.phase !== 'staging') return
  if (
    isAbort(failure.cause, options.signal) &&
    !isPause(failure.cause, options.signal) &&
    !isShutdown(failure.cause, options.signal)
  ) {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => {})
    return
  }
  journalContext.journal = {
    ...journalContext.journal,
    paused: isPause(failure.cause, options.signal),
  }
  try {
    await checkpointJournal(journalContext)
  } catch (checkpointError) {
    throw classify(
      checkpointError,
      'filesystem',
      'Could not checkpoint interrupted staging',
    )
  }
}

function throwTransactionFailure(
  options: RunApplicationTransactionOptions,
  failure: TransactionFailure,
): never {
  if (failure.cause instanceof ApplicationTransactionError) throw failure.cause
  if (isAbort(failure.cause, options.signal))
    throw new ApplicationTransactionError(
      'cancellation',
      'Transaction cancelled',
      { cause: failure.cause },
    )
  if (filesystemErrorCode(failure.cause) === 'ENOSPC')
    throw new ApplicationTransactionError(
      'insufficient-space',
      'Insufficient space while staging application',
      { cause: failure.cause },
    )
  throw classify(failure.cause, 'filesystem', 'Application transaction failed')
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
