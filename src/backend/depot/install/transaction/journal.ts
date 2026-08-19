import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { CONFIG_DIRECTORY } from '../internal-paths.ts'
import { resolveManifestPath } from '../filesystem.ts'
import {
  canonicalManifestPath,
  manifestPathKey,
  normalizeManifestSeparators,
} from '../../manifests/manifest-utils.ts'
import {
  lowercaseSha1Schema,
  manifestIdSchema,
  steamIdSchema,
} from '../../../../types/schemas.ts'
import {
  isDirectory,
  safeLstat,
  stagedFileLayout,
  sumProjectionFiles,
} from './projection.ts'
import { writeDurableJson } from '../../../filesystem/durable-json.ts'
import {
  ApplicationTransactionError,
  filesystemErrorCode,
  type ApplicationDepotRecord,
  type CompletionRecord,
  type JournalContext,
  type ProjectionEntry,
  type RunApplicationTransactionOptions,
  type TransactionJournal,
} from './types.ts'

export const TRANSACTION_VERSION = 3

const journalPathSchema = z.string().refine(safeJournalPath)
const depotRecordSchema = z.object({
  depotId: steamIdSchema,
  manifestId: manifestIdSchema,
  pinned: z.boolean().default(false),
  mountIndex: z.number().int().nonnegative(),
  ownerAppId: steamIdSchema.optional(),
})
const depotRecordsSchema = z
  .array(depotRecordSchema)
  .superRefine((records, ctx) => {
    const depotIds = new Set<number>()
    const mountIndexes = new Set<number>()
    for (const [index, record] of records.entries()) {
      if (depotIds.has(record.depotId))
        ctx.addIssue({
          code: 'custom',
          message: 'Depot IDs must be unique',
          path: [index, 'depotId'],
        })
      if (mountIndexes.has(record.mountIndex))
        ctx.addIssue({
          code: 'custom',
          message: 'Mount indexes must be unique',
          path: [index, 'mountIndex'],
        })
      depotIds.add(record.depotId)
      mountIndexes.add(record.mountIndex)
    }
  })
const directoryInstallSchema = z.object({
  path: journalPathSchema,
  directory: z.literal(true),
})
const fileInstallSchema = z.object({
  path: journalPathSchema,
  staging: journalPathSchema.refine((path) =>
    inJournalDirectory(path, 'staging'),
  ),
  directory: z.literal(false),
  expectedSize: manifestIdSchema,
  expectedSha1: lowercaseSha1Schema,
})
const transactionJournalSchema: z.ZodType<TransactionJournal> = z
  .object({
    version: z.union([z.literal(2), z.literal(TRANSACTION_VERSION)]),
    id: z.string(),
    generation: z.string(),
    appId: steamIdSchema,
    kind: z.enum(['download', 'reconcile', 'repair']),
    installPath: z.string(),
    paused: z.boolean(),
    phase: z.enum([
      'staging',
      'ready',
      'filesystem-committed',
      'sqlite-committed',
      'completed',
    ]),
    source: depotRecordsSchema,
    desired: depotRecordsSchema,
    stagedFiles: z.array(
      z.object({
        path: journalPathSchema,
        size: manifestIdSchema,
        sha1: lowercaseSha1Schema,
        chunks: z.array(
          z.object({
            key: z.string(),
            offset: manifestIdSchema,
            size: z.number().int().nonnegative(),
          }),
        ),
      }),
    ),
    completedChunks: z.record(
      z.string(),
      z.object({
        source: z.enum(['local', 'network']),
        networkBytes: manifestIdSchema,
      }),
    ),
    logicalInstalledTotal: manifestIdSchema,
    estimatedDownloadBytes: manifestIdSchema.optional(),
    retainedBytes: manifestIdSchema,
    retainedFileCount: z.number().int().nonnegative().optional(),
    oldMoves: z.array(
      z.object({
        path: journalPathSchema,
        backup: journalPathSchema.refine((path) =>
          inJournalDirectory(path, 'backup'),
        ),
      }),
    ),
    installs: z.array(
      z.discriminatedUnion('directory', [
        directoryInstallSchema,
        fileInstallSchema,
      ]),
    ),
    obsoleteDirectories: z.array(journalPathSchema),
  })
  .superRefine((journal, context) => {
    if (journal.version === 3 && journal.retainedFileCount === undefined)
      context.addIssue({
        code: 'custom',
        path: ['retainedFileCount'],
        message: 'Version 3 journals require retained file accounting',
      })
  })

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
  await writeDurableJson(path, journal)
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
  const result = transactionJournalSchema.safeParse(parsed)
  if (!result.success)
    throw new ApplicationTransactionError(
      'recovery',
      `Malformed journal ${path}`,
    )
  return result.data
}

function safeJournalPath(path: string): boolean {
  try {
    canonicalManifestPath(path)
    return true
  } catch {
    return false
  }
}

function inJournalDirectory(path: string, directory: string): boolean {
  return normalizeManifestSeparators(path).startsWith(`${directory}/`)
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
  expected: Pick<TransactionJournal, 'source' | 'desired'>,
  target: Map<string, ProjectionEntry>,
  validateRetained?: (journal: TransactionJournal) => Promise<boolean>,
): Promise<TransactionJournal | undefined> {
  const root = join(options.outputDirectory, CONFIG_DIRECTORY, 'transactions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return undefined
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
      'Reconcile the commit-ready transaction before resuming',
    )
  const matches =
    journal.id === entries[0]!.name &&
    journal.appId === options.appId &&
    journal.kind === options.kind &&
    journal.installPath === resolve(options.outputDirectory) &&
    JSON.stringify(journal.source) === JSON.stringify(expected.source) &&
    JSON.stringify(journal.desired) === JSON.stringify(expected.desired) &&
    stagedFilesMatchProjection(journal, target)
  if (
    !matches ||
    !(await validateStagingLedger(transactionRoot, journal)) ||
    (validateRetained && !(await validateRetained(journal)))
  ) {
    await rm(transactionRoot, { recursive: true, force: true })
    return undefined
  }
  return journal
}

function stagedFilesMatchProjection(
  journal: TransactionJournal,
  target: Map<string, ProjectionEntry>,
): boolean {
  const paths = new Set<string>()
  let stagedBytes = 0n
  for (const stagedFile of journal.stagedFiles) {
    const key = manifestPathKey(stagedFile.path)
    const entry = target.get(key)
    if (
      paths.has(key) ||
      !entry ||
      isDirectory(entry.file) ||
      JSON.stringify(stagedFileLayout([entry])[0]) !==
        JSON.stringify(stagedFile)
    )
      return false
    paths.add(key)
    stagedBytes += BigInt(stagedFile.size)
  }
  const targetBytes = sumProjectionFiles(target)
  const targetFileCount = [...target.values()].filter(
    (entry) => !isDirectory(entry.file),
  ).length
  return (
    BigInt(journal.logicalInstalledTotal) === targetBytes &&
    BigInt(journal.retainedBytes) + stagedBytes === targetBytes &&
    (journal.retainedFileCount === undefined ||
      journal.retainedFileCount + paths.size === targetFileCount)
  )
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
