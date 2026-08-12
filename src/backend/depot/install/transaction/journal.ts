import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CONFIG_DIRECTORY } from '../internal-paths.ts'
import { resolveManifestPath } from '../filesystem.ts'
import { normalizeManifestSeparators } from '../../manifests/manifest-utils.ts'
import { safeLstat } from './projection.ts'
import {
  ApplicationTransactionError,
  type ApplicationDepotRecord,
  type CompletionRecord,
  type JournalContext,
  type JournalPhase,
  type RunApplicationTransactionOptions,
  type StagedFileLayout,
  type TransactionJournal,
} from './types.ts'

export const TRANSACTION_VERSION = 2

export async function checkpointJournal(
  context: JournalContext,
): Promise<void> {
  context.write = context.write.then(() =>
    writeJournal(context.path, context.journal),
  )
  await context.write
}

export async function completeChunk(
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

export async function writeJournal(
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

export async function readJournal(path: string): Promise<TransactionJournal> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ApplicationTransactionError(
      'recovery',
      `Malformed journal ${path}`,
      { cause: error },
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

export function assertJournalIdentity(
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

export async function loadResumableJournal(
  options: RunApplicationTransactionOptions,
  expected: Pick<TransactionJournal, 'source' | 'desired' | 'stagedFiles'>,
): Promise<TransactionJournal | undefined> {
  const root = join(options.outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  // OS metadata files beside the journals are not transaction candidates.
  entries = entries.filter((entry) => entry.isDirectory())
  if (entries.length === 0) return undefined
  if (entries.length !== 1)
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

export async function stagedAllocatedBytes(
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

export async function callPersistence(
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
