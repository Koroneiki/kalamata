import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import {
  assertNoSymlinkTraversal,
  resolveManifestPath,
  resolveOutputPath,
  verifyFileSha1,
} from '../filesystem.ts'
import {
  manifestPathKey,
  normalizeManifestSeparators,
} from '../../manifests/manifest-utils.ts'
import { callPersistence, writeJournal } from './journal.ts'
import {
  isDirectory,
  isUserConfig,
  pathDepth,
  pathExists,
  removeNestedPaths,
  safeLstat,
} from './projection.ts'
import {
  ApplicationTransactionError,
  type InstallAction,
  type ProjectionEntry,
  type RunApplicationTransactionOptions,
  type StagedFile,
  type TransactionJournal,
} from './types.ts'

export async function validateObstructions(
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
    if (
      !source.has(entry.key) &&
      info.isDirectory() &&
      !isDirectory(entry.file)
    )
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

export async function planCommitActions(
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

export async function rollForward(
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
  // The output lock is the coordination boundary; Node has no portable renameat2 API.
  await assertNoSymlinkTraversal(outputDirectory, filename)
  const path = resolveOutputPath(outputDirectory, filename)
  const info = await safeLstat(path)
  if (info?.isSymbolicLink())
    throw new ApplicationTransactionError(
      'filesystem',
      `Destructive path became a symbolic link: ${filename}`,
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
