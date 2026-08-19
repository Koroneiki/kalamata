import { sql } from 'drizzle-orm'
import {
  check,
  type AnySQLiteColumn,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'

const validId = (column: AnySQLiteColumn) =>
  sql`${column} > 0 AND ${column} <= 4294967295`

export const library = sqliteTable(
  'library',
  {
    appId: integer('app_id').primaryKey(),
    installPath: text('install_path'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('library_install_path_unique').on(table.installPath),
    check('library_app_id_valid', validId(table.appId)),
  ],
)

export const manifestFiles = sqliteTable(
  'manifest_files',
  {
    depotId: integer('depot_id').notNull(),
    manifestId: text('manifest_id').notNull(),
    relativePath: text('relative_path').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.depotId, table.manifestId] }),
    unique('manifest_files_relative_path_unique').on(table.relativePath),
    check('manifest_files_depot_id_valid', validId(table.depotId)),
    check(
      'manifest_files_manifest_id_valid',
      sql`${table.manifestId} <> '' AND ${table.manifestId} NOT GLOB '*[^0-9]*'`,
    ),
  ],
)

export const depotKeys = sqliteTable(
  'depot_keys',
  {
    depotId: integer('depot_id').primaryKey(),
    decryptionKey: text('decryption_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    check('depot_keys_depot_id_valid', validId(table.depotId)),
    check(
      'depot_keys_decryption_key_valid',
      sql`length(${table.decryptionKey}) = 64 AND ${table.decryptionKey} NOT GLOB '*[^0-9A-Fa-f]*'`,
    ),
  ],
)

export const libraryDepotInstalls = sqliteTable(
  'library_depot_installs',
  {
    appId: integer('app_id')
      .notNull()
      .references(() => library.appId, { onDelete: 'cascade' }),
    depotId: integer('depot_id').notNull(),
    installedManifestId: text('installed_manifest_id').notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    mountIndex: integer('mount_index').notNull(),
    ownerAppId: integer('owner_app_id'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.depotId] }),
    check('library_depot_installs_depot_id_valid', validId(table.depotId)),
    check(
      'library_depot_installs_owner_app_id_valid',
      sql`${table.ownerAppId} IS NULL OR (${validId(table.ownerAppId)})`,
    ),
    check(
      'library_depot_installs_mount_index_valid',
      sql`${table.mountIndex} >= 0`,
    ),
    unique('library_depot_installs_mount_index_unique').on(
      table.appId,
      table.mountIndex,
    ),
    check(
      'library_depot_installs_manifest_id_valid',
      sql`${table.installedManifestId} <> '' AND ${table.installedManifestId} NOT GLOB '*[^0-9]*'`,
    ),
  ],
)

