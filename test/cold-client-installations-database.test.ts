import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ColdClientInstallation,
  managedCoreFilesSchema,
} from '../src/types/cold-client.ts'
import { KalamataDatabase } from '../src/db/database.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

let root: string | undefined
let database: KalamataDatabase | undefined

const installation: ColdClientInstallation = {
  appId: 10,
  loaderArchitecture: 'x64',
  executableRelativePath: 'Game/Binaries/Game.exe',
  steamApiRelativePath: 'Game/Binaries/steam_api64.dll',
  launchArguments: '-windowed',
  launchArgumentSource: '0',
  gbeAssetId: 100,
  gseAssetId: 200,
  generatedDepotFingerprint: 'a'.repeat(64),
  managedCoreFiles: [
    'steamclient_loader_x64.exe',
    'extra_dlls/steam_overlay64.dll',
  ],
  configuredAt: 1000,
}

afterEach(async () => {
  database?.close()
  database = undefined
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

async function openDatabase(): Promise<KalamataDatabase> {
  root = await mkdtemp(join(tmpdir(), 'kalamata-cold-client-db-'))
  database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  return database
}

describe('ColdClient installation storage', () => {
  test('replaces and removes a validated installation record', async () => {
    const db = await openDatabase()
    expect(() => db.replaceColdClientInstallation(installation)).toThrow(
      'App is not in library',
    )
    db.addLibraryEntry(installation.appId)

    db.replaceColdClientInstallation(installation)
    expect(db.getColdClientInstallation(installation.appId)).toEqual(
      installation,
    )

    const replaced = {
      ...installation,
      gseAssetId: 201,
      managedCoreFiles: ['steamclient_loader_x64.exe'],
      configuredAt: 2000,
    }
    db.replaceColdClientInstallation(replaced)
    expect(db.getColdClientInstallations()).toEqual([replaced])

    db.deleteColdClientInstallation(installation.appId)
    expect(db.getColdClientInstallation(installation.appId)).toBeNull()
  })

  test('replaces only the exact expected installation record', async () => {
    const db = await openDatabase()
    db.addLibraryEntry(installation.appId)
    db.replaceColdClientInstallation(installation)
    const replacement = { ...installation, configuredAt: 2000 }

    expect(() =>
      db.replaceColdClientInstallationIfCurrent(null, replacement),
    ).toThrow('changed during setup')
    expect(db.getColdClientInstallation(installation.appId)).toEqual(
      installation,
    )

    db.replaceColdClientInstallationIfCurrent(installation, replacement)
    expect(db.getColdClientInstallation(installation.appId)).toEqual(
      replacement,
    )
  })

  test('cascades installation records with their library entries', async () => {
    const db = await openDatabase()
    db.addLibraryEntry(installation.appId)
    db.replaceColdClientInstallation(installation)

    db.removeLibraryEntry(installation.appId)

    expect(db.getColdClientInstallations()).toEqual([])
    expect(db.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
  })

  test('retains the install path until ColdClient is removed', async () => {
    const db = await openDatabase()
    const installPath = join(root!, 'game')
    db.addLibraryEntry(installation.appId)
    db.reserveInstallPath(installation.appId, installPath)
    db.replaceColdClientInstallation(installation)

    db.clearUnusedInstallPath(installation.appId)
    expect(db.getLibraryEntry(installation.appId)?.installPath).toBe(
      installPath,
    )

    db.deleteColdClientInstallation(installation.appId)
    db.clearUnusedInstallPath(installation.appId)
    expect(db.getLibraryEntry(installation.appId)?.installPath).toBeNull()
  })

  test('rejects unsafe or ambiguous managed paths', () => {
    for (const path of [
      '',
      '/absolute.dll',
      'C:/absolute.dll',
      'folder\\file.dll',
      'folder/../file.dll',
      'folder/./file.dll',
      'folder//file.dll',
      'file.dll:stream',
    ]) {
      expect(managedCoreFilesSchema.safeParse([path]).success).toBeFalse()
    }
    expect(
      managedCoreFilesSchema.safeParse(['Extra/file.dll', 'extra/FILE.dll'])
        .success,
    ).toBeFalse()
  })

  test('validates records before writing and after reading', async () => {
    const db = await openDatabase()
    db.addLibraryEntry(installation.appId)

    expect(() =>
      db.replaceColdClientInstallation({
        ...installation,
        loaderArchitecture: 'x86',
        steamApiRelativePath: null,
      }),
    ).toThrow()
    expect(db.getColdClientInstallations()).toEqual([])

    db.replaceColdClientInstallation(installation)
    db.sqlite
      .query('UPDATE cold_client_installations SET managed_core_files = ?')
      .run('["../outside.dll"]')
    expect(() => db.getColdClientInstallation(installation.appId)).toThrow()
  })

  test('enforces record invariants in SQLite', async () => {
    const db = await openDatabase()
    db.addLibraryEntry(installation.appId)
    const insert = db.sqlite.query(
      'INSERT INTO cold_client_installations (app_id, loader_architecture, executable_relative_path, steam_api_relative_path, launch_arguments, launch_argument_source, gbe_asset_id, gse_asset_id, generated_depot_fingerprint, managed_core_files, configured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const values = [
      installation.appId,
      installation.loaderArchitecture,
      installation.executableRelativePath,
      installation.steamApiRelativePath,
      installation.launchArguments,
      installation.launchArgumentSource,
      installation.gbeAssetId,
      installation.gseAssetId,
      installation.generatedDepotFingerprint,
      JSON.stringify(installation.managedCoreFiles),
      installation.configuredAt,
    ] as const

    expect(() => insert.run(...values.toSpliced(1, 1, 'arm64'))).toThrow()
    expect(() => insert.run(...values.toSpliced(8, 1, 'bad'))).toThrow()
    expect(() => insert.run(...values.toSpliced(9, 1, '{}'))).toThrow()
    expect(() =>
      insert.run(...values.toSpliced(1, 1, 'x86').toSpliced(3, 1, null)),
    ).toThrow()
  })
})
