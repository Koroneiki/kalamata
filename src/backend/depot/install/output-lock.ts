import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import { CONFIG_DIRECTORY } from './internal-paths.ts'
import { assertSafeInternalStatePaths } from './internal-state.ts'

const sqliteLockErrorSchema = z.object({
  code: z.string().optional(),
  errno: z.number().int().optional(),
})

export class OutputLockBusyError extends Error {
  constructor(outputDirectory: string, options?: ErrorOptions) {
    super(
      `Another install-path operation is already using ${outputDirectory}`,
      options,
    )
    this.name = 'OutputLockBusyError'
  }
}

export function isOutputLockBusyError(error: Error): boolean {
  const seen = new Set<Error>()
  let current: Error | undefined = error
  while (current && !seen.has(current)) {
    if (current instanceof OutputLockBusyError) return true
    seen.add(current)
    current = current.cause instanceof Error ? current.cause : undefined
  }
  return false
}

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
    if (error instanceof Error && isSqliteLockContention(error))
      throw new OutputLockBusyError(outputDirectory, { cause: error })
    throw error
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

function isSqliteLockContention(error: Error): boolean {
  const parsed = sqliteLockErrorSchema.safeParse(error)
  if (!parsed.success) return false
  const { code, errno } = parsed.data
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true
  // SQLite extended result codes retain the primary result in the low byte.
  if (errno === undefined) return false
  const primaryCode = errno & 0xff
  return primaryCode === 5 || primaryCode === 6
}