export const coldClientInstallations = sqliteTable(
  'cold_client_installations',
  {
    appId: integer('app_id')
      .primaryKey()
      .references(() => library.appId, { onDelete: 'cascade' }),
    loaderArchitecture: text('loader_architecture', {
      enum: ['x86', 'x64'],
    }).notNull(),
    executableRelativePath: text('executable_relative_path').notNull(),
    steamApiRelativePath: text('steam_api_relative_path'),
    launchArguments: text('launch_arguments').notNull(),
    launchArgumentSource: text('launch_argument_source'),
    gbeAssetId: integer('gbe_asset_id').notNull(),
    gseAssetId: integer('gse_asset_id').notNull(),
    generatedDepotFingerprint: text('generated_depot_fingerprint').notNull(),
    managedCoreFiles: text('managed_core_files').notNull(),
    configuredAt: integer('configured_at').notNull(),
  },
  (table) => [
    check('cold_client_installations_app_id_valid', validId(table.appId)),
    check(
      'cold_client_installations_loader_architecture_valid',
      sql`${table.loaderArchitecture} IN ('x86', 'x64')`,
    ),
    check(
      'cold_client_installations_executable_path_valid',
      sql`${table.executableRelativePath} <> ''`,
    ),
    check(
      'cold_client_installations_steam_api_path_valid',
      sql`${table.steamApiRelativePath} IS NULL OR ${table.steamApiRelativePath} <> ''`,
    ),
    check(
      'cold_client_installations_architecture_consistent',
      sql`${table.loaderArchitecture} = 'x64' OR ${table.steamApiRelativePath} IS NOT NULL`,
    ),
    check(
      'cold_client_installations_launch_source_valid',
      sql`${table.launchArgumentSource} IS NULL OR ${table.launchArgumentSource} <> ''`,
    ),
    check(
      'cold_client_installations_gbe_asset_id_valid',
      sql`${table.gbeAssetId} > 0`,
    ),
    check(
      'cold_client_installations_gse_asset_id_valid',
      sql`${table.gseAssetId} > 0`,
    ),
    check(
      'cold_client_installations_depot_fingerprint_valid',
      sql`length(${table.generatedDepotFingerprint}) = 64 AND ${table.generatedDepotFingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'cold_client_installations_managed_core_files_valid',
      sql`json_valid(${table.managedCoreFiles}) AND json_type(${table.managedCoreFiles}) = 'array' AND json_array_length(${table.managedCoreFiles}) > 0`,
    ),
    check(
      'cold_client_installations_configured_at_valid',
      sql`${table.configuredAt} >= 0`,
    ),
  ],
)

export const applicationQueueItems = sqliteTable(
  'application_queue_items',
  {
    id: text('id').primaryKey(),
    appId: integer('app_id')
      .notNull()
      .references(() => library.appId, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['download', 'reconcile', 'repair'] }).notNull(),
    installPath: text('install_path').notNull(),
    position: integer('position').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('application_queue_items_app_id_unique').on(table.appId),
    unique('application_queue_items_position_unique').on(table.position),
    check('application_queue_items_id_valid', sql`${table.id} <> ''`),
    check('application_queue_items_app_id_valid', validId(table.appId)),
    check(
      'application_queue_items_kind_valid',
      sql`${table.kind} IN ('download', 'reconcile', 'repair')`,
    ),
    check(
      'application_queue_items_install_path_valid',
      sql`${table.installPath} <> ''`,
    ),
    check(
      'application_queue_items_position_valid',
      sql`${table.position} >= 0`,
    ),
  ],
)

export const applicationQueueItemDepots = sqliteTable(
  'application_queue_item_depots',
  {
    queueItemId: text('queue_item_id')
      .notNull()
      .references(() => applicationQueueItems.id, { onDelete: 'cascade' }),
    depotId: integer('depot_id').notNull(),
    requestPosition: integer('request_position').notNull(),
    manifestId: text('manifest_id'),
  },
  (table) => [
    primaryKey({ columns: [table.queueItemId, table.depotId] }),
    unique('application_queue_item_depots_position_unique').on(
      table.queueItemId,
      table.requestPosition,
    ),
    check(
      'application_queue_item_depots_depot_id_valid',
      validId(table.depotId),
    ),
    check(
      'application_queue_item_depots_request_position_valid',
      sql`${table.requestPosition} >= 0`,
    ),
    check(
      'application_queue_item_depots_manifest_id_valid',
      sql`${table.manifestId} IS NULL OR (${table.manifestId} <> '' AND ${table.manifestId} NOT GLOB '*[^0-9]*')`,
    ),
  ],
)

export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey(),
    automaticManifestAcquisition: integer('automatic_manifest_acquisition', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    hubcapApiKey: text('hubcap_api_key'),
    hideRedistributables: integer('hide_redistributables', {
      mode: 'boolean',
    }).notNull(),
    hideUnknownDepots: integer('hide_unknown_depots', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    hideUnusedDepots: integer('hide_unused_depots', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    hideUnavailableDepots: integer('hide_unavailable_depots', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    showWindows: integer('show_windows', { mode: 'boolean' }).notNull(),
    showMacos: integer('show_macos', { mode: 'boolean' }).notNull(),
    showLinux: integer('show_linux', { mode: 'boolean' }).notNull(),
  },
  (table) => [check('settings_singleton', sql`${table.id} = 1`)],
)
