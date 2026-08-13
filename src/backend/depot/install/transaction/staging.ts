import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { abortable } from '../../../shared/abortable.ts'
import { ContentServerSelector } from '../../transfer/content-server-selector.ts'
import { HttpStatusError } from '../../transfer/chunk-http.ts'
import type { ContentServer } from '../../transfer/chunk-client.ts'
import {
  preallocate,
  resolveManifestPath,
  resolveOutputPath,
  setExecutable,
  writeChunk,
} from '../filesystem.ts'
import { normalizeManifestSeparators } from '../../manifests/manifest-utils.ts'
import type { ManifestChunk, ManifestFile } from '../../manifests/types.ts'
import { completeChunk } from './journal.ts'
import { chunkKey, fileSize, isDirectory } from './projection.ts'
import {
  ApplicationTransactionError,
  emitProgress,
  isAbort,
  isFilesystemError,
  throwIfAborted,
  type ChunkDestination,
  type JournalContext,
  type ProgressState,
  type ProjectionEntry,
  type RunApplicationTransactionOptions,
  type StagedFile,
} from './types.ts'

const DOWNLOAD_CONCURRENCY = 8

export async function prepareStagedFiles(
  options: RunApplicationTransactionOptions,
  source: Map<string, ProjectionEntry>,
  changedFiles: ProjectionEntry[],
  stagingRoot: string,
  progress: ProgressState,
  journal: JournalContext,
): Promise<StagedFile[]> {
  const staged: StagedFile[] = []
  const destinations = new Map<string, ChunkDestination[]>()
  for (const entry of changedFiles) {
    throwIfAborted(options.signal)
    const relativePath = normalizeManifestSeparators(entry.file.filename)
    const stagingPath = resolveManifestPath(stagingRoot, relativePath)
    if (!journal.resumed) await preallocate(stagingPath, fileSize(entry.file))
    staged.push({ entry, relativePath, stagingPath })
    const depot = entry.depot as ChunkDestination['depot']
    for (const chunk of entry.file.chunks) {
      const key = chunkKey(chunk)
      const group = destinations.get(key) ?? []
      group.push({
        depot,
        appId: depot.ownerAppId ?? depot.appId ?? options.appId,
        file: entry.file,
        chunk,
        path: stagingPath,
      })
      destinations.set(key, group)
    }
  }

  const sourceCandidates = buildChunkCandidates(source, options.outputDirectory)
  const downloads = new Map<string, ChunkDestination[]>()
  for (const [key, group] of destinations) {
    throwIfAborted(options.signal)
    const completed = journal.journal.completedChunks[key]
    if (completed) {
      const logicalBytes = group.reduce(
        (sum, destination) => sum + BigInt(destination.chunk.cb_original),
        0n,
      )
      progress.logicalInstalledCompleted += logicalBytes
      if (completed.source === 'local') progress.reusedLocal += logicalBytes
      progress.actualNetwork += BigInt(completed.networkBytes)
      continue
    }
    const candidate = await reusableChunk(
      sourceCandidates.get(key) ?? [],
      options.signal,
    )
    if (!candidate) {
      downloads.set(key, group)
      continue
    }
    const data = candidate.data
    for (const destination of group) {
      await writeChunk(destination.path, destination.chunk, data)
      const bytes = BigInt(destination.chunk.cb_original)
      progress.reusedLocal += bytes
      progress.logicalInstalledCompleted += bytes
    }
    await completeChunk(journal, key, 'local', 0)
    emitProgress(options, progress)
  }

  emitProgress(options, progress)
  if (downloads.size > 0)
    options.onEvent?.({ type: 'phase', phase: 'downloading' })
  await downloadChunks(options, downloads, progress, journal)

  options.onEvent?.({ type: 'phase', phase: 'verifying' })
  for (const item of staged) {
    throwIfAborted(options.signal)
    try {
      await setExecutable(item.stagingPath, item.entry.file)
    } catch (error) {
      if (isFilesystemError(error)) throw error
      throw new ApplicationTransactionError(
        'integrity',
        `Staged file failed SHA-1 verification: ${item.relativePath}`,
        { cause: error },
      )
    }
  }
  return staged
}

