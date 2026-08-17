import type { Dirent } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_DIRECTORY } from '../internal-paths.ts'
import { acquireOutputLock } from '../output-lock.ts'
import { rollForward } from './commit.ts'
import { assertJournalIdentity, readJournal } from './journal.ts'
import { pathExists } from './projection.ts'
import {
  ApplicationTransactionError,
  classify,
  filesystemErrorCode,
  type ApplicationDepotRecord,
  type RecoverApplicationTransactionCallbacks,
  type ResumableApplicationTransaction,
  type TransactionJournal,
} from './types.ts'

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

export async function recoverUnlocked(
  outputDirectory: string,
  callbacks: RecoverApplicationTransactionCallbacks,
): Promise<void> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entry: Dirent | undefined
  try {
    entry = transactionDirectory(await readDirectoryIfExists(root))
  } catch (error) {
    throw classify(
      error,
      'recovery',
      'Could not inspect application transactions',
    )
  }
  if (!entry) return
  await recoverTransaction(root, entry, outputDirectory, callbacks)
}

async function recoverTransaction(
  root: string,
  entry: Dirent,
  outputDirectory: string,
  callbacks: RecoverApplicationTransactionCallbacks,
): Promise<void> {
  const transactionRoot = join(root, entry.name)
  const journalPath = join(transactionRoot, 'journal.json')
  const journal = await readRecoverableJournal(transactionRoot, journalPath)
  if (!journal) return
  if (journal.id !== entry.name)
    throw new ApplicationTransactionError(
      'recovery',
      'Transaction journal ID mismatch',
    )
  assertJournalIdentity(journal, callbacks.appId, outputDirectory)
  if (journal.phase === 'staging') return
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

async function readRecoverableJournal(
  transactionRoot: string,
  journalPath: string,
): Promise<TransactionJournal | undefined> {
  try {
    return await readJournal(journalPath)
  } catch (error) {
    if (
      !(await pathExists(join(transactionRoot, 'commit-ready'))) &&
      !(await pathExists(join(transactionRoot, 'backup')))
    ) {
      await rm(transactionRoot, { recursive: true, force: true })
      return undefined
    }
    throw error
  }
}

export async function getResumableApplicationTransaction(
  outputDirectory: string,
  expectedAppId: number,
): Promise<ResumableApplicationTransaction | null> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  const entry = transactionDirectory(await readDirectoryIfExists(root))
  if (!entry) return null
  const journal = await readJournal(join(root, entry.name, 'journal.json'))
  assertJournalIdentity(journal, expectedAppId, outputDirectory)
  if (journal.phase !== 'staging') return null
  const progress = reconstructProgress(journal)
  return {
    appId: journal.appId,
    kind: journal.kind,
    installPath: journal.installPath,
    desiredDepotIds: journal.desired.map(({ depotId }) => depotId),
    desired: journal.desired,
    paused: journal.paused,
    installedBytesCompleted: progress.completed.toString(),
    installedBytesTotal: journal.logicalInstalledTotal,
    reusedLocalBytes: progress.reused.toString(),
    networkBytes: progress.network.toString(),
  }
}

function reconstructProgress(journal: TransactionJournal) {
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
  return { completed, reused, network }
}

export async function hasCommitReadyApplicationTransaction(
  outputDirectory: string,
): Promise<boolean> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return false
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
    if (filesystemErrorCode(error) === 'ENOENT')
      return readRepairFallbackDesired(outputDirectory)
    throw error
  }
  const pending = entries.filter((candidate) => candidate.isDirectory())
  if (pending.length === 0) return readRepairFallbackDesired(outputDirectory)
  let desired: ApplicationDepotRecord[] | null = null
  if (pending.length === 1)
    try {
      desired = (
        await readJournal(join(root, pending[0]!.name, 'journal.json'))
      ).desired
    } catch {
      // Repair falls back to the installed version while preserving evidence.
    }
  const archiveRoot = join(outputDirectory, CONFIG_DIRECTORY, 'repair-fallback')
  await mkdir(archiveRoot, { recursive: true })
  for (const entry of pending)
    await rename(join(root, entry.name), join(archiveRoot, entry.name))
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
    if (filesystemErrorCode(error) === 'ENOENT') return null
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

export async function hasRepairFallback(
  outputDirectory: string,
): Promise<boolean> {
  try {
    const entries = await readdir(
      join(outputDirectory, CONFIG_DIRECTORY, 'repair-fallback'),
      { withFileTypes: true },
    )
    return entries.some((entry) => entry.isDirectory())
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return false
    throw error
  }
}

export async function discardPrecommitApplicationTransaction(
  outputDirectory: string,
): Promise<void> {
  await withOutputLock(outputDirectory, () =>
    discardPrecommitApplicationTransactionUnlocked(outputDirectory),
  )
}

export async function discardQueuedPrecommitApplicationTransaction(
  outputDirectory: string,
  expectedAppId: number,
): Promise<void> {
  await withOutputLock(outputDirectory, () =>
    discardPrecommitApplicationTransactionUnlocked(
      outputDirectory,
      expectedAppId,
      true,
    ),
  )
}

async function discardPrecommitApplicationTransactionUnlocked(
  outputDirectory: string,
  expectedAppId?: number,
  discardMalformed = false,
): Promise<void> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  const entries = await readDirectoryIfExists(root)
  if (!entries) return
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const transactionRoot = join(root, entry.name)
    const journalPath = join(transactionRoot, 'journal.json')
    // Queue removal may discard malformed state only when no commit evidence exists.
    const journal = discardMalformed
      ? await readRecoverableJournal(transactionRoot, journalPath)
      : await readJournal(journalPath)
    if (!journal) continue
    if (expectedAppId !== undefined)
      assertJournalIdentity(journal, expectedAppId, outputDirectory)
    if (journal.phase !== 'staging')
      throw new ApplicationTransactionError(
        'recovery',
        'A commit-ready transaction cannot be cancelled',
      )
    await rm(transactionRoot, { recursive: true, force: true })
  }
}

async function readDirectoryIfExists(
  root: string,
): Promise<Dirent[] | undefined> {
  try {
    return await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function transactionDirectory(
  entries: Dirent[] | undefined,
): Dirent | undefined {
  const directories = entries?.filter((entry) => entry.isDirectory())
  if (directories && directories.length > 1)
    throw new ApplicationTransactionError(
      'recovery',
      'Application has ambiguous pending transaction state',
    )
  return directories?.[0]
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
