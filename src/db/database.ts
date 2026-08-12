import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { AppSettings, DepotPlatform, LibraryEntry } from '../types/rpc.ts'
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
  mountIndex: number
  ownerAppId: number | null
}

interface SettingsRow {
  hideRedistributables: number
  hideUnknownDepots: number
  hideUnusedDepots: number
  showWindows: number
  showMacos: number
  showLinux: number
}

const depotPlatforms: DepotPlatform[] = ['windows', 'macos', 'linux']

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

  addLibraryEntry(appId: number, now = Date.now()): LibraryEntry {
    validateId(appId, 'appId')
    this.sqlite
      .query(
        'INSERT INTO library (app_id, install_path, created_at) VALUES (?, NULL, ?) ON CONFLICT(app_id) DO NOTHING',
      )
      .run(appId, now)
    return this.getLibraryEntry(appId)!
  }

  removeLibraryEntry(appId: number): void {
    validateId(appId, 'appId')
    this.sqlite.query('DELETE FROM library WHERE app_id = ?').run(appId)
  }

  getSettings(defaults: AppSettings): AppSettings {
    this.validateSettings(defaults)
    this.sqlite
      .query(
        'INSERT INTO settings (id, hide_redistributables, hide_unknown_depots, hide_unused_depots, show_windows, show_macos, show_linux) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(
        Number(defaults.hideRedistributables),
        Number(defaults.hideUnknownDepots),
        Number(defaults.hideUnusedDepots),
        Number(defaults.platforms.includes('windows')),
        Number(defaults.platforms.includes('macos')),
        Number(defaults.platforms.includes('linux')),
      )
    return this.readSettings()
  }

  updateSettings(settings: AppSettings): AppSettings {
    this.validateSettings(settings)
    this.sqlite
      .query(
        'INSERT INTO settings (id, hide_redistributables, hide_unknown_depots, hide_unused_depots, show_windows, show_macos, show_linux) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hide_redistributables = excluded.hide_redistributables, hide_unknown_depots = excluded.hide_unknown_depots, hide_unused_depots = excluded.hide_unused_depots, show_windows = excluded.show_windows, show_macos = excluded.show_macos, show_linux = excluded.show_linux',
      )
      .run(
        Number(settings.hideRedistributables),
        Number(settings.hideUnknownDepots),
        Number(settings.hideUnusedDepots),
        Number(settings.platforms.includes('windows')),
        Number(settings.platforms.includes('macos')),
        Number(settings.platforms.includes('linux')),
      )
    return this.readSettings()
  }

  private readSettings(): AppSettings {
    const row = this.sqlite
      .query<SettingsRow, []>(
        'SELECT hide_redistributables AS hideRedistributables, hide_unknown_depots AS hideUnknownDepots, hide_unused_depots AS hideUnusedDepots, show_windows AS showWindows, show_macos AS showMacos, show_linux AS showLinux FROM settings WHERE id = 1',
      )
      .get()!
    return {
      hideRedistributables: Boolean(row.hideRedistributables),
      hideUnknownDepots: Boolean(row.hideUnknownDepots),
      hideUnusedDepots: Boolean(row.hideUnusedDepots),
      platforms: depotPlatforms.filter((platform) => {
        if (platform === 'windows') return Boolean(row.showWindows)
        if (platform === 'macos') return Boolean(row.showMacos)
        return Boolean(row.showLinux)
      }),
    }
  }

  private validateSettings(settings: AppSettings): void {
    if (typeof settings.hideRedistributables !== 'boolean')
      throw new Error('hideRedistributables must be a boolean')
    if (typeof settings.hideUnknownDepots !== 'boolean')
      throw new Error('hideUnknownDepots must be a boolean')
    if (typeof settings.hideUnusedDepots !== 'boolean')
      throw new Error('hideUnusedDepots must be a boolean')
    if (!Array.isArray(settings.platforms))
      throw new Error('platforms must be an array')
    const unique = new Set(settings.platforms)
    if (
      unique.size !== settings.platforms.length ||
      settings.platforms.some((platform) => !depotPlatforms.includes(platform))
    )
      throw new Error('platforms must contain unique supported platforms')
  }

  getSelectedDepotIds(appId: number): number[] {
    validateId(appId, 'appId')
    return this.sqlite
      .query<{ depotId: number }, [number]>(
        'SELECT depot_id AS depotId FROM library_depot_selections WHERE app_id = ? ORDER BY depot_id',
      )
      .all(appId)
      .map(({ depotId }) => depotId)
  }

  replaceSelectedDepotIds(appId: number, depotIds: number[]): number[] {
    validateId(appId, 'appId')
    const uniqueDepotIds = new Set(depotIds)
    if (uniqueDepotIds.size !== depotIds.length) {
      throw new Error('depotIds must not contain duplicates')
    }
    for (const depotId of depotIds) validateId(depotId, 'depotId')
    if (!this.getLibraryEntry(appId)) throw new Error('App is not in library')

    this.sqlite.transaction(() => {
      this.sqlite
        .query('DELETE FROM library_depot_selections WHERE app_id = ?')
        .run(appId)
      const insert = this.sqlite.query(
        'INSERT INTO library_depot_selections (app_id, depot_id) VALUES (?, ?)',
      )
      for (const depotId of uniqueDepotIds) insert.run(appId, depotId)
    })()
    return this.getSelectedDepotIds(appId)
  }

  getManifestRows(depotId: number): ManifestRow[] {
    return this.sqlite
      .query<ManifestRow, [number]>(
        'SELECT depot_id AS depotId, manifest_id AS manifestId, relative_path AS relativePath FROM manifest_files WHERE depot_id = ?',
      )
      .all(depotId)
  }

  hasManifest(depotId: number, manifestId: string): boolean {
    validateId(depotId, 'depotId')
    validateManifestId(manifestId)
    return Boolean(
      this.sqlite
        .query<{ present: number }, [number, string]>(
          'SELECT 1 AS present FROM manifest_files WHERE depot_id = ? AND manifest_id = ?',
        )
        .get(depotId, manifestId),
    )
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
        'SELECT depot_id AS depotId, installed_manifest_id AS installedManifestId, mount_index AS mountIndex, owner_app_id AS ownerAppId FROM library_depot_installs WHERE app_id = ? ORDER BY mount_index',
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
    if (!own) throw new Error('App is not in library')
    if (own.installPath) {
      const locked = await canonicalizeInstallDirectory(own.installPath)
      if (locked.comparisonKey !== requested.comparisonKey) {
        throw new Error('An installed app cannot change its install path')
      }
    }
    for (const entry of this.getLibrary()) {
      if (entry.appId === appId || !entry.installPath) continue
      const existing = await canonicalizeInstallDirectory(entry.installPath)
      if (existing.comparisonKey === requested.comparisonKey) {
        throw new Error('Install path is already used by another app')
      }
    }
    return requested.path
  }

  reserveInstallPath(appId: number, installPath: string): void {
    validateId(appId, 'appId')
    const result = this.sqlite
      .query(
        'UPDATE library SET install_path = COALESCE(install_path, ?) WHERE app_id = ?',
      )
      .run(installPath, appId)
    if (result.changes !== 1) throw new Error('App is not in library')
  }

  clearUnusedInstallPath(appId: number): void {
    validateId(appId, 'appId')
    this.sqlite
      .query(
        'UPDATE library SET install_path = NULL WHERE app_id = ? AND NOT EXISTS (SELECT 1 FROM library_depot_installs WHERE app_id = ?)',
      )
      .run(appId, appId)
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

      const library = this.getLibraryEntry(appId)
      if (!library) throw new Error('App is not in library')
      // Keep the path discoverable until the transaction journal is removed.
      this.sqlite
        .query(
          'UPDATE library SET install_path = COALESCE(install_path, ?) WHERE app_id = ?',
        )
        .run(installPath, appId)
      this.sqlite
        .query(
          'INSERT INTO library_depot_installs (app_id, depot_id, installed_manifest_id, mount_index, owner_app_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(app_id, depot_id) DO UPDATE SET installed_manifest_id = excluded.installed_manifest_id, owner_app_id = excluded.owner_app_id, updated_at = excluded.updated_at',
        )
        .run(
          appId,
          depotId,
          manifestId,
          this.sqlite
            .query<{ mountIndex: number }, [number, number, number]>(
              'SELECT COALESCE((SELECT mount_index FROM library_depot_installs WHERE app_id = ? AND depot_id = ?), (SELECT COALESCE(MAX(mount_index), -1) + 1 FROM library_depot_installs WHERE app_id = ?)) AS mountIndex',
            )
            .get(appId, depotId, appId)!.mountIndex,
          appId,
          now,
        )
    })()
  }

  reconcileInstalledDepots(
    appId: number,
    installPath: string,
    depots: ReadonlyArray<{
      depotId: number
      manifestId: string
      mountIndex: number
      ownerAppId?: number
    }>,
    now = Date.now(),
  ): void {
    validateId(appId, 'appId')
    const unique = new Set(depots.map(({ depotId }) => depotId))
    if (unique.size !== depots.length)
      throw new Error('Installed depots must not contain duplicates')
    for (const { depotId, manifestId, mountIndex, ownerAppId } of depots) {
      validateId(depotId, 'depotId')
      validateManifestId(manifestId)
      if (!Number.isSafeInteger(mountIndex) || mountIndex < 0)
        throw new Error('mountIndex must be a non-negative integer')
      if (ownerAppId !== undefined) validateId(ownerAppId, 'ownerAppId')
    }
    this.sqlite.transaction(() => {
      if (!this.getLibraryEntry(appId)) throw new Error('App is not in library')
      for (const { depotId, manifestId } of depots) {
        const manifest = this.sqlite
          .query<{ found: number }, [number, string]>(
            'SELECT 1 AS found FROM manifest_files WHERE depot_id = ? AND manifest_id = ?',
          )
          .get(depotId, manifestId)
        if (!manifest) throw new Error('Manifest file is not registered')
      }
      this.sqlite
        .query(
          'UPDATE library SET install_path = COALESCE(install_path, ?) WHERE app_id = ?',
        )
        .run(installPath, appId)
      this.sqlite
        .query('DELETE FROM library_depot_installs WHERE app_id = ?')
        .run(appId)
      const insert = this.sqlite.query(
        'INSERT INTO library_depot_installs (app_id, depot_id, installed_manifest_id, mount_index, owner_app_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (const { depotId, manifestId, mountIndex, ownerAppId } of depots)
        insert.run(
          appId,
          depotId,
          manifestId,
          mountIndex,
          ownerAppId ?? appId,
          now,
        )
    })()
  }
}
