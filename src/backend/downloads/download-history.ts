import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DOWNLOAD_HISTORY_LIMIT,
  downloadHistorySchema,
  type DownloadHistoryEntry,
} from '../../types/download-history.ts'
import type { BackgroundDownloadJob } from '../../types/background-downloads.ts'
import type { OperationLifecycleEvent } from '../operations/download-queue.ts'
import { writeDurableJson } from '../filesystem/durable-json.ts'
import { backgroundDownloadLabel } from '../../utils/background-downloads.ts'

export class DownloadHistory {
  readonly #path: string
  #entries: DownloadHistoryEntry[] = []
  #writes: Promise<void> = Promise.resolve()

  constructor(
    userDataRoot: string,
    private readonly changed: (
      entries: DownloadHistoryEntry[],
    ) => void = () => {},
    private readonly reportError: (error: Error) => void = () => {},
  ) {
    this.#path = join(userDataRoot, 'activity-history.json')
  }

  async initialize(): Promise<void> {
    try {
      this.#entries = downloadHistorySchema.parse(
        JSON.parse(await readFile(this.#path, 'utf8')),
      )
    } catch (cause) {
      // Missing or damaged cosmetic history must not block application startup.
      if (
        !(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
      )
        this.reportError(
          cause instanceof Error ? cause : new Error(String(cause)),
        )
    }
  }

  snapshot(): DownloadHistoryEntry[] {
    return structuredClone(this.#entries)
  }

  recordJob(job: BackgroundDownloadJob): void {
    if (
      job.finishedAt === null ||
      !['completed', 'failed'].includes(job.status)
    )
      return
    this.append({
      id: job.id,
      appId: job.appId,
      title: job.title,
      description: backgroundDownloadLabel(job),
      totalBytes: job.totalBytes === null ? null : String(job.totalBytes),
      compact: true,
      status: job.status === 'completed' ? 'completed' : 'failed',
      transferredBytes: String(job.transferredBytes),
      error: job.error,
      finishedAt: job.finishedAt,
    })
  }

  recordOperation(event: OperationLifecycleEvent): void {
    if (
      event.event !== 'operation.completed' &&
      event.event !== 'operation.failed' &&
      event.event !== 'operation.cancelled'
    )
      return
    this.append({
      // A resumed operation can have several failed attempts before completion.
      id: randomUUID(),
      appId: event.appId,
      title: `App ${event.appId}`,
      compact: false,
      status:
        event.event === 'operation.completed'
          ? 'completed'
          : event.event === 'operation.cancelled'
            ? 'cancelled'
            : 'failed',
      transferredBytes: event.networkBytes,
      error: event.event === 'operation.failed' ? event.error : null,
      finishedAt: Date.now(),
    })
  }

  clear(): Promise<void> {
    this.#entries = []
    return this.save()
  }

  dismiss(id: string): Promise<void> {
    this.#entries = this.#entries.filter((entry) => entry.id !== id)
    return this.save()
  }

  flush(): Promise<void> {
    return this.#writes
  }

  private append(entry: DownloadHistoryEntry): void {
    this.#entries = [entry, ...this.#entries].slice(0, DOWNLOAD_HISTORY_LIMIT)
    void this.save().catch(() => {})
  }

  private save(): Promise<void> {
    const entries = this.snapshot()
    const write = this.#writes.then(() => writeDurableJson(this.#path, entries))
    // Serialize changes so Clear all cannot be overwritten by an older write.
    this.#writes = write.catch((cause) => {
      this.reportError(
        cause instanceof Error ? cause : new Error(String(cause)),
      )
    })
    try {
      this.changed(entries)
    } catch {
      // A detached webview must not prevent downloads from finishing.
    }
    return write
  }
}
