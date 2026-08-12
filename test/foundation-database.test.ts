import { afterEach, describe, expect, test } from 'bun:test'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KalamataDatabase } from '../src/db/database.ts'
import {
  ingestManifestFile,
  manifestRelativePath,
  resolveManagedManifest,
} from '../src/db/manifest-files.ts'
import { depotKeyFromHex } from '../src/db/validation.ts'

let root: string | undefined
let database: KalamataDatabase | undefined

afterEach(async () => {
  database?.close()
  database = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function openDatabase(): Promise<KalamataDatabase> {
  root = await mkdtemp(join(tmpdir(), 'kalamata-db-'))
  database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  return database
}

async function openDatabaseAtMigration(
  index: number,
): Promise<KalamataDatabase> {
  root = await mkdtemp(join(tmpdir(), 'kalamata-db-'))
  const migrations = join(root, 'migrations')
  const metadata = join(migrations, 'meta')
  await mkdir(metadata, { recursive: true })
  const source = join(import.meta.dir, '..', 'src', 'db', 'migrations')
  const journal = JSON.parse(
    await readFile(join(source, 'meta', '_journal.json'), 'utf8'),
  )
  journal.entries = journal.entries.slice(0, index + 1)
  await writeFile(
    join(metadata, '_journal.json'),
    `${JSON.stringify(journal, null, 2)}\n`,
  )
  for (const entry of journal.entries) {
    await copyFile(
      join(source, `${entry.tag}.sql`),
      join(migrations, `${entry.tag}.sql`),
    )
  }
  database = await KalamataDatabase.open(root, migrations)
  return database
}

describe('foundation database', () => {
  test('migrates an empty database and enables WAL foreign keys', async () => {
    const db = await openDatabase()
    const tables = db.sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name)

    expect(tables).toContain('library')
    expect(tables).toContain('manifest_files')
    expect(tables).toContain('depot_keys')
    expect(tables).toContain('library_depot_installs')
    expect(tables).toContain('library_depot_selections')
    expect(tables).toContain('settings')
    expect(db.sqlite.query('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    })
    expect(db.sqlite.query('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    })
    expect(db.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      db.sqlite
        .query<{ table: string }, []>(
          'PRAGMA foreign_key_list(library_depot_selections)',
        )
        .all()
        .map(({ table }) => table),
    ).toEqual(['library'])
  })

  test('preserves installed depots when upgrading a populated database', async () => {
    let db = await openDatabaseAtMigration(1)
    db.sqlite
      .query(
        'INSERT INTO library (app_id, install_path, created_at) VALUES (?, ?, ?)',
      )
      .run(10, root!, 1000)
    db.addManifest(20, '123')
    db.sqlite
      .query(
        'INSERT INTO library_depot_installs (app_id, depot_id, installed_manifest_id, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(10, 20, '123', 2000)
    db.close()
    database = undefined

    db = await KalamataDatabase.open(
      root!,
      join(import.meta.dir, '..', 'src', 'db', 'migrations'),
    )
    database = db

    expect(db.getInstalls(10)).toEqual([
      {
        depotId: 20,
        installedManifestId: '123',
        mountIndex: 0,
        ownerAppId: null,
      },
    ])
    expect(db.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
  })

  test('requires a library entry and registered manifests', async () => {
    const db = await openDatabase()
    expect(() => db.recordInstalledDepot(10, root!, 20, '123')).toThrow()
    expect(db.getLibrary()).toEqual([])

    db.addLibraryEntry(10)
    expect(() => db.recordInstalledDepot(10, root!, 20, '123')).toThrow()
    db.addManifest(20, '123')
    db.recordInstalledDepot(10, root!, 20, '123')
    db.sqlite.query('DELETE FROM library WHERE app_id = 10').run()
    expect(db.getInstalls(10)).toEqual([])
  })

  test('ignores files that are added without backend ingestion', async () => {
    const db = await openDatabase()
    db.addLibraryEntry(10)
    db.addManifest(20, '123')
    db.recordInstalledDepot(10, root!, 20, '123')
    await writeFile(join(root!, 'manifest-files', '30_456.manifest'), '')

    expect(db.getManifestRows(20)).toEqual([
      {
        depotId: 20,
        manifestId: '123',
        relativePath: 'manifest-files/20_123.manifest',
      },
    ])
    expect(db.getManifestRows(30)).toEqual([])
    expect(db.getInstalls(10)).toEqual([
      {
        depotId: 20,
        installedManifestId: '123',
        mountIndex: 0,
        ownerAppId: 10,
      },
    ])
  })

  test('ingests one supplied file using IDs from its contents', async () => {
    const db = await openDatabase()
    const depotId = 2379781
    const manifestId = '3512319404653808464'
    await copyFile(
      join(import.meta.dir, 'fixtures', `${depotId}_${manifestId}.manifest`),
      join(root!, 'manifest-files', 'incorrect-name.manifest'),
    )

    await expect(
      ingestManifestFile(
        db,
        join(root!, 'manifest-files', 'incorrect-name.manifest'),
        1000,
      ),
    ).resolves.toEqual({
      depotId,
      manifestId,
      relativePath: `manifest-files/${depotId}_${manifestId}.manifest`,
    })

    expect(await readdir(join(root!, 'manifest-files'))).toEqual([
      `${depotId}_${manifestId}.manifest`,
    ])
    expect(db.getManifestRows(depotId)).toEqual([
      {
        depotId,
        manifestId,
        relativePath: `manifest-files/${depotId}_${manifestId}.manifest`,
      },
    ])
  })

  test('rejects canonical duplicate paths and changes to locked paths', async () => {
    const db = await openDatabase()
    const install = join(root!, 'install')
    const alias = join(root!, 'alias')
    const other = join(root!, 'other')
    await mkdir(install)
    await mkdir(other)
    await symlink(install, alias)
    db.addLibraryEntry(10)
    db.addLibraryEntry(11)
    db.addManifest(20, '123')
    db.recordInstalledDepot(10, install, 20, '123')

    await expect(db.assertInstallPathAvailable(11, alias)).rejects.toThrow(
      'already used',
    )
    await expect(db.assertInstallPathAvailable(10, other)).rejects.toThrow(
      'cannot change',
    )
    await expect(db.assertInstallPathAvailable(10, alias)).resolves.toBe(
      await realpath(install),
    )
  })

  test('retains the install path until an empty reconciliation is released', async () => {
    const db = await openDatabase()
    const install = join(root!, 'install')
    await mkdir(install)
    db.addLibraryEntry(10)
    db.addManifest(20, '123')
    db.recordInstalledDepot(10, install, 20, '123')

    db.reconcileInstalledDepots(10, install, [])

    expect(db.getInstalls(10)).toEqual([])
    expect(db.getLibraryEntry(10)?.installPath).toBe(install)
    db.clearUnusedInstallPath(10)
    expect(db.getLibraryEntry(10)?.installPath).toBeNull()
  })

  test('persists independent library selections and cascades their removal', async () => {
    let db = await openDatabase()
    expect(db.addLibraryEntry(10, 1000)).toEqual({
      appId: 10,
      installPath: null,
      createdAt: 1000,
    })
    expect(db.replaceSelectedDepotIds(10, [30, 20])).toEqual([20, 30])

    db.close()
    database = undefined
    db = await KalamataDatabase.open(
      root!,
      join(import.meta.dir, '..', 'src', 'db', 'migrations'),
    )
    database = db
    expect(db.getSelectedDepotIds(10)).toEqual([20, 30])
    expect(db.replaceSelectedDepotIds(10, [40])).toEqual([40])
    expect(() => db.replaceSelectedDepotIds(10, [40, 40])).toThrow('duplicates')

    db.removeLibraryEntry(10)
    expect(db.getLibraryEntry(10)).toBeNull()
    expect(db.getSelectedDepotIds(10)).toEqual([])
  })

  test('persists settings after applying native defaults once', async () => {
    let db = await openDatabase()
    expect(
      db.getSettings({
        hideRedistributables: true,
        hideUnknownDepots: true,
        hideUnusedDepots: true,
        platforms: ['macos'],
      }),
    ).toEqual({
      hideRedistributables: true,
      hideUnknownDepots: true,
      hideUnusedDepots: true,
      platforms: ['macos'],
    })

    expect(
      db.updateSettings({
        hideRedistributables: false,
        hideUnknownDepots: false,
        hideUnusedDepots: false,
        platforms: ['windows', 'linux'],
      }),
    ).toEqual({
      hideRedistributables: false,
      hideUnknownDepots: false,
      hideUnusedDepots: false,
      platforms: ['windows', 'linux'],
    })

    db.close()
    database = undefined
    db = await KalamataDatabase.open(
      root!,
      join(import.meta.dir, '..', 'src', 'db', 'migrations'),
    )
    database = db
    expect(
      db.getSettings({
        hideRedistributables: true,
        hideUnknownDepots: true,
        hideUnusedDepots: true,
        platforms: ['macos'],
      }),
    ).toEqual({
      hideRedistributables: false,
      hideUnknownDepots: false,
      hideUnusedDepots: false,
      platforms: ['windows', 'linux'],
    })
  })

  test('enables the unknown depot filter when upgrading existing settings', async () => {
    let db = await openDatabaseAtMigration(5)
    db.sqlite
      .query(
        'INSERT INTO settings (id, hide_redistributables, hide_unused_depots, show_windows, show_macos, show_linux) VALUES (1, 0, 0, 1, 0, 1)',
      )
      .run()
    db.close()
    database = undefined

    db = await KalamataDatabase.open(
      root!,
      join(import.meta.dir, '..', 'src', 'db', 'migrations'),
    )
    database = db

    expect(
      db.getSettings({
        hideRedistributables: true,
        hideUnknownDepots: true,
        hideUnusedDepots: true,
        platforms: ['macos'],
      }),
    ).toEqual({
      hideRedistributables: false,
      hideUnknownDepots: true,
      hideUnusedDepots: false,
      platforms: ['windows', 'linux'],
    })
  })
})

test('managed paths have a fixed relative format and reject mismatches', async () => {
  const db = await openDatabase()
  expect(manifestRelativePath(20, '12345678901234567890')).toBe(
    'manifest-files/20_12345678901234567890.manifest',
  )
  await expect(
    resolveManagedManifest(root!, 20, '123', 'manifest-files/21_123.manifest'),
  ).rejects.toThrow('does not match')
  await expect(
    resolveManagedManifest(root!, 20, '123', '../20_123.manifest'),
  ).rejects.toThrow('does not match')
  db.close()
  database = undefined
})

test('depot keys enforce exact hexadecimal bytes and normalize writes', async () => {
  const db = await openDatabase()
  const upper = 'AB'.repeat(32)
  db.setDepotKey(20, upper)
  expect(db.getDepotKey(20)).toBe(upper.toLowerCase())
  expect(depotKeyFromHex(upper)).toHaveLength(32)
  expect(() => db.setDepotKey(20, 'ab')).toThrow('64 hexadecimal')
})