export async function estimateDownloadPayload(
  source: Map<string, ProjectionEntry>,
  changedFiles: ProjectionEntry[],
  outputDirectory: string,
): Promise<bigint> {
  // Match staging: only installed-source chunks can be copied for partial reuse.
  const candidates = buildChunkCandidates(source, outputDirectory)
  const chunks = new Map<string, number>()
  for (const { file } of changedFiles)
    for (const chunk of file.chunks) {
      const key = chunkKey(chunk)
      chunks.set(key, Math.max(chunks.get(key) ?? 0, chunk.cb_compressed))
    }

  let total = 0n
  for (const [key, size] of chunks) {
    if (await reusableChunk(candidates.get(key) ?? [])) continue
    total += BigInt(size)
  }
  return total
}

async function downloadChunks(
  options: RunApplicationTransactionOptions,
  downloads: Map<string, ChunkDestination[]>,
  progress: ProgressState,
  journal: JournalContext,
): Promise<void> {
  const jobs = [...downloads.values()]
  const serverPools = new Map<string, Promise<ContentServerSelector | null>>()
  let next = 0
  const controller = new AbortController()
  const abort = () =>
    controller.abort(
      options.signal?.reason ??
        new DOMException('Transaction aborted', 'AbortError'),
    )
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })

  const worker = async () => {
    while (true) {
      throwIfAborted(controller.signal)
      const group = jobs[next++]
      if (!group) return
      try {
        const downloaded = await fetchChunk(
          group,
          controller.signal,
          serverPools,
        )
        throwIfAborted(controller.signal)
        progress.actualNetwork += BigInt(downloaded.networkBytes)
        for (const destination of group) {
          await writeChunk(
            destination.path,
            destination.chunk,
            downloaded.chunk,
          )
          progress.logicalInstalledCompleted += BigInt(
            destination.chunk.cb_original,
          )
        }
        await completeChunk(
          journal,
          chunkKey(group[0]!.chunk),
          'network',
          downloaded.networkBytes,
        )
        emitProgress(options, progress)
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error)
        throw error
      }
    }
  }

  try {
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) },
        worker,
      ),
    )
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw controller.signal.reason ?? failed.reason
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

async function fetchChunk(
  destinations: ChunkDestination[],
  signal: AbortSignal,
  serverPools: Map<string, Promise<ContentServerSelector | null>>,
): Promise<{ chunk: Buffer; networkBytes: number }> {
  let lastError: unknown
  let foundServers = false
  const resources = uniqueResources(destinations)
  for (const resource of resources) {
    throwIfAborted(signal)
    let pool: ContentServerSelector | null
    try {
      const cacheKey = `${resource.appId}:${resource.depot.depotId}`
      let request = serverPools.get(cacheKey)
      if (!request) {
        request = abortable(
          resource.depot.client.getContentServers(resource.appId),
          signal,
        ).then(({ servers }) =>
          servers.length > 0 ? new ContentServerSelector(servers) : null,
        )
        serverPools.set(cacheKey, request)
      }
      pool = await abortable(request, signal)
    } catch (error) {
      if (isAbort(error, signal)) throw error
      lastError = new ApplicationTransactionError(
        'steam',
        `Could not list content servers for app ${resource.appId}`,
        { cause: error },
      )
      continue
    }
    if (!pool) continue
    foundServers = true
    const attempted = new Set<ContentServer>()
    for (let attempt = 0; attempt < pool.attemptsPerChunk; attempt++) {
      throwIfAborted(signal)
      const server = pool.getConnection(attempted)
      attempted.add(server)
      try {
        const first = destinations[0]!
        let downloaded
        try {
          downloaded = await resource.depot.client.downloadChunk(
            resource.appId,
            resource.depot.depotId,
            first.chunk.sha,
            server,
            signal,
            Number(first.chunk.cb_original),
          )
        } catch (error) {
          if (
            !(error instanceof HttpStatusError) ||
            error.retryAfterMs === null
          )
            throw error
          await sleep(error.retryAfterMs, undefined, { signal })
          downloaded = await resource.depot.client.downloadChunk(
            resource.appId,
            resource.depot.depotId,
            first.chunk.sha,
            server,
            signal,
            Number(first.chunk.cb_original),
          )
        }
        if (downloaded.chunk.length !== Number(first.chunk.cb_original)) {
          throw new ApplicationTransactionError(
            'unavailable-content',
            `Chunk ${first.chunk.sha} has an unexpected size`,
          )
        }
        pool.returnConnection(server)
        return {
          chunk: downloaded.chunk,
          networkBytes: networkByteCount(
            downloaded.networkBytes,
            downloaded.chunk.length,
          ),
        }
      } catch (error) {
        if (isAbort(error, signal)) throw error
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
          throw new ApplicationTransactionError(
            'insufficient-space',
            'Insufficient space while transferring staged content',
            { cause: error },
          )
        lastError = error
        pool.returnBrokenConnection(server)
      }
    }
  }
  if (!foundServers)
    throw new ApplicationTransactionError(
      'unavailable-resource',
      'No eligible Steam content servers are available',
      { cause: lastError },
    )
  if (
    lastError instanceof HttpStatusError &&
    (lastError.statusCode === 401 || lastError.statusCode === 403)
  )
    throw new ApplicationTransactionError(
      'steam',
      'Steam content authorization was exhausted',
      { cause: lastError },
    )
  if (lastError instanceof HttpStatusError && lastError.statusCode === 404)
    throw new ApplicationTransactionError(
      'unavailable-content',
      `Chunk ${destinations[0]!.chunk.sha} is unavailable`,
      { cause: lastError },
    )
  throw new ApplicationTransactionError(
    'transfer-exhausted',
    `Every eligible server failed for chunk ${destinations[0]!.chunk.sha}`,
    { cause: lastError },
  )
}

