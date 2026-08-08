import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
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
    installPath: text('install_path').notNull(),
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
  (table) => [check('depot_keys_depot_id_valid', validId(table.depotId))],
)

export const libraryDepotInstalls = sqliteTable(
  'library_depot_installs',
  {
    appId: integer('app_id')
      .notNull()
      .references(() => library.appId, { onDelete: 'cascade' }),
    depotId: integer('depot_id').notNull(),
    installedManifestId: text('installed_manifest_id').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.depotId] }),
    check('library_depot_installs_depot_id_valid', validId(table.depotId)),
    check(
      'library_depot_installs_manifest_id_valid',
      sql`${table.installedManifestId} <> '' AND ${table.installedManifestId} NOT GLOB '*[^0-9]*'`,
    ),
    foreignKey({
      columns: [table.depotId, table.installedManifestId],
      foreignColumns: [manifestFiles.depotId, manifestFiles.manifestId],
    }),
  ],
)
