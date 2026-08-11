import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { CONFIG_DIRECTORY } from './internal-paths.ts'
import { assertSafeInternalStatePaths } from './internal-state.ts'

export async function acquireOutputLock(
  outputDirectory: string,
): Promise<() => Promise<void>> {
  await assertSafeInternalStatePaths(outputDirectory)
  const directory = join(outputDirectory, CONFIG_DIRECTORY)
  const ownerPath = join(directory, 'download.lock')
  await mkdir(directory, { recursive: true })
  let database: Database | undefined
  try {
    database = new Database(ownerPath, { create: true })
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;')
  } catch (error) {
    database?.close(false)
    throw new Error(`Another download is already using ${outputDirectory}`, {
      cause: error,
    })
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      database.exec('COMMIT')
    } finally {
      database.close(false)
    }
  }
}
