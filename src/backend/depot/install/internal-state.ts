import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { filesystemErrorCode } from './transaction/types.ts'

export async function assertSafeInternalStatePaths(
  directory: string,
): Promise<void> {
  for (const path of [
    directory,
    join(directory, 'transactions'),
    join(directory, 'repair-fallback'),
    join(directory, 'download.lock'),
    join(directory, 'coldclient-replacement.json'),
  ]) {
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error(
          `Internal state path must not be a symbolic link: ${path}`,
        )
    } catch (error) {
      if (filesystemErrorCode(error) !== 'ENOENT') throw error
    }
  }
}
