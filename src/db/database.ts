import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { LibraryEntry } from '../types/rpc.ts'
import {
  canonicalizeInstallDirectory,
  depotKeyFromHex,
  validateId,
  validateManifestId,
} from './validation.ts'
import { manifestRelativePath } from './manifest-files.ts'

export interface ManifestRow {
  depotId: number
  manifestId: string
  relativePath: string
}

export interface InstallRow {
  depotId: number
  installedManifestId: string
}

export class KalamataDatabase {
  readonly sqlite: Database

  private constructor(
    readonly dataRoot: string,
    sqlite: Database,
  ) {
    this.sqlite = sqlite
  }

  static async open(
    dataRoot: string,
    migrationsFolder: string,
  ): Promise<KalamataDatabase> {
    await mkdir(dataRoot, { recursive: true })
    await mkdir(join(dataRoot, 'manifest-files'), { recursive: true })
    const sqlite = new Database(join(dataRoot, 'kalamata.db'), { create: true })
    sqlite.exec('PRAGMA foreign_keys = ON;')
    sqlite.exec('PRAGMA journal_mode = WAL;')
    migrate(drizzle(sqlite), { migrationsFolder })
    return new KalamataDatabase(dataRoot, sqlite)
  }

  close(): void {
    this.sqlite.close()
  }

  getLibrary(): LibraryEntry[] {
    return this.sqlite
      .query<LibraryEntry, []>(
        'SELECT app_id AS appId, install_path AS installPath, created_at AS createdAt FROM library ORDER BY created_at, app_id',
      )
      .all()
  }

  getLibraryEntry(appId: number): LibraryEntry | null {
    validateId(appId, 'appId')
    return (
      this.sqlite
        .query<LibraryEntry, [number]>(
          'SELECT app_id AS appId, install_path AS installPath, created_at AS createdAt FROM library WHERE app_id = ?',
        )
        .get(appId) ?? null
    )
  }

  getManifestRows(depotId: number): ManifestRow[] {
    return this.sqlite
      .query<ManifestRow, [number]>(
        'SELECT depot_id AS depotId, manifest_id AS manifestId, relative_path AS relativePath FROM manifest_files WHERE depot_id = ?',
      )
      .all(depotId)
  }

  getDepotKey(depotId: number): string | null {
    const row = this.sqlite
      .query<{ decryptionKey: string }, [number]>(
        'SELECT decryption_key AS decryptionKey FROM depot_keys WHERE depot_id = ?',
      )
      .get(depotId)
    return row?.decryptionKey ?? null
  }

  getInstalls(appId: number): InstallRow[] {
    return this.sqlite
      .query<InstallRow, [number]>(
        'SELECT depot_id AS depotId, installed_manifest_id AS installedManifestId FROM library_depot_installs WHERE app_id = ?',
      )
      .all(appId)
  }

  async assertInstallPathAvailable(
    appId: number,
    path: string,
  ): Promise<string> {
    validateId(appId, 'appId')
    const requested = await canonicalizeInstallDirectory(path)
    const own = this.getLibraryEntry(appId)
    if (own) {
      const locked = await canonicalizeInstallDirectory(own.installPath)
      if (locked.comparisonKey !== requested.comparisonKey) {
        throw new Error('An installed app cannot change its install path')
      }
    }
    for (const entry of this.getLibrary()) {
      if (entry.appId === appId) continue
      const existing = await canonicalizeInstallDirectory(entry.installPath)
      if (existing.comparisonKey === requested.comparisonKey) {
        throw new Error('Install path is already used by another app')
      }
    }
    return requested.path
  }

  addManifest(depotId: number, manifestId: string, now = Date.now()): string {
    const relativePath = manifestRelativePath(depotId, manifestId)
    this.sqlite
      .query(
        'INSERT INTO manifest_files (depot_id, manifest_id, relative_path, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(depotId, manifestId, relativePath, now)
    return relativePath
  }

  setDepotKey(depotId: number, key: string, now = Date.now()): void {
    validateId(depotId, 'depotId')
    const normalized = depotKeyFromHex(key).toString('hex')
    this.sqlite
      .query(
        'INSERT INTO depot_keys (depot_id, decryption_key, created_at) VALUES (?, ?, ?) ON CONFLICT(depot_id) DO UPDATE SET decryption_key = excluded.decryption_key, created_at = excluded.created_at',
      )
      .run(depotId, normalized, now)
  }

  recordInstalledDepot(
    appId: number,
    installPath: string,
    depotId: number,
    manifestId: string,
    now = Date.now(),
  ): void {
    validateId(appId, 'appId')
    validateId(depotId, 'depotId')
    validateManifestId(manifestId)
    this.sqlite.transaction(() => {
      const manifest = this.sqlite
        .query<{ found: number }, [number, string]>(
          'SELECT 1 AS found FROM manifest_files WHERE depot_id = ? AND manifest_id = ?',
        )
        .get(depotId, manifestId)
      if (!manifest) throw new Error('Manifest file is not registered')

      this.sqlite
        .query(
          'INSERT INTO library (app_id, install_path, created_at) VALUES (?, ?, ?) ON CONFLICT(app_id) DO NOTHING',
        )
        .run(appId, installPath, now)
      this.sqlite
        .query(
          'INSERT INTO library_depot_installs (app_id, depot_id, installed_manifest_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(app_id, depot_id) DO UPDATE SET installed_manifest_id = excluded.installed_manifest_id, updated_at = excluded.updated_at',
        )
        .run(appId, depotId, manifestId, now)
    })()
  }
}
