import { readFile } from 'node:fs/promises'
import { downloadDepotContent } from './content-downloader.ts'
import { readFileFilter } from './file-list.ts'
import {
  parseManifest,
  readDepotKey,
  validateManifest,
} from './local-inputs.ts'
import { SteamContentClient } from './steam-content-client.ts'
import type { SteamSession } from '../steam/steam-session.ts'
import type { DownloadDepotOptions, DownloadResult } from './types.ts'

export class DepotDownloadService {
  constructor(private readonly session: SteamSession) {}

  async download(options: DownloadDepotOptions): Promise<DownloadResult> {
    validateOptions(options)
    throwIfAborted(options.signal)
    const [key, manifestContents, fileFilter] = await Promise.all([
      readDepotKey(options.depotKeyPath, options.depotId),
      readFile(options.manifestPath),
      readFileFilter(options.fileListPath),
    ])
    throwIfAborted(options.signal)
    const manifest = parseManifest(manifestContents, key)
    validateManifest(manifest, options.depotId)
    throwIfAborted(options.signal)

    const controller = new AbortController()
    const onAbort = () =>
      controller.abort(
        options.signal?.reason ??
          new DOMException('Download aborted', 'AbortError'),
      )
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const removeDisconnectListener = this.session.onDisconnect((error) =>
      controller.abort(error),
    )
    try {
      const client = new SteamContentClient(await this.session.getClient(), key)
      try {
        throwIfAborted(controller.signal)
        return await downloadDepotContent(
          client,
          options,
          {
            manifest,
            manifestContents,
            depotKey: key,
            fileFilter,
          },
          controller.signal,
        )
      } finally {
        client.dispose()
      }
    } finally {
      removeDisconnectListener()
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

function validateOptions(options: DownloadDepotOptions): void {
  for (const [name, value] of [
    ['appId', options.appId],
    ['depotId', options.depotId],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
      throw new Error(`${name} must be a positive 32-bit integer`)
    }
  }
  if (
    !options.manifestPath ||
    !options.depotKeyPath ||
    !options.outputDirectory
  ) {
    throw new Error(
      'manifestPath, depotKeyPath, and outputDirectory are required',
    )
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
