import { readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  parseManifest,
  parseManifestEnvelope,
  validateManifest,
  validateManifestEnvelope,
} from '../backend/depot/manifests/manifest-codec.ts'
import type { DepotManifest } from '../backend/depot/manifests/types.ts'
import type { KalamataDatabase, ManifestRow } from './database.ts'
import { validateId, validateManifestId } from './validation.ts'

export function manifestRelativePath(
  depotId: number,
  manifestId: string,
): string {
  validateId(depotId, 'depotId')
  validateManifestId(manifestId)
  return `manifest-files/${depotId}_${manifestId}.manifest`
}

export async function pruneMissingManifestFiles(
  database: KalamataDatabase,
): Promise<void> {
  // Reconcile registered resources only; unmanaged files must pass explicit ingestion.
  const filenames = new Set(
    await readdir(join(database.dataRoot, 'manifest-files')),
  )
  const rows = database.sqlite
    .query<ManifestRow, []>(
      'SELECT depot_id AS depotId, manifest_id AS manifestId, relative_path AS relativePath FROM manifest_files',
    )
    .all()
  const remove = database.sqlite.query(
    'DELETE FROM manifest_files WHERE depot_id = ? AND manifest_id = ?',
  )

  database.sqlite.transaction(() => {
    for (const row of rows) {
      const expected = manifestRelativePath(row.depotId, row.manifestId)
      if (row.relativePath !== expected || !filenames.has(basename(expected))) {
        remove.run(row.depotId, row.manifestId)
      }
    }
  })()
}

export async function ingestManifestFile(
  database: KalamataDatabase,
  incomingPath: string,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<ManifestRow> {
  const contents = await readFile(incomingPath, { signal })
  const manifest = parseManifestEnvelope(contents)
  validateManifestEnvelope(manifest, manifest.depot_id, manifest.gid_manifest)

  const row = {
    depotId: manifest.depot_id,
    manifestId: manifest.gid_manifest,
    relativePath: manifestRelativePath(
      manifest.depot_id,
      manifest.gid_manifest,
    ),
  }
  const destination = join(database.dataRoot, row.relativePath)
  signal?.throwIfAborted()
  if (incomingPath !== destination) {
    await rename(incomingPath, destination)
    if (signal?.aborted) {
      // A cancelled acquisition must not leave an unregistered managed file.
      await rm(destination, { force: true })
      signal.throwIfAborted()
    }
  }
  database.sqlite
    .query(
      'INSERT INTO manifest_files (depot_id, manifest_id, relative_path, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(depot_id, manifest_id) DO UPDATE SET relative_path = excluded.relative_path',
    )
    .run(row.depotId, row.manifestId, row.relativePath, now)
  return row
}

export async function resolveManagedManifest(
  dataRoot: string,
  depotId: number,
  manifestId: string,
  storedPath: string,
): Promise<string> {
  const expected = manifestRelativePath(depotId, manifestId)
  if (storedPath !== expected || isAbsolute(storedPath)) {
    throw new Error(
      'Managed manifest path does not match its depot and manifest IDs',
    )
  }
  const manifestRoot = await realpath(join(dataRoot, 'manifest-files'))
  const resolved = await realpath(join(dataRoot, storedPath))
  const withinRoot = relative(manifestRoot, resolved)
  if (
    !withinRoot ||
    withinRoot.startsWith(`..${sep}`) ||
    withinRoot === '..' ||
    isAbsolute(withinRoot) ||
    dirname(resolved) !== manifestRoot ||
    basename(resolved) !== `${depotId}_${manifestId}.manifest`
  ) {
    throw new Error('Managed manifest path escapes the manifest directory')
  }
  return resolved
}

export async function validateManagedManifest(
  dataRoot: string,
  depotId: number,
  manifestId: string,
  storedPath: string,
  key?: Buffer,
): Promise<string> {
  const path = await resolveManagedManifest(
    dataRoot,
    depotId,
    manifestId,
    storedPath,
  )
  const contents = await readFile(path)
  const manifest: DepotManifest = key
    ? parseManifest(contents, key)
    : parseManifestEnvelope(contents)
  // Encrypted filenames prevent structural validation until a key is available.
  if (key || !manifest.filenames_encrypted)
    validateManifest(manifest, depotId, manifestId)
  else validateManifestEnvelope(manifest, depotId, manifestId)
  return path
}
