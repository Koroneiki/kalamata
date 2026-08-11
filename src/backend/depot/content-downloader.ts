import { acquireOutputLock, DepotConfigStore } from './depot-config-store.ts'
import { downloadManifest } from './download-core.ts'
import type { ChunkClient } from './content-client.ts'
import type { FileFilter } from './file-list.ts'
import { validateManifest } from './local-inputs.ts'
import type {
  DepotManifest,
  DownloadDepotOptions,
  DownloadResult,
} from './types.ts'

interface ContentDownloadInputs {
  manifest: DepotManifest
  manifestContents: Buffer
  depotKey: Buffer
  fileFilter: FileFilter
}

export async function downloadDepotContent(
  client: ChunkClient,
  options: DownloadDepotOptions,
  inputs: ContentDownloadInputs,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  throwIfAborted(signal)
  const releaseLock = await acquireOutputLock(options.outputDirectory)
  try {
    return await downloadDepotContentLocked(client, options, inputs, signal)
  } finally {
    await releaseLock()
  }
}

async function downloadDepotContentLocked(
  client: ChunkClient,
  options: DownloadDepotOptions,
  inputs: ContentDownloadInputs,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  throwIfAborted(signal)
  const store = await DepotConfigStore.load(options.outputDirectory)
  const previousManifestId = store.getInstalledManifestId(options.depotId)

  const loadedPreviousManifest = previousManifestId
    ? await store.loadManifest(
        options.depotId,
        previousManifestId,
        inputs.depotKey,
      )
    : undefined
  let previousManifest: DepotManifest | undefined
  if (loadedPreviousManifest) {
    try {
      validateManifest(loadedPreviousManifest, options.depotId)
      previousManifest = loadedPreviousManifest
    } catch {
      previousManifest = undefined
    }
  }

  throwIfAborted(signal)
  // Cache the requested manifest before file changes so an interrupted run still has its metadata.
  await store.saveManifest(
    options.depotId,
    inputs.manifest.gid_manifest,
    inputs.manifestContents,
  )
  // The legacy helper mutates live files directly, so its prior identity is no
  // longer authoritative once execution begins.
  await store.setInstalledManifestId(options.depotId, null)

  const result = await downloadManifest(client, inputs.manifest, {
    appId: options.appId,
    depotId: options.depotId,
    outputDirectory: options.outputDirectory,
    verifyAll: options.verifyAll ?? false,
    stagingDirectory: store.stagingDirectory,
    fileFilter: inputs.fileFilter,
    ...(previousManifest ? { previousManifest } : {}),
    ...(signal ? { signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  })

  throwIfAborted(signal)
  // A file list is not a complete install and cannot replace the stable identity.
  if (!options.fileListPath)
    await store.setInstalledManifestId(
      options.depotId,
      inputs.manifest.gid_manifest,
    )
  return result
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
