import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type {
  AppSettings,
  DepotManifestTarget,
  DepotPlatform,
  LibraryEntry,
  OperationKind,
} from '../types/rpc.ts'
import { appSettingsSchema } from '../types/schemas.ts'
import { z } from 'zod'
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
  pinned?: boolean
  mountIndex: number
  ownerAppId: number | null
}

export interface ApplicationQueueItem {
  id: string
  appId: number
  kind: OperationKind
  installPath: string
  depotIds: number[]
  manifestTargets?: DepotManifestTarget[]
  createdAt: number
}

interface ApplicationQueueItemRow {
  id: string
  appId: number
  kind: OperationKind
  installPath: string
  createdAt: number
}

interface ApplicationQueueDepotRow {
  queueItemId: string
  depotId: number
  manifestId: string | null
}

interface SettingsRow {
  automaticManifestAcquisition: number
  hubcapApiKey: string | null
  hideRedistributables: number
  hideUnknownDepots: number
  hideUnusedDepots: number
  hideUnavailableDepots: number
  showWindows: number
  showMacos: number
  showLinux: number
}

const depotPlatforms: DepotPlatform[] = ['windows', 'macos', 'linux']
const settingsRowSchema = z
  .object({
    automaticManifestAcquisition: z.union([z.literal(0), z.literal(1)]),
    hubcapApiKey: z.string().nullable(),
    hideRedistributables: z.union([z.literal(0), z.literal(1)]),
    hideUnknownDepots: z.union([z.literal(0), z.literal(1)]),
    hideUnusedDepots: z.union([z.literal(0), z.literal(1)]),
    hideUnavailableDepots: z.union([z.literal(0), z.literal(1)]),
    showWindows: z.union([z.literal(0), z.literal(1)]),
    showMacos: z.union([z.literal(0), z.literal(1)]),
    showLinux: z.union([z.literal(0), z.literal(1)]),
  })
  .transform(
    (row): AppSettings => ({
      automaticManifestAcquisition: Boolean(row.automaticManifestAcquisition),
      hubcapApiKey: row.hubcapApiKey ?? '',
      hideRedistributables: Boolean(row.hideRedistributables),
      hideUnknownDepots: Boolean(row.hideUnknownDepots),
      hideUnusedDepots: Boolean(row.hideUnusedDepots),
      hideUnavailableDepots: Boolean(row.hideUnavailableDepots),
      platforms: depotPlatforms.filter((platform) => {
        if (platform === 'windows') return Boolean(row.showWindows)
        if (platform === 'macos') return Boolean(row.showMacos)
        return Boolean(row.showLinux)
      }),
    }),
  )

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
      .query<
        Omit<LibraryEntry, 'hasInstalledDepots'> & {
          hasInstalledDepots: number
        },
        []
      >(
        'SELECT app_id AS appId, install_path AS installPath, EXISTS (SELECT 1 FROM library_depot_installs WHERE library_depot_installs.app_id = library.app_id) AS hasInstalledDepots, created_at AS createdAt FROM library ORDER BY created_at, app_id',
      )
      .all()
      .map((entry) => ({
        ...entry,
        hasInstalledDepots: Boolean(entry.hasInstalledDepots),
      }))
  }

  getLibraryEntry(appId: number): LibraryEntry | null {
    validateId(appId, 'appId')
    const entry = this.sqlite
      .query<
        Omit<LibraryEntry, 'hasInstalledDepots'> & {
          hasInstalledDepots: number
        },
        [number]
      >(
        'SELECT app_id AS appId, install_path AS installPath, EXISTS (SELECT 1 FROM library_depot_installs WHERE library_depot_installs.app_id = library.app_id) AS hasInstalledDepots, created_at AS createdAt FROM library WHERE app_id = ?',
      )
      .get(appId)
    return entry
      ? { ...entry, hasInstalledDepots: Boolean(entry.hasInstalledDepots) }
      : null
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

  // RPC handlers close over these methods in a shape Fallow cannot trace.
  // fallow-ignore-next-line unused-class-member
  removeLibraryEntry(appId: number): void {
    validateId(appId, 'appId')
    this.sqlite.query('DELETE FROM library WHERE app_id = ?').run(appId)
  }

  // fallow-ignore-next-line unused-class-member
  getSettings(defaults: AppSettings): AppSettings {
    this.validateSettings(defaults)
    this.sqlite
      .query(
        'INSERT INTO settings (id, automatic_manifest_acquisition, hubcap_api_key, hide_redistributables, hide_unknown_depots, hide_unused_depots, hide_unavailable_depots, show_windows, show_macos, show_linux) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(
        Number(defaults.automaticManifestAcquisition),
        defaults.hubcapApiKey || null,
        Number(defaults.hideRedistributables),
        Number(defaults.hideUnknownDepots),
        Number(defaults.hideUnusedDepots),
        Number(defaults.hideUnavailableDepots),
        Number(defaults.platforms.includes('windows')),
        Number(defaults.platforms.includes('macos')),
        Number(defaults.platforms.includes('linux')),
      )
    return this.readSettings()
  }

  // fallow-ignore-next-line unused-class-member
  updateSettings(settings: AppSettings): AppSettings {
    this.validateSettings(settings)
    this.sqlite
      .query(
        'INSERT INTO settings (id, automatic_manifest_acquisition, hubcap_api_key, hide_redistributables, hide_unknown_depots, hide_unused_depots, hide_unavailable_depots, show_windows, show_macos, show_linux) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET automatic_manifest_acquisition = excluded.automatic_manifest_acquisition, hubcap_api_key = excluded.hubcap_api_key, hide_redistributables = excluded.hide_redistributables, hide_unknown_depots = excluded.hide_unknown_depots, hide_unused_depots = excluded.hide_unused_depots, hide_unavailable_depots = excluded.hide_unavailable_depots, show_windows = excluded.show_windows, show_macos = excluded.show_macos, show_linux = excluded.show_linux',
      )
      .run(
        Number(settings.automaticManifestAcquisition),
        settings.hubcapApiKey || null,
        Number(settings.hideRedistributables),
        Number(settings.hideUnknownDepots),
        Number(settings.hideUnusedDepots),
        Number(settings.hideUnavailableDepots),
        Number(settings.platforms.includes('windows')),
        Number(settings.platforms.includes('macos')),
        Number(settings.platforms.includes('linux')),
      )
    return this.readSettings()
  }

  private readSettings(): AppSettings {
    const row = this.sqlite
      .query<SettingsRow, []>(
        'SELECT automatic_manifest_acquisition AS automaticManifestAcquisition, hubcap_api_key AS hubcapApiKey, hide_redistributables AS hideRedistributables, hide_unknown_depots AS hideUnknownDepots, hide_unused_depots AS hideUnusedDepots, hide_unavailable_depots AS hideUnavailableDepots, show_windows AS showWindows, show_macos AS showMacos, show_linux AS showLinux FROM settings WHERE id = 1',
      )
      .get()!
    return settingsRowSchema.parse(row)
  }

  private validateSettings(settings: AppSettings): void {
    appSettingsSchema.parse(settings)
  }

  getHubcapApiKey(): string | null {
    const row = this.sqlite
      .query<{ hubcapApiKey: unknown }, []>(
        'SELECT hubcap_api_key AS hubcapApiKey FROM settings WHERE id = 1',
      )
      .get()
    if (row?.hubcapApiKey == null || row.hubcapApiKey === '') return null
    return z.string().parse(row.hubcapApiKey)
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
      .query<Omit<InstallRow, 'pinned'> & { pinned: number }, [number]>(
        'SELECT depot_id AS depotId, installed_manifest_id AS installedManifestId, pinned, mount_index AS mountIndex, owner_app_id AS ownerAppId FROM library_depot_installs WHERE app_id = ? ORDER BY mount_index',
      )
      .all(appId)
      .map((row) => ({ ...row, pinned: Boolean(row.pinned) }))
  }

  // fallow-ignore-next-line unused-class-member
  setDepotPinned(appId: number, depotId: number, pinned: boolean): void {
    validateId(appId, 'appId')
    validateId(depotId, 'depotId')
    const result = this.sqlite
      .query(
        'UPDATE library_depot_installs SET pinned = ? WHERE app_id = ? AND depot_id = ?',
      )
      .run(pinned, appId, depotId)
    if (result.changes !== 1) throw new Error('Depot is not installed')
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

  appendApplicationQueueItem(
    item: ApplicationQueueItem,
    reserveInstallPath = false,
  ): void {
    validateQueueItem(item)
    this.sqlite.transaction(() => {
      if (reserveInstallPath) {
        const result = this.sqlite
          .query(
            'UPDATE library SET install_path = COALESCE(install_path, ?) WHERE app_id = ?',
          )
          .run(item.installPath, item.appId)
        if (result.changes !== 1) throw new Error('App is not in library')
      } else if (!this.getLibraryEntry(item.appId)) {
        throw new Error('App is not in library')
      }
      const position = this.sqlite
        .query<{ position: number }, []>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM application_queue_items',
        )
        .get()!.position
      this.insertApplicationQueueItem(item, position)
    })()
  }

  getApplicationQueueItems(): ApplicationQueueItem[] {
    const rows = this.sqlite
      .query<ApplicationQueueItemRow, []>(
        'SELECT id, app_id AS appId, kind, install_path AS installPath, created_at AS createdAt FROM application_queue_items ORDER BY position',
      )
      .all()
    if (rows.length === 0) return []
    const depots = this.sqlite
      .query<ApplicationQueueDepotRow, []>(
        'SELECT queue_item_id AS queueItemId, depot_id AS depotId, manifest_id AS manifestId FROM application_queue_item_depots ORDER BY queue_item_id, request_position',
      )
      .all()
    const depotsByItem = Map.groupBy(depots, ({ queueItemId }) => queueItemId)
    return rows.map((row) =>
      queueItemFromRows(row, depotsByItem.get(row.id) ?? []),
    )
  }

  getApplicationQueueItem(id: string): ApplicationQueueItem | null {
    if (!id) throw new Error('Queue item id must not be empty')
    return (
      this.getApplicationQueueItems().find((item) => item.id === id) ?? null
    )
  }

  hasQueuedApplication(appId: number): boolean {
    validateId(appId, 'appId')
    return Boolean(
      this.sqlite
        .query<{ found: number }, [number]>(
          'SELECT 1 AS found FROM application_queue_items WHERE app_id = ?',
        )
        .get(appId),
    )
  }

  claimFirstApplicationQueueItem(
    blockedAppIds: ReadonlySet<number> = new Set(),
    blockedItemIds: ReadonlySet<string> = new Set(),
  ): ApplicationQueueItem | null {
    return this.sqlite.transaction(() => {
      const item = this.getApplicationQueueItems().find(
        (entry) =>
          !blockedItemIds.has(entry.id) &&
          (entry.kind === 'repair' || !blockedAppIds.has(entry.appId)),
      )
      if (!item) return null
      this.sqlite
        .query('DELETE FROM application_queue_items WHERE id = ?')
        .run(item.id)
      this.compactQueue()
      return item
    })()
  }

  removeApplicationQueueItem(
    id: string,
    releaseInstallPath = true,
  ): ApplicationQueueItem | null {
    if (!id) throw new Error('Queue item id must not be empty')
    return this.sqlite.transaction(() => {
      const item = this.getApplicationQueueItems().find(
        (entry) => entry.id === id,
      )
      if (!item) return null
      this.sqlite
        .query('DELETE FROM application_queue_items WHERE id = ?')
        .run(id)
      this.compactQueue()
      if (releaseInstallPath && item.kind === 'download') {
        this.sqlite
          .query(
            'UPDATE library SET install_path = NULL WHERE app_id = ? AND install_path = ? AND NOT EXISTS (SELECT 1 FROM library_depot_installs WHERE app_id = ?)',
          )
          .run(item.appId, item.installPath, item.appId)
      }
      return item
    })()
  }

  restoreApplicationQueueItemAtFront(item: ApplicationQueueItem): void {
    validateQueueItem(item)
    this.sqlite.transaction(() => {
      const items = [item, ...this.getApplicationQueueItems()]
      this.rewriteApplicationQueue(items)
    })()
  }

  prioritizeApplicationQueueItem(
    id: string,
    displaced?: ApplicationQueueItem,
  ): void {
    if (!id) throw new Error('Queue item id must not be empty')
    if (displaced) validateQueueItem(displaced)
    this.sqlite.transaction(() => {
      const items = this.getApplicationQueueItems()
      const selected = items.find((item) => item.id === id)
      if (!selected) throw new Error('Queued operation was not found')
      const remaining = items.filter((item) => item.id !== id)
      this.rewriteApplicationQueue([
        selected,
        ...(displaced ? [displaced] : []),
        ...remaining,
      ])
    })()
  }

  private compactQueue(): void {
    this.rewriteApplicationQueue(this.getApplicationQueueItems())
  }

  private rewriteApplicationQueue(items: ApplicationQueueItem[]): void {
    this.sqlite.query('DELETE FROM application_queue_items').run()
    items.forEach((item, position) =>
      this.insertApplicationQueueItem(item, position),
    )
  }

  private insertApplicationQueueItem(
    item: ApplicationQueueItem,
    position: number,
  ): void {
    this.sqlite
      .query(
        'INSERT INTO application_queue_items (id, app_id, kind, install_path, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        item.id,
        item.appId,
        item.kind,
        item.installPath,
        position,
        item.createdAt,
      )
    const manifests = new Map(
      item.manifestTargets?.map(({ depotId, manifestId }) => [
        depotId,
        manifestId,
      ]),
    )
    const insertDepot = this.sqlite.query(
      'INSERT INTO application_queue_item_depots (queue_item_id, depot_id, request_position, manifest_id) VALUES (?, ?, ?, ?)',
    )
    item.depotIds.forEach((depotId, requestPosition) =>
      insertDepot.run(
        item.id,
        depotId,
        requestPosition,
        manifests.get(depotId) ?? null,
      ),
    )
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
      pinned?: boolean
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
        'INSERT INTO library_depot_installs (app_id, depot_id, installed_manifest_id, pinned, mount_index, owner_app_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      for (const {
        depotId,
        manifestId,
        pinned,
        mountIndex,
        ownerAppId,
      } of depots)
        insert.run(
          appId,
          depotId,
          manifestId,
          pinned ?? false,
          mountIndex,
          ownerAppId ?? appId,
          now,
        )
    })()
  }
}

