import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  parseManifest,
  parseManifestEnvelope,
  validateManifest,
  validateManifestEnvelope,
} from '../backend/depot/local-inputs.ts'
import type { DepotManifest } from '../backend/depot/types.ts'
import type { KalamataDatabase, ManifestRow } from './database.ts'
import { validateId, validateManifestId } from './validation.ts'

const MANIFEST_FILENAME = /^([1-9]\d*)_(\d+)\.manifest$/

export function manifestRelativePath(
  depotId: number,
  manifestId: string,
): string {
  validateId(depotId, 'depotId')
  validateManifestId(manifestId)
  return `manifest-files/${depotId}_${manifestId}.manifest`
}

export async function syncManifestFiles(
  database: KalamataDatabase,
  now = Date.now(),
): Promise<void> {
  const entries = await readdir(join(database.dataRoot, 'manifest-files'), {
    withFileTypes: true,
  })
  const files = new Map<string, ManifestRow>()

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = MANIFEST_FILENAME.exec(entry.name)
    if (!match) continue

    const depotId = Number(match[1])
    const manifestId = match[2]
    try {
      const relativePath = manifestRelativePath(depotId, manifestId)
      if (basename(relativePath) !== entry.name) continue
      files.set(`${depotId}:${manifestId}`, {
        depotId,
        manifestId,
        relativePath,
      })
    } catch {
      // Files outside the managed naming contract are not database resources.
    }
  }

  const rows = database.sqlite
    .query<ManifestRow, []>(
      'SELECT depot_id AS depotId, manifest_id AS manifestId, relative_path AS relativePath FROM manifest_files',
    )
    .all()
  const stored = new Set(
    rows.map(({ depotId, manifestId }) => `${depotId}:${manifestId}`),
  )

  database.sqlite.transaction(() => {
    const remove = database.sqlite.query(
      'DELETE FROM manifest_files WHERE depot_id = ? AND manifest_id = ?',
    )
    for (const row of rows) {
      if (!files.has(`${row.depotId}:${row.manifestId}`)) {
        remove.run(row.depotId, row.manifestId)
      }
    }

    for (const [key, file] of files) {
      if (!stored.has(key)) {
        database.sqlite
          .query(
            'INSERT INTO manifest_files (depot_id, manifest_id, relative_path, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(file.depotId, file.manifestId, file.relativePath, now)
      }
    }
  })()
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
  if (key) validateManifest(manifest, depotId, manifestId)
  else validateManifestEnvelope(manifest, depotId, manifestId)
  return path
}
