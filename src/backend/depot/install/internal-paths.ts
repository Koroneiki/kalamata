import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

export function installStateDirectory(
  dataRoot: string,
  outputDirectory: string,
): string {
  const path = resolve(outputDirectory)
  // Match the database's canonical install-path comparison on supported platforms.
  const key =
    process.platform === 'darwin' || process.platform === 'win32'
      ? path.toLowerCase()
      : path
  return join(
    dataRoot,
    'installations',
    createHash('sha256').update(key).digest('hex'),
  )
}
