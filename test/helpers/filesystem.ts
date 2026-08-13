import { rm } from 'node:fs/promises'

export async function removeTemporaryDirectory(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    // Windows may briefly retain SQLite or antivirus file handles after close.
    maxRetries: 5,
    retryDelay: 100,
  })
}
