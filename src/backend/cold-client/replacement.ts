import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  type ColdClientInstallation,
  coldClientInstallationSchema,
  coldClientRelativePathSchema,
} from '../../types/cold-client.ts'
import { acquireOutputLock } from '../depot/install/output-lock.ts'
import { CONFIG_DIRECTORY } from '../depot/install/internal-paths.ts'
import { filesystemErrorCode } from '../depot/install/transaction/types.ts'
import { writeDurableJson } from '../filesystem/durable-json.ts'

const JOURNAL_VERSION = 1
const JOURNAL_FILENAME = 'coldclient-replacement.json'
const LIVE_NAME = '_ColdClient'
const STAGING_PREFIX = '.Kalamata-coldclient-staging-'
const BACKUP_PREFIX = '.Kalamata-coldclient-backup-'
const SETTINGS_STAGING_PREFIX = '.Kalamata-coldclient-settings-staging-'
const SETTINGS_BACKUP_PREFIX = '.Kalamata-coldclient-settings-backup-'
const CORE_STAGING_PREFIX = '.Kalamata-coldclient-core-staging-'
const CORE_BACKUP_PREFIX = '.Kalamata-coldclient-core-backup-'
const SETTINGS_LIVE_PATH = '_ColdClient/steam_settings'

const directoryAffectedFileSchema = z
  .object({ path: z.string().min(1), existed: z.boolean() })
  .strict()
const coreAffectedFileSchema = z
  .object({
    path: coldClientRelativePathSchema,
    existed: z.boolean(),
    previousPath: coldClientRelativePathSchema.nullable(),
    targetPath: coldClientRelativePathSchema.nullable(),
  })
  .strict()

const journalSchema = z
  .object({
    version: z.literal(JOURNAL_VERSION),
    kind: z.enum(['setup', 'regenerate', 'update-core']),
    appId: z.number().int().positive().max(4_294_967_295),
    installRoot: z.string().min(1),
    previousInstallation: coldClientInstallationSchema.nullable(),
    targetInstallation: coldClientInstallationSchema,
    liveRelativePath: z.enum([LIVE_NAME, SETTINGS_LIVE_PATH]),
    stagingRelativePath: z.string().min(1),
    backupRelativePath: z.string().min(1),
    affectedFiles: z.array(
      z.union([directoryAffectedFileSchema, coreAffectedFileSchema]),
    ),
    deferredCleanupRelativePaths: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((journal, ctx) => {
    if (
      journal.targetInstallation.appId !== journal.appId ||
      (journal.previousInstallation?.appId ?? journal.appId) !== journal.appId
    ) {
      ctx.addIssue({ code: 'custom', message: 'Journal AppIDs must match' })
    }
    const pathsMatch =
      journal.kind === 'setup'
        ? journal.liveRelativePath === LIVE_NAME &&
          journal.stagingRelativePath.startsWith(STAGING_PREFIX) &&
          journal.backupRelativePath.startsWith(BACKUP_PREFIX)
        : journal.kind === 'regenerate'
          ? journal.liveRelativePath === SETTINGS_LIVE_PATH &&
            journal.stagingRelativePath.startsWith(SETTINGS_STAGING_PREFIX) &&
            journal.backupRelativePath.startsWith(SETTINGS_BACKUP_PREFIX)
          : journal.liveRelativePath === LIVE_NAME &&
            journal.stagingRelativePath.startsWith(CORE_STAGING_PREFIX) &&
            journal.backupRelativePath.startsWith(CORE_BACKUP_PREFIX)
    if (
      !pathsMatch ||
      (journal.kind === 'update-core'
        ? journal.affectedFiles.length === 0 ||
          journal.affectedFiles.some(
            (entry) =>
              !('previousPath' in entry) ||
              (entry.previousPath === null && entry.targetPath === null) ||
              (entry.existed && entry.previousPath === null),
          )
        : journal.affectedFiles.length !== 1 ||
          journal.affectedFiles[0]?.path !== journal.liveRelativePath ||
          'previousPath' in journal.affectedFiles[0])
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Journal paths do not match its operation',
      })
    }
    for (const path of [
      journal.stagingRelativePath,
      journal.backupRelativePath,
      ...journal.deferredCleanupRelativePaths,
    ]) {
      const deferred = journal.deferredCleanupRelativePaths.includes(path)
      const expectedDeferredPrefix = [
        STAGING_PREFIX,
        BACKUP_PREFIX,
        SETTINGS_STAGING_PREFIX,
        SETTINGS_BACKUP_PREFIX,
        CORE_STAGING_PREFIX,
        CORE_BACKUP_PREFIX,
      ].some((prefix) => path.startsWith(prefix))
      if (
        path.includes('/') ||
        path.includes('\\') ||
        path.includes('\0') ||
        (deferred && !expectedDeferredPrefix)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Journal paths must be siblings',
        })
      }
    }
  })

