import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
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

export async function canonicalizeInstallDirectory(path: string): Promise<{
  path: string
  comparisonKey: string
}> {
  if (!path || !isAbsolute(path)) {
    throw new Error('Install path must be an absolute directory')
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
