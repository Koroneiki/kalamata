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
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return
    throw classify(
      error,
      'recovery',
      'Could not inspect application transactions',
    )
  }
  entries = entries.filter((entry) => entry.isDirectory())
  if (entries.length > 1)
    throw new ApplicationTransactionError(
      'recovery',
      'Application has ambiguous pending transaction state',
    )
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
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
    if (journal.phase === 'staging') continue
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

export async function getResumableApplicationTransaction(
  outputDirectory: string,
  expectedAppId: number,
): Promise<ResumableApplicationTransaction | null> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return null
    throw error
  }
  entries = entries.filter((entry) => entry.isDirectory())
  if (entries.length === 0) return null
  if (entries.length > 1)
    throw new ApplicationTransactionError(
      'recovery',
      'Application has ambiguous pending transaction state',
    )
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

async function discardPrecommitApplicationTransactionUnlocked(
  outputDirectory: string,
): Promise<void> {
  const root = join(outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return
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