type ColdClientReplacementJournal = z.infer<typeof journalSchema>

interface ReplacementDatabase {
  getColdClientInstallation(appId: number): ColdClientInstallation | null
  replaceColdClientInstallationIfCurrent(
    previous: ColdClientInstallation | null,
    target: ColdClientInstallation,
  ): void
}

interface ReplaceSetupOptions {
  installRoot: string
  stagingDirectory: string
  previousInstallation: ColdClientInstallation | null
  targetInstallation: ColdClientInstallation
  validateLive(directory: string): Promise<void>
}

interface ReplaceSettingsOptions extends ReplaceSetupOptions {}

interface ReplaceCoreOptions extends ReplaceSetupOptions {}

interface ReplacementServiceOptions {
  acquireLock?: typeof acquireOutputLock
  reportCleanupError?: (error: Error) => void
}

export type ColdClientRecoveryResult =
  | { status: 'none' }
  | { status: 'recovered'; direction: 'rollback' | 'forward' }
  | { status: 'invalid'; message: string }

export class ColdClientReplacementService {
  readonly #acquireLock: typeof acquireOutputLock
  readonly #reportCleanupError: (error: Error) => void

  constructor(
    private readonly database: ReplacementDatabase,
    options: ReplacementServiceOptions = {},
  ) {
    this.#acquireLock = options.acquireLock ?? acquireOutputLock
    this.#reportCleanupError = options.reportCleanupError ?? (() => {})
  }

  async replaceSetup(options: ReplaceSetupOptions): Promise<void> {
    return this.replaceDirectory(options, {
      kind: 'setup',
      liveRelativePath: LIVE_NAME,
      stagingPrefix: STAGING_PREFIX,
      backupPrefix: BACKUP_PREFIX,
    })
  }

  async replaceSettings(options: ReplaceSettingsOptions): Promise<void> {
    return this.replaceDirectory(options, {
      kind: 'regenerate',
      liveRelativePath: SETTINGS_LIVE_PATH,
      stagingPrefix: SETTINGS_STAGING_PREFIX,
      backupPrefix: SETTINGS_BACKUP_PREFIX,
    })
  }

  async replaceCore(options: ReplaceCoreOptions): Promise<void> {
    const installRoot = await canonicalDirectory(options.installRoot)
    const stagingDirectory = await canonicalDirectory(options.stagingDirectory)
    const stagingRelativePath = directChildName(
      installRoot,
      stagingDirectory,
      CORE_STAGING_PREFIX,
    )
    const previous = managedPathMap(
      options.previousInstallation?.managedCoreFiles ?? [],
    )
    const target = managedPathMap(options.targetInstallation.managedCoreFiles)
    const affectedFiles = []
    for (const key of new Set([...previous.keys(), ...target.keys()])) {
      const previousPath = previous.get(key) ?? null
      const targetPath = target.get(key) ?? null
      const path = targetPath ?? previousPath!
      const livePath = coreFilePath(installRoot, previousPath ?? path)
      const metadata = await lstatOrNull(livePath)
      if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
        throw new Error(`ColdClient managed path conflicts with ${path}`)
      }
      affectedFiles.push({
        path,
        existed: metadata !== null,
        previousPath,
        targetPath,
      })
    }
    const journal = journalSchema.parse({
      version: JOURNAL_VERSION,
      kind: 'update-core',
      appId: options.targetInstallation.appId,
      installRoot,
      previousInstallation: options.previousInstallation,
      targetInstallation: options.targetInstallation,
      liveRelativePath: LIVE_NAME,
      stagingRelativePath,
      backupRelativePath: `${CORE_BACKUP_PREFIX}${randomUUID()}`,
      affectedFiles,
      deferredCleanupRelativePaths: [],
    })
    await mkdir(join(installRoot, CONFIG_DIRECTORY), { recursive: true })
    if (await readJournal(installRoot)) {
      throw new Error('Resolve the interrupted ColdClient operation first')
    }
    await writeDurableJson(replacementJournalPath(installRoot), journal)