function validateQueueItem(item: ApplicationQueueItem): void {
  if (!item.id) throw new Error('Queue item id must not be empty')
  validateId(item.appId, 'appId')
  if (!['download', 'reconcile', 'repair'].includes(item.kind))
    throw new Error('Invalid queue item kind')
  if (!item.installPath) throw new Error('Install path must not be empty')
  if (!Number.isSafeInteger(item.createdAt) || item.createdAt < 0)
    throw new Error('createdAt must be a non-negative integer')
  const uniqueDepotIds = validateUniqueDepotIds(item.depotIds)
  const targets = item.manifestTargets ?? []
  validateQueueManifestTargets(targets, uniqueDepotIds)
}

function validateUniqueDepotIds(depotIds: number[]): Set<number> {
  const uniqueDepotIds = new Set(depotIds)
  if (uniqueDepotIds.size !== depotIds.length)
    throw new Error('depotIds must not contain duplicates')
  for (const depotId of depotIds) validateId(depotId, 'depotId')
  return uniqueDepotIds
}

function validateQueueManifestTargets(
  targets: DepotManifestTarget[],
  depotIds: Set<number>,
): void {
  if (new Set(targets.map(({ depotId }) => depotId)).size !== targets.length)
    throw new Error('Manifest targets must not contain duplicate depots')
  for (const { depotId, manifestId } of targets) {
    if (!depotIds.has(depotId))
      throw new Error('Manifest target must belong to a selected depot')
    validateManifestId(manifestId)
  }
}

function queueItemFromRows(
  row: ApplicationQueueItemRow,
  depots: ApplicationQueueDepotRow[],
): ApplicationQueueItem {
  const manifestTargets = depots.flatMap(({ depotId, manifestId }) =>
    manifestId === null ? [] : [{ depotId, manifestId }],
  )
  const item: ApplicationQueueItem = {
    ...row,
    depotIds: depots.map(({ depotId }) => depotId),
  }
  if (manifestTargets.length > 0) item.manifestTargets = manifestTargets
  return item
}
