import { randomUUID } from 'node:crypto'
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CONFIG_DIRECTORY } from '../internal-paths.ts'
import { acquireOutputLock } from '../output-lock.ts'
import { resolveOutputPath, verifyFileSha1 } from '../filesystem.ts'
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
  executableModeMatches,
  filesystemChangesNeeded,
  isConfigFile,
  isDirectory,
  isUserConfig,
  safeLstat,
  sameManifestOwner,
  stagedFileLayout,
  sumProjectionFiles,
  validateDesiredDepots,
} from './projection.ts'
import { recoverUnlocked } from './recovery.ts'
import { prepareStagedFiles } from './staging.ts'
import {
  ApplicationTransactionError,
  classify,
  emitProgress,
  isAbort,
  isFilesystemError,
  isPause,
  isShutdown,
  throwIfAborted,
  type ApplicationTransactionResult,
  type JournalContext,
  type ProgressState,
  type ProjectionEntry,
  type RunApplicationTransactionOptions,
  type TransactionJournal,
} from './types.ts'

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
  let journal: TransactionJournal = resumed ?? {
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
  const journalContext: JournalContext = {
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
    }
    if (error instanceof ApplicationTransactionError) throw error
    if (isAbort(error, options.signal))
      throw new ApplicationTransactionError(
        'cancellation',
        'Transaction cancelled',
        { cause: error },
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