function buildChunkCandidates(
  source: Map<string, ProjectionEntry>,
  outputDirectory: string,
): Map<string, { path: string; file: ManifestFile; chunk: ManifestChunk }[]> {
  const result = new Map<
    string,
    { path: string; file: ManifestFile; chunk: ManifestChunk }[]
  >()
  for (const entry of source.values()) {
    if (isDirectory(entry.file)) continue
    const path = resolveOutputPath(outputDirectory, entry.file.filename)
    for (const chunk of entry.file.chunks) {
      const key = chunkKey(chunk)
      const group = result.get(key) ?? []
      group.push({ path, file: entry.file, chunk })
      result.set(key, group)
    }
  }
  return result
}

async function reusableChunk(
  candidates: { path: string; file: ManifestFile; chunk: ManifestChunk }[],
  signal?: AbortSignal,
): Promise<
  | { path: string; file: ManifestFile; chunk: ManifestChunk; data: Buffer }
  | undefined
> {
  for (const candidate of candidates) {
    throwIfAborted(signal)
    try {
      const data = await readChunk(candidate.path, candidate.chunk)
      if (
        createHash('sha1').update(data).digest('hex') ===
        candidate.chunk.sha.toLowerCase()
      )
        return { ...candidate, data }
    } catch (error) {
      if (
        isFilesystemError(error) &&
        !['ENOENT', 'ENOTDIR', 'EISDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
    }
  }
  return undefined
}

async function readChunk(path: string, chunk: ManifestChunk): Promise<Buffer> {
  const data = Buffer.alloc(Number(chunk.cb_original))
  const handle = await open(path, 'r')
  try {
    let read = 0
    while (read < data.length) {
      const result = await handle.read(
        data,
        read,
        data.length - read,
        Number(chunk.offset) + read,
      )
      if (result.bytesRead === 0)
        throw new ApplicationTransactionError(
          'integrity',
          `Could not read reusable chunk ${chunk.sha}`,
        )
      read += result.bytesRead
    }
  } finally {
    await handle.close()
  }
  return data
}

function uniqueResources(destinations: ChunkDestination[]) {
  const resources = new Map<
    string,
    { depot: ChunkDestination['depot']; appId: number }
  >()
  for (const destination of destinations) {
    const appId = destination.appId
    resources.set(`${appId}:${destination.depot.depotId}`, {
      depot: destination.depot,
      appId,
    })
  }
  return [...resources.values()]
}

function networkByteCount(value: number | undefined, fallback: number): number {
  const bytes = value ?? fallback
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new ApplicationTransactionError(
      'unavailable-content',
      'Content server returned an invalid network byte count',
    )
  return bytes
}
