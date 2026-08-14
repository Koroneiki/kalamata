import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { KalamataDatabase } from './database.ts'
import { pruneMissingManifestFiles } from './manifest-files.ts'

export * from './manifest-files.ts'
export * from './validation.ts'

async function discoverMigrationsFolder(): Promise<string> {
  const candidates = [
    join(import.meta.dir, 'migrations'),
    join(import.meta.dir, '..', 'db', 'migrations'),
  ]
  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'meta', '_journal.json'))
      return candidate
    } catch {
      // Try the packaged and source layouts without consulting the working directory.
    }
  }
  throw new Error('Bundled database migrations could not be located')
}

export async function openKalamataDatabase(
  dataRoot: string,
): Promise<KalamataDatabase> {
  const database = await KalamataDatabase.open(
    dataRoot,
    await discoverMigrationsFolder(),
  )
  await pruneMissingManifestFiles(database)
  return database
}
