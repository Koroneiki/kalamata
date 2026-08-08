import { mkdir, rm, rmdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CDNClientPool } from './cdn-client-pool.ts'
import type { ChunkClient } from './content-client.ts'
import { CONFIG_DIRECTORY, STAGING_DIRECTORY } from './depot-paths.ts'
import type { FileFilter } from './file-list.ts'
import {
  adlerForChunk,
  assertNoSymlinkTraversal,
  existingFileSize,
  preallocate,
  preflightManifestPaths,
  rebuildWithChunkMatches,
  resolveManifestPath,
  resolveOutputPath,
  restoreStagedPaths,
  setExecutable,
  stageTypeTransitions,
  verifyFileSha1,
  writeChunk,
  type ChunkMatch,
} from './files.ts'
import {
  DIRECTORY,
  manifestPathKey,
  withImpliedDirectories,
} from './manifest-utils.ts'
import type {
  DepotManifest,
  DownloadEvent,
  DownloadResult,
  ManifestChunk,
  ManifestFile,
} from './types.ts'

const DOWNLOAD_CONCURRENCY = 8

export type { ChunkClient, ContentServer } from './content-client.ts'

interface ChunkJob {
  path: string
  chunk: ManifestChunk
}

export interface CoreOptions {
  appId: number
  depotId: number
  outputDirectory: string
  verifyAll: boolean
  previousManifest?: DepotManifest
  stagingDirectory?: string
  fileFilter?: FileFilter
  signal?: AbortSignal
  onEvent?: (event: DownloadEvent) => void
}