    let databaseCommitted = false
    try {
      await this.prepareCoreBackup(journal)
      await this.installCore(journal)
      await options.validateLive(join(installRoot, LIVE_NAME))
      this.database.replaceColdClientInstallationIfCurrent(
        options.previousInstallation,
        options.targetInstallation,
      )
      databaseCommitted = true
      await this.finishForward(journal)
    } catch (error) {
      if (databaseCommitted) {
        this.#reportCleanupError(
          error instanceof Error
            ? error
            : new Error('ColdClient cleanup failed after commit'),
        )
        return
      }
      await this.rollback(journal)
      throw error
    }
  }

  private async replaceDirectory(
    options: ReplaceSetupOptions,
    paths: {
      kind: 'setup' | 'regenerate'
      liveRelativePath: typeof LIVE_NAME | typeof SETTINGS_LIVE_PATH
      stagingPrefix: string
      backupPrefix: string
    },
  ): Promise<void> {
    const installRoot = await canonicalDirectory(options.installRoot)
    const stagingDirectory = await canonicalDirectory(options.stagingDirectory)
    const stagingRelativePath = directChildName(
      installRoot,
      stagingDirectory,
      paths.stagingPrefix,
    )
    const live = join(installRoot, ...paths.liveRelativePath.split('/'))
    const oldLiveExisted = await directoryExists(live)
    const journal = journalSchema.parse({
      version: JOURNAL_VERSION,
      kind: paths.kind,
      appId: options.targetInstallation.appId,
      installRoot,
      previousInstallation: options.previousInstallation,
      targetInstallation: options.targetInstallation,
      liveRelativePath: paths.liveRelativePath,
      stagingRelativePath,
      backupRelativePath: `${paths.backupPrefix}${randomUUID()}`,
      affectedFiles: [
        { path: paths.liveRelativePath, existed: oldLiveExisted },
      ],
      deferredCleanupRelativePaths: [],
    })
    const journalPath = replacementJournalPath(installRoot)
    await mkdir(join(installRoot, CONFIG_DIRECTORY), { recursive: true })
    const existingJournal = await readJournal(installRoot)
    if (existingJournal) {
      if (paths.kind !== 'setup') {
        throw new Error('Resolve the interrupted ColdClient operation first')
      }
      journal.deferredCleanupRelativePaths = [
        existingJournal.stagingRelativePath,
        existingJournal.backupRelativePath,
        ...existingJournal.deferredCleanupRelativePaths,
      ]
    }
    await writeDurableJson(journalPath, journal)

    let databaseCommitted = false
    try {
      const backup = journalPathInRoot(installRoot, journal.backupRelativePath)
      if (oldLiveExisted) await rename(live, backup)
      await rename(stagingDirectory, live)
      await options.validateLive(live)
      this.database.replaceColdClientInstallationIfCurrent(
        options.previousInstallation,
        options.targetInstallation,
      )
      databaseCommitted = true
      await this.finishForward(journal)
    } catch (error) {
      if (databaseCommitted) {
        this.#reportCleanupError(
          error instanceof Error
            ? error
            : new Error('ColdClient cleanup failed after commit'),
        )
        return
      }
      await this.rollback(journal)
      throw error
    }
  }

  async recover(
    installRootInput: string,
    expectedAppId: number,
    validateLive: (directory: string) => Promise<void>,
  ): Promise<ColdClientRecoveryResult> {
    const installRoot = await canonicalDirectory(installRootInput)
    const release = await this.#acquireLock(installRoot)
    try {
      const journal = await readJournal(installRoot)
      if (!journal) return { status: 'none' }
      if (journal.appId !== expectedAppId) {
        return {
          status: 'invalid',
          message: 'ColdClient journal AppID changed',
        }
      }
      if (journal.installRoot !== installRoot) {
        return { status: 'invalid', message: 'ColdClient journal path changed' }
      }
      const current = this.database.getColdClientInstallation(journal.appId)
      if (sameInstallation(current, journal.targetInstallation)) {
        await validateLive(join(installRoot, LIVE_NAME))
        await this.finishForward(journal)
        return { status: 'recovered', direction: 'forward' }
      }
      if (sameInstallation(current, journal.previousInstallation)) {
        await this.rollback(journal)
        return { status: 'recovered', direction: 'rollback' }
      }
      return {
        status: 'invalid',
        message: 'ColdClient journal does not match the installation record',
      }
    } finally {
      await release()
    }
  }

  // Called through the orchestration service's replacement contract.
  // fallow-ignore-next-line unused-class-member
  async hasJournal(installRoot: string): Promise<boolean> {
    return (await lstatOrNull(replacementJournalPath(installRoot))) !== null
  }

  private async rollback(journal: ColdClientReplacementJournal): Promise<void> {
    if (journal.kind === 'update-core') {
      await this.rollbackCore(journal)
      return
    }
    const live = journalPathInRoot(
      journal.installRoot,
      journal.liveRelativePath,
    )
    const staging = journalPathInRoot(
      journal.installRoot,
      journal.stagingRelativePath,
    )
    const backup = journalPathInRoot(
      journal.installRoot,
      journal.backupRelativePath,
    )
    const backupExists = await directoryExists(backup)
    if (backupExists) {
      await rm(live, { recursive: true, force: true })
      await rename(backup, live)
    } else if (!journal.affectedFiles[0]!.existed) {
      await rm(live, { recursive: true, force: true })
    } else {
      await assertSafeDirectory(live, 'live directory')
    }
    await rm(staging, { recursive: true, force: true })
    await rm(replacementJournalPath(journal.installRoot), { force: true })
  }

  private async finishForward(
    journal: ColdClientReplacementJournal,
  ): Promise<void> {
    await rm(
      journalPathInRoot(journal.installRoot, journal.backupRelativePath),
      { recursive: true, force: true },
    )
    for (const path of journal.deferredCleanupRelativePaths) {
      await rm(journalPathInRoot(journal.installRoot, path), {
        recursive: true,
        force: true,
      })
    }
    await rm(
      journalPathInRoot(journal.installRoot, journal.stagingRelativePath),
      { recursive: true, force: true },
    )
    await rm(replacementJournalPath(journal.installRoot), { force: true })
  }

  private async prepareCoreBackup(
    journal: ColdClientReplacementJournal,
  ): Promise<void> {
    if (journal.kind !== 'update-core') throw new Error('Invalid core journal')
    const backupRoot = journalPathInRoot(
      journal.installRoot,
      journal.backupRelativePath,
    )
    await mkdir(backupRoot)
    for (const entry of coreEntries(journal)) {
      if (!entry.existed) continue
      const live = coreFilePath(journal.installRoot, entry.previousPath!)
      const backup = join(backupRoot, ...entry.path.split('/'))
      if (await lstatOrNull(backup)) continue
      const metadata = await lstatOrNull(live)
      if (!metadata?.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`ColdClient managed path changed: ${entry.path}`)
      }
      await mkdir(dirname(backup), { recursive: true })
      await rename(live, backup)
    }
  }

  private async installCore(
    journal: ColdClientReplacementJournal,
  ): Promise<void> {
    if (journal.kind !== 'update-core') throw new Error('Invalid core journal')
    const stagingRoot = journalPathInRoot(
      journal.installRoot,
      journal.stagingRelativePath,
    )
    for (const entry of coreEntries(journal)) {
      if (!entry.targetPath) continue
      const staging = join(stagingRoot, ...entry.targetPath.split('/'))
      const live = coreFilePath(journal.installRoot, entry.targetPath)
      const metadata = await lstatOrNull(staging)
      if (!metadata?.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`ColdClient staged core changed: ${entry.targetPath}`)
      }
      await mkdir(dirname(live), { recursive: true })
      await rename(staging, live)
    }
  }

  private async rollbackCore(
    journal: ColdClientReplacementJournal,
  ): Promise<void> {
    if (journal.kind !== 'update-core') throw new Error('Invalid core journal')
    const stagingRoot = journalPathInRoot(
      journal.installRoot,
      journal.stagingRelativePath,
    )
    const backupRoot = journalPathInRoot(
      journal.installRoot,
      journal.backupRelativePath,
    )
    for (const entry of coreEntries(journal).toReversed()) {
      const backup = join(backupRoot, ...entry.path.split('/'))
      const backupMetadata = await lstatOrNull(backup)
      if (backupMetadata) {
        if (!backupMetadata.isFile() || backupMetadata.isSymbolicLink()) {
          throw new Error(`ColdClient core backup is unsafe: ${entry.path}`)
        }
        if (entry.targetPath) {
          await rm(coreFilePath(journal.installRoot, entry.targetPath), {
            force: true,
          })
        }
        const destination = coreFilePath(
          journal.installRoot,
          entry.previousPath!,
        )
        await mkdir(dirname(destination), { recursive: true })
        await rename(backup, destination)
        continue
      }
      if (!entry.existed && entry.targetPath) {
        await rm(coreFilePath(journal.installRoot, entry.targetPath), {
          force: true,
        })
      } else if (entry.existed && entry.targetPath) {
        const staged = join(stagingRoot, ...entry.targetPath.split('/'))
        if (!(await lstatOrNull(staged))) {
          throw new Error(
            `ColdClient core rollback is ambiguous: ${entry.path}`,
          )
        }
      }
    }
    await rm(stagingRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
    await rm(replacementJournalPath(journal.installRoot), { force: true })
  }
}

