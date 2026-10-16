import { access, lstat, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  depotKeyHexSchema,
  manifestIdSchema,
  steamIdSchema,
} from '../types/schemas.ts'

export function validateId(value: number, name: string): void {
  if (!steamIdSchema.safeParse(value).success) {
    throw new Error(`${name} must be a positive 32-bit integer`)
  }
}

export function validateManifestId(value: string): void {
  if (!manifestIdSchema.safeParse(value).success) {
    throw new Error('manifestId must be a decimal string')
  }
}

export function depotKeyFromHex(value: string): Buffer {
  return Buffer.from(depotKeyHexSchema.parse(value), 'hex')
}

export async function canonicalizeInstallDirectory(
  path: string,
  allowMissing = false,
): Promise<{
  path: string
  comparisonKey: string
}> {
  if (!path || !isAbsolute(path)) {
    throw new Error('Install path must be an absolute directory')
  }
  if (allowMissing) {
    const entry = await lstat(path).catch((error) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null
      throw error
    })
    if (!entry) {
      // Only the game folder may be absent; its chosen parent must already exist.
      const parent = await canonicalizeInstallDirectory(dirname(path))
      const name = basename(path)
      return {
        path: join(parent.path, name),
        comparisonKey: join(
          parent.comparisonKey,
          process.platform === 'darwin' || process.platform === 'win32'
            ? name.toLowerCase()
            : name,
        ),
      }
    }
  }
  const canonicalPath = await realpath(path)
  if (!(await stat(canonicalPath)).isDirectory()) {
    throw new Error('Install path must be a directory')
  }
  await access(canonicalPath, constants.W_OK)
  return {
    path: canonicalPath,
    comparisonKey:
      process.platform === 'darwin' || process.platform === 'win32'
        ? canonicalPath.toLowerCase()
        : canonicalPath,
  }
}
