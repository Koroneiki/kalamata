import { afterEach, describe, expect, test } from 'bun:test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ColdClientInstallation } from '../../../src/types/cold-client.ts'
import {
  ColdClientReplacementService,
  replacementJournalPath,
} from '../../../src/backend/cold-client/replacement.ts'
import { removeTemporaryDirectory } from '../../helpers/filesystem.ts'

let root: string | undefined

const previous: ColdClientInstallation = {
  appId: 10,
  loaderArchitecture: 'x64',
  executableRelativePath: 'old.exe',
  steamApiRelativePath: null,
  launchArguments: '',
  launchArgumentSource: null,
  gbeAssetId: 100,
  gseAssetId: 200,
  generatedDepotFingerprint: 'a'.repeat(64),
  managedCoreFiles: ['old.dll'],
  configuredAt: 1000,
}
const target: ColdClientInstallation = {
  ...previous,
  executableRelativePath: 'new.exe',
  gbeAssetId: 101,
  gseAssetId: 201,
  generatedDepotFingerprint: 'b'.repeat(64),
  managedCoreFiles: ['new.dll'],
  configuredAt: 2000,
}

afterEach(async () => {
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

describe('ColdClient setup replacement', () => {
  test('commits the database only after validating the live directory', async () => {
    const fixture = await createFixture()
    const events: string[] = []
    const database = new FakeDatabase(previous, events)
    const replacement = new ColdClientReplacementService(database)

    await replacement.replaceSetup({
      installRoot: fixture.installRoot,
      stagingDirectory: fixture.staging,
      previousInstallation: previous,
      targetInstallation: target,
      validateLive: async (live) => {
        events.push(
          `validate:${await readFile(join(live, 'state.txt'), 'utf8')}`,
        )
      },
    })

    expect(events).toEqual(['validate:new', 'database'])
    expect(database.current).toEqual(target)
    expect(
      await readFile(
        join(fixture.installRoot, '_ColdClient', 'state.txt'),
        'utf8',
      ),
    ).toBe('new')
    await expect(
      access(replacementJournalPath(fixture.installRoot)),
    ).rejects.toThrow()
  })

  test('restores the previous directory when live validation fails', async () => {
    const fixture = await createFixture()
    const database = new FakeDatabase(previous)
    const replacement = new ColdClientReplacementService(database)

    await expect(
      replacement.replaceSetup({
        installRoot: fixture.installRoot,
        stagingDirectory: fixture.staging,
        previousInstallation: previous,
        targetInstallation: target,
        validateLive: async () => {
          throw new Error('invalid live directory')
        },
      }),
    ).rejects.toThrow('invalid live directory')

    expect(database.current).toEqual(previous)
    expect(
      await readFile(
        join(fixture.installRoot, '_ColdClient', 'state.txt'),
        'utf8',
      ),
    ).toBe('old')
    await expect(
      access(replacementJournalPath(fixture.installRoot)),
    ).rejects.toThrow()
  })
})

test('settings replacement rolls back without touching sibling core files', async () => {
  const fixture = await createFixture()
  const live = join(fixture.installRoot, '_ColdClient')
  await mkdir(join(live, 'steam_settings'))
  await writeFile(join(live, 'steam_settings', 'state.txt'), 'old settings')
  await writeFile(join(live, 'core.dll'), 'core')
  const settingsStaging = join(
    fixture.installRoot,
    '.Kalamata-coldclient-settings-staging-test',
  )
  await mkdir(settingsStaging)
  await writeFile(join(settingsStaging, 'state.txt'), 'new settings')
  const database = new FakeDatabase(previous)
  const replacement = new ColdClientReplacementService(database)

  await expect(
    replacement.replaceSettings({
      installRoot: fixture.installRoot,
      stagingDirectory: settingsStaging,
      previousInstallation: previous,
      targetInstallation: target,
      validateLive: async () => {
        throw new Error('invalid settings')
      },
    }),
  ).rejects.toThrow('invalid settings')

  expect(
    await readFile(join(live, 'steam_settings', 'state.txt'), 'utf8'),
  ).toBe('old settings')
  expect(await readFile(join(live, 'core.dll'), 'utf8')).toBe('core')
  expect(database.current).toEqual(previous)
})

describe('ColdClient core replacement', () => {
  test('replaces managed files and preserves configuration and custom files', async () => {
    const fixture = await createCoreFixture()
    const database = new FakeDatabase(previous)
    const replacement = new ColdClientReplacementService(database)

    await replacement.replaceCore({
      installRoot: fixture.installRoot,
      stagingDirectory: fixture.staging,
      previousInstallation: previous,
      targetInstallation: target,
      validateLive: async (live) => {
        expect(await readFile(join(live, 'new.dll'), 'utf8')).toBe('new')
      },
    })

    expect(await readFile(join(fixture.live, 'custom.txt'), 'utf8')).toBe(
      'custom',
    )
    expect(
      await readFile(join(fixture.live, 'ColdClientLoader.ini'), 'utf8'),
    ).toBe('loader')
    expect(
      await readFile(
        join(fixture.live, 'steam_settings', 'settings.txt'),
        'utf8',
      ),
    ).toBe('settings')
    await expect(access(join(fixture.live, 'old.dll'))).rejects.toThrow()
    expect(database.current).toEqual(target)
  })

  test('restores every managed file when validation fails', async () => {
    const fixture = await createCoreFixture()
    const database = new FakeDatabase(previous)
    const replacement = new ColdClientReplacementService(database)

    await expect(
      replacement.replaceCore({
        installRoot: fixture.installRoot,
        stagingDirectory: fixture.staging,
        previousInstallation: previous,
        targetInstallation: target,
        validateLive: async () => {
          throw new Error('invalid core')
        },
      }),
    ).rejects.toThrow('invalid core')

    expect(await readFile(join(fixture.live, 'old.dll'), 'utf8')).toBe('old')
    await expect(access(join(fixture.live, 'new.dll'))).rejects.toThrow()
    expect(database.current).toEqual(previous)
  })
})

describe('ColdClient replacement recovery', () => {
  test('rolls back the filesystem while SQLite has the previous record', async () => {
    const fixture = await createFixture()
    const backup = '.Kalamata-coldclient-backup-test'
    await rename(
      join(fixture.installRoot, '_ColdClient'),
      join(fixture.installRoot, backup),
    )
    await rename(fixture.staging, join(fixture.installRoot, '_ColdClient'))
    await writeJournal(fixture.installRoot, backup)
    const replacement = new ColdClientReplacementService(
      new FakeDatabase(previous),
      { acquireLock: async () => async () => {} },
    )

    await expect(
      replacement.recover(fixture.installRoot, 10, async () => {}),
    ).resolves.toEqual({ status: 'recovered', direction: 'rollback' })
    expect(
      await readFile(
        join(fixture.installRoot, '_ColdClient', 'state.txt'),
        'utf8',
      ),
    ).toBe('old')
  })

  test('finishes cleanup while SQLite has the target record', async () => {
    const fixture = await createFixture()
    const backup = '.Kalamata-coldclient-backup-test'
    await rename(
      join(fixture.installRoot, '_ColdClient'),
      join(fixture.installRoot, backup),
    )
    await rename(fixture.staging, join(fixture.installRoot, '_ColdClient'))
    await writeJournal(fixture.installRoot, backup)
    const replacement = new ColdClientReplacementService(
      new FakeDatabase(target),
      { acquireLock: async () => async () => {} },
    )

    await expect(
      replacement.recover(fixture.installRoot, 10, async (live) => {
        expect(await readFile(join(live, 'state.txt'), 'utf8')).toBe('new')
      }),
    ).resolves.toEqual({ status: 'recovered', direction: 'forward' })
    await expect(access(join(fixture.installRoot, backup))).rejects.toThrow()
    await expect(
      access(replacementJournalPath(fixture.installRoot)),
    ).rejects.toThrow()
  })

  test('preserves an ambiguous journal and reports invalid state', async () => {
    const fixture = await createFixture()
    await writeJournal(fixture.installRoot, '.Kalamata-coldclient-backup-test')
    const unrelated = { ...previous, gbeAssetId: 999 }
    const replacement = new ColdClientReplacementService(
      new FakeDatabase(unrelated),
      { acquireLock: async () => async () => {} },
    )

    const result = await replacement.recover(
      fixture.installRoot,
      10,
      async () => {},
    )

    expect(result.status).toBe('invalid')
    await expect(
      access(replacementJournalPath(fixture.installRoot)),
    ).resolves.toBeNull()
  })

  test('distinguishes cleanup-only and unresolved journals', async () => {
    const fixture = await createFixture()
    await writeJournal(fixture.installRoot, '.Kalamata-coldclient-backup-test')
    const committed = new ColdClientReplacementService(new FakeDatabase(target))
    const unrelated = new ColdClientReplacementService(
      new FakeDatabase({ ...previous, gbeAssetId: 999 }),
    )

    await expect(
      committed.hasUnresolvedJournal(fixture.installRoot, 10),
    ).resolves.toBe(false)
    await expect(
      unrelated.hasUnresolvedJournal(fixture.installRoot, 10),
    ).resolves.toBe(true)
  })

  test('full setup supersedes an ambiguous journal and commits from current state', async () => {
    const fixture = await createFixture()
    const oldBackup = '.Kalamata-coldclient-backup-old'
    await mkdir(join(fixture.installRoot, oldBackup))
    await writeJournal(fixture.installRoot, oldBackup)
    const current = { ...previous, gbeAssetId: 999 }
    const database = new FakeDatabase(current)
    const replacement = new ColdClientReplacementService(database)

    await replacement.replaceSetup({
      installRoot: fixture.installRoot,
      stagingDirectory: fixture.staging,
      previousInstallation: current,
      targetInstallation: target,
      validateLive: async () => {},
    })

    expect(database.current).toEqual(target)
    await expect(access(join(fixture.installRoot, oldBackup))).rejects.toThrow()
    await expect(
      access(replacementJournalPath(fixture.installRoot)),
    ).rejects.toThrow()
  })

  test('failed full setup restores the superseded journal', async () => {
    const fixture = await createFixture()
    const oldBackup = '.Kalamata-coldclient-backup-old'
    await mkdir(join(fixture.installRoot, oldBackup))
    await writeJournal(fixture.installRoot, oldBackup)
    const current = { ...previous, gbeAssetId: 999 }
    const replacement = new ColdClientReplacementService(
      new FakeDatabase(current),
    )

    await expect(
      replacement.replaceSetup({
        installRoot: fixture.installRoot,
        stagingDirectory: fixture.staging,
        previousInstallation: current,
        targetInstallation: target,
        validateLive: async () => {
          throw new Error('invalid replacement')
        },
      }),
    ).rejects.toThrow('invalid replacement')

    await expect(
      replacement.hasUnresolvedJournal(fixture.installRoot, 10),
    ).resolves.toBe(true)
    await expect(
      access(join(fixture.installRoot, oldBackup)),
    ).resolves.toBeNull()
  })

  test('recovers settings without changing sibling core files', async () => {
    const fixture = await createFixture()
    const live = join(fixture.installRoot, '_ColdClient')
    const settings = join(live, 'steam_settings')
    const backup = '.Kalamata-coldclient-settings-backup-test'
    await mkdir(settings)
    await writeFile(join(settings, 'state.txt'), 'old settings')
    await writeFile(join(live, 'core.dll'), 'core')
    await rename(settings, join(fixture.installRoot, backup))
    await mkdir(settings)
    await writeFile(join(settings, 'state.txt'), 'new settings')
    await writeSettingsJournal(fixture.installRoot, backup)
    const replacement = new ColdClientReplacementService(
      new FakeDatabase(previous),
      { acquireLock: async () => async () => {} },
    )

    await expect(
      replacement.recover(fixture.installRoot, 10, async () => {}),
    ).resolves.toEqual({ status: 'recovered', direction: 'rollback' })
    expect(await readFile(join(settings, 'state.txt'), 'utf8')).toBe(
      'old settings',
    )
    expect(await readFile(join(live, 'core.dll'), 'utf8')).toBe('core')
  })

  test('rolls back a partially installed core update from its file ledger', async () => {
    const fixture = await createCoreFixture()
    const backup = '.Kalamata-coldclient-core-backup-test'
    await mkdir(join(fixture.installRoot, backup))
    await rename(
      join(fixture.live, 'old.dll'),
      join(fixture.installRoot, backup, 'old.dll'),
    )
    await rename(
      join(fixture.staging, 'new.dll'),
      join(fixture.live, 'new.dll'),
    )
    await writeCoreJournal(fixture.installRoot, backup)
    const replacement = new ColdClientReplacementService(
      new FakeDatabase(previous),
      { acquireLock: async () => async () => {} },
    )

    await expect(
      replacement.recover(fixture.installRoot, 10, async () => {}),
    ).resolves.toEqual({ status: 'recovered', direction: 'rollback' })
    expect(await readFile(join(fixture.live, 'old.dll'), 'utf8')).toBe('old')
    await expect(access(join(fixture.live, 'new.dll'))).rejects.toThrow()
    expect(await readFile(join(fixture.live, 'custom.txt'), 'utf8')).toBe(
      'custom',
    )
  })

  test('finishes a core rollback whose files were already restored', async () => {
    const fixture = await createCoreFixture()
    const backup = '.Kalamata-coldclient-core-backup-test'
    await rm(fixture.staging, { recursive: true })
    await writeCoreJournal(fixture.installRoot, backup)
    const replacement = new ColdClientReplacementService(
      new FakeDatabase(previous),
      { acquireLock: async () => async () => {} },
    )

    await expect(
      replacement.recover(fixture.installRoot, 10, async () => {}),
    ).resolves.toEqual({ status: 'recovered', direction: 'rollback' })
    expect(await readFile(join(fixture.live, 'old.dll'), 'utf8')).toBe('old')
    await expect(
      access(replacementJournalPath(fixture.installRoot)),
    ).rejects.toThrow()
  })

  test('finishes a committed core update and rejects a journal for another app', async () => {
    const fixture = await createCoreFixture()
    const backup = '.Kalamata-coldclient-core-backup-test'
    await mkdir(join(fixture.installRoot, backup))
    await rename(
      join(fixture.live, 'old.dll'),
      join(fixture.installRoot, backup, 'old.dll'),
    )
    await rename(
      join(fixture.staging, 'new.dll'),
      join(fixture.live, 'new.dll'),
    )
    await writeCoreJournal(fixture.installRoot, backup)
    const replacement = new ColdClientReplacementService(
      new FakeDatabase(target),
      { acquireLock: async () => async () => {} },
    )

    await expect(
      replacement.recover(fixture.installRoot, 11, async () => {}),
    ).resolves.toEqual({
      status: 'invalid',
      message: 'ColdClient journal AppID changed',
    })
    await expect(
      replacement.recover(fixture.installRoot, 10, async (live) => {
        expect(await readFile(join(live, 'new.dll'), 'utf8')).toBe('new')
      }),
    ).resolves.toEqual({ status: 'recovered', direction: 'forward' })
    await expect(access(join(fixture.installRoot, backup))).rejects.toThrow()
  })
})

class FakeDatabase {
  constructor(
    public current: ColdClientInstallation | null,
    private readonly events: string[] = [],
  ) {}

  getColdClientInstallation(): ColdClientInstallation | null {
    return this.current
  }

  replaceColdClientInstallationIfCurrent(
    expected: ColdClientInstallation | null,
    value: ColdClientInstallation,
  ): void {
    if (JSON.stringify(this.current) !== JSON.stringify(expected)) {
      throw new Error('unexpected record')
    }
    this.events.push('database')
    this.current = value
  }
}

async function createFixture() {
  root = await mkdtemp(join(tmpdir(), 'kalamata-coldclient-replacement-'))
  const installRoot = join(root, 'game')
  const staging = join(installRoot, '.Kalamata-coldclient-staging-test')
  await mkdir(join(installRoot, '_ColdClient'), { recursive: true })
  await mkdir(staging)
  await writeFile(join(installRoot, '_ColdClient', 'state.txt'), 'old')
  await writeFile(join(staging, 'state.txt'), 'new')
  return {
    installRoot: await realpath(installRoot),
    staging: await realpath(staging),
  }
}

async function createCoreFixture() {
  root = await mkdtemp(join(tmpdir(), 'kalamata-coldclient-core-replacement-'))
  const installRoot = join(root, 'game')
  const live = join(installRoot, '_ColdClient')
  const staging = join(installRoot, '.Kalamata-coldclient-core-staging-test')
  await Promise.all([
    mkdir(join(live, 'steam_settings'), { recursive: true }),
    mkdir(staging, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(live, 'old.dll'), 'old'),
    writeFile(join(live, 'custom.txt'), 'custom'),
    writeFile(join(live, 'ColdClientLoader.ini'), 'loader'),
    writeFile(join(live, 'steam_settings', 'settings.txt'), 'settings'),
    writeFile(join(staging, 'new.dll'), 'new'),
  ])
  return {
    installRoot: await realpath(installRoot),
    live,
    staging: await realpath(staging),
  }
}

async function writeJournal(
  installRoot: string,
  backup: string,
): Promise<void> {
  await mkdir(join(installRoot, '.Kalamata'), { recursive: true })
  await writeFile(
    replacementJournalPath(installRoot),
    JSON.stringify({
      version: 1,
      kind: 'setup',
      appId: 10,
      installRoot,
      previousInstallation: previous,
      targetInstallation: target,
      liveRelativePath: '_ColdClient',
      stagingRelativePath: '.Kalamata-coldclient-staging-test',
      backupRelativePath: backup,
      affectedFiles: [{ path: '_ColdClient', existed: true }],
    }),
  )
}

async function writeSettingsJournal(
  installRoot: string,
  backup: string,
): Promise<void> {
  await mkdir(join(installRoot, '.Kalamata'), { recursive: true })
  await writeFile(
    replacementJournalPath(installRoot),
    JSON.stringify({
      version: 1,
      kind: 'regenerate',
      appId: 10,
      installRoot,
      previousInstallation: previous,
      targetInstallation: target,
      liveRelativePath: '_ColdClient/steam_settings',
      stagingRelativePath: '.Kalamata-coldclient-settings-staging-test',
      backupRelativePath: backup,
      affectedFiles: [{ path: '_ColdClient/steam_settings', existed: true }],
    }),
  )
}

async function writeCoreJournal(
  installRoot: string,
  backup: string,
): Promise<void> {
  await mkdir(join(installRoot, '.Kalamata'), { recursive: true })
  await writeFile(
    replacementJournalPath(installRoot),
    JSON.stringify({
      version: 1,
      kind: 'update-core',
      appId: 10,
      installRoot,
      previousInstallation: previous,
      targetInstallation: target,
      liveRelativePath: '_ColdClient',
      stagingRelativePath: '.Kalamata-coldclient-core-staging-test',
      backupRelativePath: backup,
      affectedFiles: [
        {
          path: 'old.dll',
          existed: true,
          previousPath: 'old.dll',
          targetPath: null,
        },
        {
          path: 'new.dll',
          existed: false,
          previousPath: null,
          targetPath: 'new.dll',
        },
      ],
    }),
  )
}
