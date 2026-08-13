import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { CONFIG_DIRECTORY } from './internal-paths.ts'
import { canonicalManifestPath } from '../manifests/manifest-utils.ts'
import type { ManifestChunk, ManifestFile } from '../manifests/types.ts'
import { filesystemErrorCode } from './transaction/types.ts'

const EXECUTABLE = 32

export function resolveManifestPath(root: string, filename: string): string {
  const normalized = canonicalManifestPath(filename)
  const outputRoot = resolve(root)
  const outputPath = resolve(outputRoot, normalized)
  const fromRoot = relative(outputRoot, outputPath)
  if (
    !fromRoot ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Manifest path escapes output directory: ${filename}`)
  }
  return outputPath
}

export function resolveOutputPath(root: string, filename: string): string {
  const outputPath = resolveManifestPath(root, filename)
  const firstSegment = relative(resolve(root), outputPath).split(sep, 1)[0]
  if (firstSegment?.toLowerCase() === CONFIG_DIRECTORY.toLowerCase()) {
    throw new Error(`Manifest path conflicts with internal state: ${filename}`)
  }
  return outputPath
}

export async function assertNoSymlinkTraversal(
  root: string,
  filename: string,
): Promise<void> {
  const outputRoot = resolve(root)
  const outputPath = resolveOutputPath(root, filename)
  const segments = relative(outputRoot, outputPath).split(sep)
  let current = outputRoot

  // Lexical containment does not prevent traversal through symlinked ancestors.
  // Reject existing symlinks in the manifest path before filesystem operations.
  for (const segment of segments) {
    current = resolve(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Manifest path traverses a symbolic link: ${filename}`)
      }
    } catch (error) {
      const code = filesystemErrorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw error
    }
  }
}

export async function preallocate(path: string, size: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'w')
  try {
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
}

export async function writeChunk(
  path: string,
  chunk: ManifestChunk,
  data: Buffer,
): Promise<void> {
  if (data.length !== Number(chunk.cb_original)) {
    throw new Error(
      `Chunk ${chunk.sha} has size ${data.length}, expected ${chunk.cb_original}`,
    )
  }
  const handle = await open(path, 'r+')
  try {
    await writeExactly(handle, data, Number(chunk.offset))
  } finally {
    await handle.close()
  }
}

async function writeExactly(
  handle: import('node:fs/promises').FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let total = 0
  while (total < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      total,
      buffer.length - total,
      position + total,
    )
    if (bytesWritten === 0)
      throw new Error('Filesystem write completed without writing data')
    total += bytesWritten
  }
}

export async function setExecutable(
  path: string,
  file: ManifestFile,
): Promise<void> {
  if (process.platform === 'win32') return
  const mode = (await stat(path)).mode
  const executeMask = 0o111
  const desired =
    file.flags & EXECUTABLE ? mode | executeMask : mode & ~executeMask
  if (desired !== mode) await chmod(path, desired)
}

export async function verifyFileSha1(
  path: string,
  expectedSha1: string,
  signal?: AbortSignal,
): Promise<void> {
  const hash = createHash('sha1')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { signal })
    stream.on('data', (data) => hash.update(data))
    stream.on('error', reject)
    stream.on('end', resolvePromise)
  })
  if (hash.digest('hex') !== expectedSha1.toLowerCase()) {
    throw new Error(`SHA1 mismatch for file ${path}`)
  }
}
