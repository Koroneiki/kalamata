import { createHash } from 'node:crypto'
import { cp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { filesystemErrorCode } from './types.ts'

export function moveTemporaryPath(
  destination: string,
  transactionId: string,
): string {
  const key = createHash('sha256')
    .update(transactionId)
    .update('\0')
    .update(destination)
    .digest('hex')
  return join(dirname(destination), `.kalamata-${key}.tmp`)
}

export async function movePath(
  source: string,
  destination: string,
  transactionId: string,
  onCopyBoundary: (boundary: 'copied' | 'published') => void,
): Promise<void> {
  try {
    await rename(source, destination)
    return
  } catch (error) {
    if (filesystemErrorCode(error) !== 'EXDEV') throw error
  }

  // Cross-volume copies are not atomic. Publish only a complete copy using a
  // rename on the destination volume; a restart replaces any partial temporary.
  const temporary = moveTemporaryPath(destination, transactionId)
  await rm(temporary, { recursive: true, force: true })
  await cp(source, temporary, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
  })
  onCopyBoundary('copied')
  await rename(temporary, destination)
  onCopyBoundary('published')
  await rm(source, { recursive: true, force: true })
}
