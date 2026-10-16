import { lstat, readdir, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveManifestPath } from '../filesystem.ts'
import {
  ApplicationTransactionError,
  type TransactionJournal,
} from './types.ts'

export async function assertTransactionSpace(
  stateDirectory: string,
  outputDirectory: string,
  stagingBytes: bigint,
  allocatedBytes: bigint,
  oldMoves: TransactionJournal['oldMoves'],
): Promise<void> {
  const [state, output] = await Promise.all([
    stat(stateDirectory),
    stat(outputDirectory),
  ])
  const remainingStaging =
    stagingBytes > allocatedBytes ? stagingBytes - allocatedBytes : 0n
  if (state.dev === output.dev) {
    await assertSpace(stateDirectory, remainingStaging)
    return
  }

  let backupBytes = 0n
  let freedBytes = 0n
  for (const action of oldMoves) {
    const usage = await pathUsage(
      resolveManifestPath(outputDirectory, action.path),
    )
    backupBytes += usage.logical
    freedBytes += usage.allocated
  }
  await assertSpace(stateDirectory, remainingStaging + backupBytes)
  // Old live files are removed only after their backups have been published.
  await assertSpace(
    outputDirectory,
    stagingBytes > freedBytes ? stagingBytes - freedBytes : 0n,
  )
}

async function pathUsage(
  path: string,
): Promise<{ logical: bigint; allocated: bigint }> {
  const info = await lstat(path, { bigint: true })
  if (info.isSymbolicLink())
    throw new Error(`Backup path became a symbolic link: ${path}`)
  if (!info.isDirectory())
    return { logical: info.size, allocated: info.blocks * 512n }
  const total = { logical: 0n, allocated: 0n }
  for (const name of await readdir(path)) {
    const usage = await pathUsage(join(path, name))
    total.logical += usage.logical
    total.allocated += usage.allocated
  }
  return total
}

async function assertSpace(path: string, required: bigint): Promise<void> {
  try {
    const info = await statfs(path, { bigint: true })
    const available = info.bavail * info.bsize
    if (required > available)
      throw new ApplicationTransactionError(
        'insufficient-space',
        `Transaction requires ${required} bytes but only ${available} are available at ${path}`,
      )
  } catch (error) {
    if (error instanceof ApplicationTransactionError) throw error
    // statfs is best-effort; actual allocation still reports ENOSPC.
  }
}
