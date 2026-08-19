import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  type ColdClientInstallation,
  coldClientInstallationSchema,
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
const SETTINGS_LIVE_PATH = '_ColdClient/steam_settings'

const journalSchema = z
  .object({
    version: z.literal(JOURNAL_VERSION),
    kind: z.enum(['setup', 'regenerate']),
    appId: z.number().int().positive().max(4_294_967_295),
    installRoot: z.string().min(1),
    previousInstallation: coldClientInstallationSchema.nullable(),
    targetInstallation: coldClientInstallationSchema,
    liveRelativePath: z.enum([LIVE_NAME, SETTINGS_LIVE_PATH]),
    stagingRelativePath: z.string().min(1),
    backupRelativePath: z.string().min(1),
    affectedFiles: z
      .array(
        z.object({ path: z.string().min(1), existed: z.boolean() }).strict(),
      )
      .length(1),
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
        : journal.liveRelativePath === SETTINGS_LIVE_PATH &&
          journal.stagingRelativePath.startsWith(SETTINGS_STAGING_PREFIX) &&
          journal.backupRelativePath.startsWith(SETTINGS_BACKUP_PREFIX)
    if (
      !pathsMatch ||
      journal.affectedFiles[0]?.path !== journal.liveRelativePath
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Journal paths do not match its operation',
      })
    }
    for (const path of [
      journal.stagingRelativePath,
      journal.backupRelativePath,
    ]) {
      if (path.includes('/') || path.includes('\\') || path.includes('\0')) {
        ctx.addIssue({
          code: 'custom',
          message: 'Journal paths must be siblings',
        })
      }
    }
  })

export type ColdClientReplacementJournal = z.infer<typeof journalSchema>

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
    })
    const journalPath = replacementJournalPath(installRoot)
    await mkdir(join(installRoot, CONFIG_DIRECTORY), { recursive: true })
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
    validateLive: (directory: string) => Promise<void>,
  ): Promise<ColdClientRecoveryResult> {
    const installRoot = await canonicalDirectory(installRootInput)
    const release = await this.#acquireLock(installRoot)
    try {
      const journal = await readJournal(installRoot)
      if (!journal) return { status: 'none' }
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

  async hasJournal(installRoot: string): Promise<boolean> {
    return (await lstatOrNull(replacementJournalPath(installRoot))) !== null
  }

  private async rollback(journal: ColdClientReplacementJournal): Promise<void> {
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
    await rm(
      journalPathInRoot(journal.installRoot, journal.stagingRelativePath),
      { recursive: true, force: true },
    )
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
