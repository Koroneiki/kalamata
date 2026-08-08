import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KalamataDatabase } from '../src/db/database.ts'
import {
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
    expect(db.sqlite.query('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    })
    expect(db.sqlite.query('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    })
  })

  test('enforces both install foreign keys and rolls back library creation', async () => {
    const db = await openDatabase()
    expect(() => db.recordInstalledDepot(10, root!, 20, '123')).toThrow()
    expect(db.getLibrary()).toEqual([])

    db.addManifest(20, '123')
    db.recordInstalledDepot(10, root!, 20, '123')
    expect(() => db.sqlite.query('DELETE FROM manifest_files').run()).toThrow()
    db.sqlite.query('DELETE FROM library WHERE app_id = 10').run()
    expect(db.getInstalls(10)).toEqual([])
  })

  test('rejects canonical duplicate paths and changes to locked paths', async () => {
    const db = await openDatabase()
    const install = join(root!, 'install')
    const alias = join(root!, 'alias')
    const other = join(root!, 'other')
    await mkdir(install)
    await mkdir(other)
    await symlink(install, alias)
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
