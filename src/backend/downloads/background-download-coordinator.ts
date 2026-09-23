import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BackgroundDownloadJob,
  BackgroundDownloadsSnapshot,
} from '../../types/background-downloads.ts'

export interface JobContext {
  signal: AbortSignal
  workspace: string
  progress: (
    phase: string,
    transferredBytes?: number,
    totalBytes?: number | null,
  ) => void
  setSource: (source: string) => void
  beginPublish: () => void
}

export interface JobDefinition<T> {
  key: string
  kind: BackgroundDownloadJob['kind']
  title: string
  source?: string
  appId?: number
  depotId?: number
  canCancel?: boolean
  run: (context: JobContext) => Promise<T>
}

interface JobRecord {
  state: BackgroundDownloadJob
  controller: AbortController
  definition: JobDefinition<unknown>
  result: Promise<unknown>
  start: () => void
  publishing: boolean
}

export class BackgroundDownloadCoordinator {
  readonly #root: string
  readonly #jobs = new Map<string, JobRecord>()
  readonly #pending = new Map<string, JobRecord>()
  #running: JobRecord | undefined
  #priorityId: string | undefined
  #accepting = false

  constructor(
    userDataRoot: string,
    private readonly changed: (snapshot: BackgroundDownloadsSnapshot) => void,
  ) {
    this.#root = join(userDataRoot, 'background-downloads')
  }

  async initialize() {
    // A new process never resumes incomplete transfers.
    await rm(this.#root, { recursive: true, force: true })
    await mkdir(this.#root, { recursive: true })
    this.#accepting = true
  }

  snapshot(): BackgroundDownloadsSnapshot {
    const jobs = [...this.#jobs.values()].map(({ state }) => ({ ...state }))
    const priority = jobs.findIndex(({ id }) => id === this.#priorityId)
    const firstQueued = jobs.findIndex(({ status }) => status === 'queued')
    if (priority > firstQueued && firstQueued !== -1)
      jobs.splice(firstQueued, 0, jobs.splice(priority, 1)[0]!)
    return { jobs }
  }

  enqueue<T>(definition: JobDefinition<T>): Promise<T> {
    if (!this.#accepting)
      throw new Error('Background downloads are shutting down')
    const pending = this.#pending.get(definition.key)
    if (pending) {
      // SAFETY: one semantic key is created with one result type by its provider.
      return pending.result as Promise<T>
    }
    const id = randomUUID()
    const controller = new AbortController()
    const workspace = join(this.#root, id)
    const state: BackgroundDownloadJob = {
      id,
      key: definition.key,
      kind: definition.kind,
      title: definition.title,
      appId: definition.appId ?? null,
      depotId: definition.depotId ?? null,
      status: 'queued',
      phase: 'preparing',
      source: definition.source ?? null,
      transferredBytes: 0,
      totalBytes: null,
      error: null,
    }
    let start!: () => void
    const ready = new Promise<void>((resolve) => {
      start = resolve
    })
    const record: JobRecord = {
      state,
      controller,
      definition,
      result: undefined!,
      start,
      publishing: false,
    }
    this.#jobs.set(id, record)
    this.#pending.set(definition.key, record)
    this.notify()
    record.result = (async () => {
      let outcome: BackgroundDownloadJob['status'] = 'completed'
      let result!: T
      let failure: unknown
      let failed = false
      try {
        await ready
        controller.signal.throwIfAborted()
        await mkdir(workspace, { recursive: true })
        controller.signal.throwIfAborted()
        result = await definition.run({
          signal: controller.signal,
          workspace,
          progress: (phase, transferredBytes, totalBytes) => {
            if (state.status !== 'active') return
            state.phase = phase
            if (transferredBytes !== undefined)
              state.transferredBytes = transferredBytes
            if (totalBytes !== undefined) state.totalBytes = totalBytes
            this.notify()
          },
          setSource: (source) => {
            if (state.status !== 'active') return
            // Byte counts belong to the current provider, not a previous fallback.
            if (state.source !== source) {
              state.transferredBytes = 0
              state.totalBytes = null
            }
            state.source = source
            this.notify()
          },
          beginPublish: () => {
            controller.signal.throwIfAborted()
            record.publishing = true
            state.phase = 'publishing'
            this.notify()
          },
        })
        controller.signal.throwIfAborted()
      } catch (error) {
        outcome = 'failed'
        state.error = error instanceof Error ? error.message : String(error)
        failure = error
        failed = true
      }
      try {
        await rm(workspace, { recursive: true, force: true })
      } catch (error) {
        outcome = 'failed'
        state.error = error instanceof Error ? error.message : String(error)
        failure = error
        failed = true
      }
      if (this.#pending.get(definition.key) === record)
        this.#pending.delete(definition.key)
      if (this.#running === record) this.#running = undefined
      state.status = outcome
      state.phase = outcome
      this.notify()
      this.startNext()
      if (failed) throw failure
      return result
    })()
    this.startNext()
    // SAFETY: the record stores this invocation's result without changing its type.
    return record.result as Promise<T>
  }

  retry(id: string): string {
    const record = this.#jobs.get(id)
    if (!record || record.state.status !== 'failed' || !this.#accepting)
      throw new Error('Download cannot be retried')
    if (this.#pending.has(record.state.key))
      throw new Error('Download is already running')
    this.#jobs.delete(id)
    // Keep the retry owned by Bun even when no RPC caller waits for it.
    const result = this.enqueue(record.definition)
    void result.catch(() => {})
    return this.#pending.get(record.state.key)!.state.id
  }

  prioritize(id: string): boolean {
    const record = this.#jobs.get(id)
    if (!record || record.state.status !== 'queued') return false
    this.#priorityId = id
    this.notify()
    return true
  }

  dismiss(id: string): boolean {
    const record = this.#jobs.get(id)
    if (!record || !['completed', 'failed'].includes(record.state.status))
      return false
    this.#jobs.delete(id)
    this.notify()
    return true
  }

  stopAccepting(): void {
    this.#accepting = false
    for (const record of this.#pending.values()) {
      if (record === this.#running) continue
      record.controller.abort(new Error('Application is shutting down'))
      record.start()
    }
  }

  async shutdown(): Promise<void> {
    this.stopAccepting()
    const active = [...this.#pending.values()]
    for (const record of active)
      if (!record.publishing || record.definition.canCancel === false)
        record.controller.abort(new Error('Application is shutting down'))
    // Non-cancellable providers may never settle; process exit owns their transfer.
    await Promise.allSettled(
      active.flatMap(({ definition, result }) =>
        definition.canCancel === false ? [] : [result],
      ),
    )
    await rm(this.#root, { recursive: true, force: true })
  }

  private startNext() {
    if (this.#running || !this.#accepting) return
    const priority = this.#priorityId
      ? this.#jobs.get(this.#priorityId)
      : undefined
    const next =
      (priority?.state.status === 'queued' ? priority : undefined) ??
      [...this.#pending.values()].find(({ state }) => state.status === 'queued')
    if (!next) return
    this.#priorityId = undefined
    this.#running = next
    next.state.status = 'active'
    this.notify()
    next.start()
  }

  private notify() {
    // An unattached webview cannot be allowed to strand a Bun-owned job.
    try {
      this.changed(this.snapshot())
    } catch {
      /* The next RPC snapshot restores state. */
    }
  }
}
