import { resolveOutputPath, verifyFileSha1 } from '../filesystem.ts'
import {
  executableModeMatches,
  isConfigFile,
  isDirectory,
  isUserConfig,
  safeLstat,
  sameManifestOwner,
} from './projection.ts'
import {
  ApplicationTransactionError,
  isFilesystemError,
  throwIfAborted,
  type ProjectionEntry,
} from './types.ts'

// Preview and execution share this predicate so estimates match staged files.
export async function projectionEntryNeedsStaging(
  entry: ProjectionEntry,
  previous: ProjectionEntry | undefined,
  outputDirectory: string,
  kind: 'download' | 'reconcile' | 'repair',
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal)
  const wantsDirectory = isDirectory(entry.file)
  const path = resolveOutputPath(outputDirectory, entry.file.filename)
  const info = await safeLstat(path)
  if (info?.isSymbolicLink())
    throw new ApplicationTransactionError(
      'planning',
      `Managed path became a symbolic link: ${entry.file.filename}`,
    )
  if (
    !wantsDirectory &&
    info?.isFile() &&
    isConfigFile(entry.file) &&
    (isUserConfig(entry.file) || sameManifestOwner(previous, entry))
  )
    return false
  if (kind !== 'repair' && sameManifestOwner(previous, entry)) return false
  if (wantsDirectory) return !info?.isDirectory()
  if (!info?.isFile()) return true
  try {
    await verifyFileSha1(path, entry.file.sha_content, signal)
    return !executableModeMatches(info.mode, entry.file)
  } catch (error) {
    throwIfAborted(signal)
    if (isFilesystemError(error)) throw error
    return true
  }
}