export function replacementJournalPath(installRoot: string): string {
  return join(installRoot, CONFIG_DIRECTORY, JOURNAL_FILENAME)
}

async function readJournal(
  installRoot: string,
): Promise<ColdClientReplacementJournal | null> {
  const path = replacementJournalPath(installRoot)
  if (!(await lstatOrNull(path))) return null
  return journalSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

function journalPathInRoot(installRoot: string, relativePath: string): string {
  const path = resolve(installRoot, relativePath)
  const fromRoot = relative(installRoot, path)
  if (
    !fromRoot ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot) ||
    (fromRoot.includes(sep) && relativePath !== SETTINGS_LIVE_PATH)
  ) {
    throw new Error('ColdClient journal path escaped the install root')
  }
  return path
}

function directChildName(root: string, path: string, prefix: string): string {
  const name = relative(root, resolve(path))
  if (!name.startsWith(prefix) || name.includes(sep) || isAbsolute(name)) {
    throw new Error('ColdClient staging must be a managed sibling directory')
  }
  return name
}

function managedPathMap(paths: string[]): Map<string, string> {
  return new Map(paths.map((path) => [path.toLowerCase(), path]))
}

function coreEntries(journal: ColdClientReplacementJournal) {
  return journal.affectedFiles.filter(
    (entry): entry is z.infer<typeof coreAffectedFileSchema> =>
      'previousPath' in entry,
  )
}

function coreFilePath(installRoot: string, path: string): string {
  const validated = coldClientRelativePathSchema.parse(path)
  return join(installRoot, LIVE_NAME, ...validated.split('/'))
}

async function canonicalDirectory(path: string): Promise<string> {
  await assertSafeDirectory(path, 'install directory')
  return realpath(path)
}

async function assertSafeDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstatOrNull(path)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`ColdClient ${label} is not a safe directory`)
  }
}

async function directoryExists(path: string): Promise<boolean> {
  const metadata = await lstatOrNull(path)
  if (!metadata) return false
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('ColdClient replacement path is not a safe directory')
  }
  return true
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return null
    throw error
  }
}

function sameInstallation(
  left: ColdClientInstallation | null,
  right: ColdClientInstallation | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