export async function downloadManifest(
  client: ChunkClient,
  manifest: DepotManifest,
  options: CoreOptions,
): Promise<DownloadResult> {
  const includeFile = options.fileFilter ?? (() => true)
  const currentFiles = manifest.files.filter((file) =>
    includeFile(file.filename),
  )
  await preflightManifestPaths(options.outputDirectory, currentFiles)
  const stagingDirectory =
    options.stagingDirectory ??
    join(options.outputDirectory, CONFIG_DIRECTORY, STAGING_DIRECTORY)
  const transitionDirectory = join(
    stagingDirectory,
    `transitions-${randomUUID()}`,
  )
  const effectiveCurrentFiles = withImpliedDirectories(currentFiles)
  const staged = await stageTypeTransitions(
    options.outputDirectory,
    transitionDirectory,
    effectiveCurrentFiles,
    withImpliedDirectories(options.previousManifest?.files ?? []),
  )

  try {
    const result = await downloadManifestCore(
      client,
      manifest,
      options,
      currentFiles,
      includeFile,
    )
    await rm(transitionDirectory, { recursive: true, force: true })
    return result
  } catch (error) {
    try {
      await restoreStagedPaths(staged)
      await rm(transitionDirectory, { recursive: true, force: true })
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Download failed and type transitions could not be restored`,
      )
    }
    throw error
  }
}

async function downloadManifestCore(
  client: ChunkClient,
  manifest: DepotManifest,
  options: CoreOptions,
  currentFiles: ManifestFile[],
  includeFile: FileFilter,
): Promise<DownloadResult> {
  const previousFiles = new Map(
    (options.previousManifest?.files ?? [])
      .filter((file) => includeFile(file.filename))
      .map((file) => [manifestPathKey(file.filename), file]),
  )
  const currentPathKeys = new Set(
    withImpliedDirectories(currentFiles).map((file) =>
      manifestPathKey(file.filename),
    ),
  )
  const currentFilePathKeys = new Set(
    currentFiles
      .filter((file) => !(file.flags & DIRECTORY))
      .map((file) => manifestPathKey(file.filename)),
  )
  const stagingDirectory =
    options.stagingDirectory ??
    join(options.outputDirectory, CONFIG_DIRECTORY, STAGING_DIRECTORY)
  const jobs: ChunkJob[] = []
  const remainingByFile = new Map<string, number>()
  const resolvedPaths = new Set<string>()
  let reusedBytes = 0n
  let downloadedBytes = 0n
  const total = currentFiles
    .filter((file) => !(file.flags & DIRECTORY))
    .reduce((sum, file) => sum + BigInt(file.size), 0n)

  for (const file of currentFiles) {
    throwIfAborted(options.signal)
    const outputPath = resolveOutputPath(options.outputDirectory, file.filename)
    if (resolvedPaths.has(outputPath))
      throw new Error(`Duplicate manifest path: ${file.filename}`)
    resolvedPaths.add(outputPath)

    if (file.flags & DIRECTORY) {
      await mkdir(outputPath, { recursive: true })
      continue
    }

    const size = fileSize(file)
    const existingSize = await existingFileSize(outputPath)
    const oldFile = previousFiles.get(manifestPathKey(file.filename))
    let needed: ManifestChunk[]

    if (existingSize === undefined) {
      await preallocate(outputPath, size)
      needed = file.chunks
    } else if (oldFile) {
      const hashMatches =
        oldFile.sha_content.toLowerCase() === file.sha_content.toLowerCase()
      if (!options.verifyAll && hashMatches && existingSize === size) {
        reusedBytes += BigInt(size)
        await setExecutable(outputPath, file)
        options.onEvent?.({ type: 'file-complete', path: outputPath })
        continue
      }

      if (options.verifyAll)
        options.onEvent?.({ type: 'file-validating', path: outputPath })
      const plan = await planChunkReuse(
        outputPath,
        oldFile,
        file,
        options.signal,
      )
      needed = plan.needed
      reusedBytes += reusedSize(plan.valid)

      if (!hashMatches || needed.length > 0 || existingSize !== size) {
        const stagingPath = resolveManifestPath(stagingDirectory, file.filename)
        await rebuildWithChunkMatches(outputPath, stagingPath, size, plan.valid)
      }
    } else {
      options.onEvent?.({ type: 'file-validating', path: outputPath })
      const plan = await planCurrentFileReuse(outputPath, file, options.signal)
      needed = plan.needed
      reusedBytes += reusedSize(plan.valid)
      if (needed.length > 0 || existingSize !== size) {
        const stagingPath = resolveManifestPath(stagingDirectory, file.filename)
        await rebuildWithChunkMatches(outputPath, stagingPath, size, plan.valid)
      }
    }

    await setExecutable(outputPath, file)
    if (needed.length === 0) {
      options.onEvent?.({ type: 'file-complete', path: outputPath })
      continue
    }
    remainingByFile.set(outputPath, needed.length)
    for (const chunk of needed) jobs.push({ path: outputPath, chunk })
  }

  options.onEvent?.({
    type: 'progress',
    downloaded: reusedBytes.toString(),
    total: total.toString(),
  })
  if (jobs.length > 0) {
    const { servers } = await client.getContentServers(options.appId)
    const pool = new CDNClientPool(servers)
    await runWorkers(client, jobs, remainingByFile, pool, options, (bytes) => {
      downloadedBytes += BigInt(bytes)
      options.onEvent?.({
        type: 'progress',
        downloaded: (reusedBytes + downloadedBytes).toString(),
        total: total.toString(),
      })
    })
  }

  if (options.verifyAll) {
    for (const file of currentFiles) {
      if (file.flags & DIRECTORY) continue
      throwIfAborted(options.signal)
      await verifyFileSha1(
        resolveOutputPath(options.outputDirectory, file.filename),
        file.sha_content,
      )
    }
  }

  throwIfAborted(options.signal)
  await deleteObsoleteFiles(
    options.previousManifest,
    currentPathKeys,
    currentFilePathKeys,
    includeFile,
    options,
  )
  throwIfAborted(options.signal)
  return {
    manifestId: manifest.gid_manifest,
    downloadedBytes: downloadedBytes.toString(),
    reusedBytes: reusedBytes.toString(),
  }
}

async function planChunkReuse(
  path: string,
  oldFile: ManifestFile,
  newFile: ManifestFile,
  signal?: AbortSignal,
): Promise<{ needed: ManifestChunk[]; valid: ChunkMatch[] }> {
  const oldChunks = new Map<string, ManifestChunk>()
  for (const chunk of oldFile.chunks)
    oldChunks.set(chunk.sha.toLowerCase(), chunk)

  const needed: ManifestChunk[] = []
  const candidates: ChunkMatch[] = []
  for (const chunk of newFile.chunks) {
    const oldChunk = oldChunks.get(chunk.sha.toLowerCase())
    if (!oldChunk || Number(oldChunk.cb_original) !== Number(chunk.cb_original))
      needed.push(chunk)
    else candidates.push({ source: oldChunk, destination: chunk })
  }

  const valid: ChunkMatch[] = []
  for (const match of candidates.sort(
    (left, right) => Number(left.source.offset) - Number(right.source.offset),
  )) {
    throwIfAborted(signal)
    if ((await adlerForChunk(path, match.source)) === match.source.crc >>> 0)
      valid.push(match)
    else needed.push(match.destination)
  }
  return { needed, valid }
}

async function planCurrentFileReuse(
  path: string,
  file: ManifestFile,
  signal?: AbortSignal,
): Promise<{ needed: ManifestChunk[]; valid: ChunkMatch[] }> {
  const needed: ManifestChunk[] = []
  const valid: ChunkMatch[] = []
  for (const chunk of [...file.chunks].sort(
    (left, right) => Number(left.offset) - Number(right.offset),
  )) {
    throwIfAborted(signal)
    if ((await adlerForChunk(path, chunk)) === chunk.crc >>> 0)
      valid.push({ source: chunk, destination: chunk })
    else needed.push(chunk)
  }
  return { needed, valid }
}

async function runWorkers(
  client: ChunkClient,
  jobs: ChunkJob[],
  remainingByFile: Map<string, number>,
  pool: CDNClientPool,
  options: CoreOptions,
  onDownloaded: (bytes: number) => void,
): Promise<void> {
  const controller = new AbortController()
  const onAbort = () =>
    controller.abort(
      options.signal?.reason ??
        new DOMException('Download aborted', 'AbortError'),
    )
  if (options.signal?.aborted) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })

  const groupedJobs = groupChunkJobs(jobs)
  let nextJob = 0
  const worker = async (): Promise<void> => {
    try {
      while (true) {
        throwIfAborted(controller.signal)
        const group = groupedJobs[nextJob++]
        if (!group) return
        const data = await downloadWithRetry(
          client,
          group[0]!.chunk,
          pool,
          options,
          controller.signal,
        )
        throwIfAborted(controller.signal)
        for (const job of group) {
          await writeChunk(job.path, job.chunk, data)
          onDownloaded(data.length)

          const remaining = (remainingByFile.get(job.path) ?? 1) - 1
          remainingByFile.set(job.path, remaining)
          if (remaining === 0)
            options.onEvent?.({ type: 'file-complete', path: job.path })
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error)
      throw error
    }
  }

  try {
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.min(DOWNLOAD_CONCURRENCY, groupedJobs.length) },
        worker,
      ),
    )
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw controller.signal.reason ?? failed.reason
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

function groupChunkJobs(jobs: ChunkJob[]): ChunkJob[][] {
  const groups = new Map<string, ChunkJob[]>()
  for (const job of jobs) {
    const key = job.chunk.sha.toLowerCase()
    const group = groups.get(key)
    if (!group) {
      groups.set(key, [job])
      continue
    }
    if (Number(group[0]!.chunk.cb_original) !== Number(job.chunk.cb_original)) {
      throw new Error(
        `Manifest uses inconsistent sizes for chunk ${job.chunk.sha}`,
      )
    }
    group.push(job)
  }
  return [...groups.values()]
}

async function downloadWithRetry(
  client: ChunkClient,
  chunk: ManifestChunk,
  pool: CDNClientPool,
  options: CoreOptions,
  signal: AbortSignal,
): Promise<Buffer> {
  let lastError: unknown
  for (let attempt = 0; attempt < pool.attemptsPerChunk; attempt++) {
    throwIfAborted(signal)
    const server = pool.getConnection()
    try {
      const data = (
        await client.downloadChunk(
          options.appId,
          options.depotId,
          chunk.sha,
          server,
          signal,
          Number(chunk.cb_original),
        )
      ).chunk
      pool.returnConnection(server)
      return data
    } catch (error) {
      lastError = error
      pool.returnBrokenConnection(server)
      options.onEvent?.({
        type: 'retry',
        chunk: chunk.sha,
        attempt: attempt + 1,
      })
    }
  }
  throw new Error(`Failed to download chunk ${chunk.sha}`, { cause: lastError })
}

async function deleteObsoleteFiles(
  previousManifest: DepotManifest | undefined,
  currentPathKeys: Set<string>,
  currentFilePathKeys: Set<string>,
  includeFile: FileFilter,
  options: CoreOptions,
): Promise<void> {
  if (!previousManifest) return
  for (const file of previousManifest.files) {
    if (
      file.flags & DIRECTORY ||
      !includeFile(file.filename) ||
      currentPathKeys.has(manifestPathKey(file.filename)) ||
      hasFileAncestor(file.filename, currentFilePathKeys)
    )
      continue
    throwIfAborted(options.signal)
    await assertNoSymlinkTraversal(options.outputDirectory, file.filename)
    const path = resolveOutputPath(options.outputDirectory, file.filename)
    await rm(path, { force: true })
    options.onEvent?.({ type: 'file-deleted', path })
  }
  const obsoleteDirectories = previousManifest.files
    .filter(
      (file) =>
        file.flags & DIRECTORY &&
        includeFile(file.filename) &&
        !currentPathKeys.has(manifestPathKey(file.filename)),
    )
    .sort((left, right) => right.filename.length - left.filename.length)
  for (const directory of obsoleteDirectories) {
    throwIfAborted(options.signal)
    await assertNoSymlinkTraversal(options.outputDirectory, directory.filename)
    try {
      await rmdir(
        resolveOutputPath(options.outputDirectory, directory.filename),
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST')
        throw error
    }
  }
}

function hasFileAncestor(
  filename: string,
  currentFilePathKeys: Set<string>,
): boolean {
  const segments = filename.replaceAll('\\', '/').split('/')
  for (let length = 1; length < segments.length; length++) {
    if (
      currentFilePathKeys.has(
        manifestPathKey(segments.slice(0, length).join('/')),
      )
    )
      return true
  }
  return false
}

function reusedSize(matches: ChunkMatch[]): bigint {
  return matches.reduce(
    (sum, match) => sum + BigInt(match.destination.cb_original),
    0n,
  )
}

function fileSize(file: ManifestFile): number {
  const size = Number(file.size)
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error(`Invalid size for ${file.filename}`)
  return size
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
