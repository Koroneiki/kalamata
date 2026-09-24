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

type JobResult =
  | object
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | void

export interface JobDefinition<T extends JobResult> {
  key: string
  groupKey?: string
  kind: BackgroundDownloadJob['kind']
  title: string
  source?: string
  appId?: number
  depotId?: number
  canCancel?: boolean
  holdQueueAfterCompletion?: boolean
  run: (context: JobContext) => Promise<T>
}

interface JobRecord {
  state: BackgroundDownloadJob
  controller: AbortController
  workspace: string
  groupKey?: string
  tasks: JobTask[]
  completion: Promise<void>
  complete: () => void
  publishing: boolean
}

interface JobTask {
  definition: JobDefinition<JobResult>
  record: JobRecord | null
  result: Promise<JobResult>
  settle: (outcome: JobTaskOutcome) => void
  status: 'queued' | 'active' | 'completed' | 'failed'
  transferredBytes: number
  totalBytes: number | null
  value?: JobResult
  error?: Error
}

type JobTaskOutcome =
  | { status: 'completed'; value: JobResult }
  | { status: 'failed'; error: Error }

export class BackgroundDownloadCoordinator {
  readonly #root: string
  readonly #jobs = new Map<string, JobRecord>()
  readonly #pending = new Map<string, JobTask>()
  readonly #groups = new Map<string, JobRecord>()
  #running: JobRecord | undefined
  #priorityId: string | undefined
  #heldKey: string | undefined
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
    const jobs = [...this.#jobs.values()].map(({ state }) => ({
      ...state,
      ...(state.manifestProgress && {
        manifestProgress: { ...state.manifestProgress },
      }),
    }))
    const priority = jobs.findIndex(({ id }) => id === this.#priorityId)
    const firstQueued = jobs.findIndex(({ status }) => status === 'queued')
    if (priority > firstQueued && firstQueued !== -1)
      jobs.splice(firstQueued, 0, jobs.splice(priority, 1)[0]!)
    return { jobs }
  }

  enqueue<T extends JobResult>(definition: JobDefinition<T>): Promise<T> {
    if (!this.#accepting)
      throw new Error('Background downloads are shutting down')
    const pending = this.#pending.get(definition.key)
    if (pending) return this.taskResult<T>(pending)
    const task = this.createTask(definition)
    const grouped = definition.groupKey
      ? this.#groups.get(definition.groupKey)
      : undefined
    if (grouped) return this.appendToGroup<T>(grouped, task)

    const record = this.createRecord(definition, task)
    task.record = record
    this.#jobs.set(record.state.id, record)
    this.#pending.set(definition.key, task)
    if (record.groupKey) this.#groups.set(record.groupKey, record)
    this.notify()
    this.startNext()
    return this.taskResult<T>(task)
  }

  retry(id: string): string {
    const record = this.#jobs.get(id)
    if (!record || record.state.status !== 'failed' || !this.#accepting)
      throw new Error('Download cannot be retried')
    // These jobs are only one step in a larger operation owned by another RPC.
    if (
      record.state.kind === 'application-update' ||
      record.state.kind === 'dependency'
    )
      throw new Error('Retry this operation from Settings')
    const failedTasks = record.tasks.filter(({ status }) => status === 'failed')
    this.assertRetryAvailable(record, failedTasks)
    this.#jobs.delete(id)
    return this.retryFailedTasks(record, failedTasks)
  }

  private assertRetryAvailable(
    record: JobRecord,
    failedTasks: JobTask[],
  ): void {
    if (
      failedTasks.some(({ definition }) => this.#pending.has(definition.key)) ||
      (record.groupKey !== undefined && this.#groups.has(record.groupKey))
    )
      throw new Error('Download is already running')
  }

  private retryFailedTasks(record: JobRecord, failedTasks: JobTask[]): string {
    // Keep retries owned by Bun even when no RPC caller waits for them.
    const results = failedTasks.map(({ definition }) =>
      this.enqueue(definition),
    )
    void Promise.all(results).catch(() => {})
    const retry = record.groupKey
      ? this.#groups.get(record.groupKey)
      : failedTasks[0]
        ? this.#pending.get(failedTasks[0].definition.key)?.record
        : undefined
    if (!retry) throw new Error('Download cannot be retried')
    return retry.state.id
  }

  prioritize(id: string): boolean {
    const record = this.#jobs.get(id)
    if (!record || record.state.status !== 'queued') return false
    this.#priorityId = id
    this.notify()
    return true
  }

  releaseQueue(key: string): void {
    if (this.#heldKey !== key) return
    this.#heldKey = undefined
    this.startNext()
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
    for (const record of new Set(
      [...this.#pending.values()].flatMap(({ record }) =>
        record ? [record] : [],
      ),
    )) {
      if (record === this.#running) continue
      record.controller.abort(new Error('Application is shutting down'))
      record.state.status = 'active'
      void this.run(record)
    }
  }

  async shutdown(): Promise<void> {
    const active = new Set(
      [...this.#pending.values()].flatMap(({ record }) =>
        record ? [record] : [],
      ),
    )
    const settled = Promise.allSettled(
      [...active].flatMap((record) =>
        record.tasks.some(({ definition }) => definition.canCancel === false)
          ? []
          : [record.completion, ...record.tasks.map(({ result }) => result)],
      ),
    )
    this.stopAccepting()
    for (const record of active)
      if (
        !record.publishing ||
        record.tasks.some(({ definition }) => definition.canCancel === false)
      )
        record.controller.abort(new Error('Application is shutting down'))
    // Non-cancellable providers may never settle; process exit owns their transfer.
    await settled
    await rm(this.#root, { recursive: true, force: true })
  }

  private appendToGroup<T extends JobResult>(
    record: JobRecord,
    task: JobTask,
  ): Promise<T> {
    // Base-game and DLC manifest tasks share a parent-app job, but keep separate results.
    task.record = record
    record.tasks.push(task)
    record.state.itemCount = record.tasks.length
    this.syncManifestProgress(record)
    this.#pending.set(task.definition.key, task)
    this.notify()
    return this.taskResult<T>(task)
  }

  private createRecord<T extends JobResult>(
    definition: JobDefinition<T>,
    task: JobTask,
  ): JobRecord {
    const id = randomUUID()
    const state: BackgroundDownloadJob = {
      id,
      key: definition.groupKey ?? definition.key,
      kind: definition.kind,
      title: definition.title,
      appId: definition.appId ?? null,
      depotId: definition.groupKey ? null : (definition.depotId ?? null),
      status: 'queued',
      phase: 'preparing',
      source: definition.source ?? null,
      transferredBytes: 0,
      totalBytes: null,
      error: null,
    }
    if (definition.groupKey) state.itemCount = 1
    if (definition.groupKey)
      state.manifestProgress = {
        finishedCount: 0,
        currentIndex: null,
        currentDepotId: null,
        transferredBytes: 0,
        totalBytes: null,
      }

    let complete!: () => void
    const completion = new Promise<void>((resolve) => {
      complete = resolve
    })
    const record: JobRecord = {
      state,
      controller: new AbortController(),
      workspace: join(this.#root, id),
      tasks: [task],
      completion,
      complete,
      publishing: false,
    }
    if (definition.groupKey) record.groupKey = definition.groupKey
    return record
  }

  private createTask<T extends JobResult>(
    definition: JobDefinition<T>,
  ): JobTask {
    let settle!: (outcome: JobTaskOutcome) => void
    const result = new Promise<JobResult>((onResolve, onReject) => {
      settle = (outcome) => {
        if (outcome.status === 'completed') onResolve(outcome.value)
        else onReject(outcome.error)
      }
    })
    return {
      definition,
      record: null,
      result,
      settle,
      status: 'queued',
      transferredBytes: 0,
      totalBytes: null,
    }
  }

  private taskResult<T extends JobResult>(task: JobTask): Promise<T> {
    // SAFETY: a semantic key is enqueued with one result type by its provider.
    return task.result as Promise<T>
  }

  private async run(record: JobRecord): Promise<void> {
    const setupError = await this.createWorkspace(record)
    if (setupError) this.failTasks(record, setupError)
    else await this.runTasks(record)
    if (setupError) this.closeGroup(record)

    const cleanupError = await this.cleanupWorkspace(record)
    if (cleanupError) this.failTasks(record, cleanupError)
    this.settleTasks(record)
    this.finishRecord(record)
  }

  private async createWorkspace(record: JobRecord): Promise<Error | undefined> {
    try {
      await mkdir(record.workspace, { recursive: true })
      return undefined
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause))
    }
  }

  private async runTasks(record: JobRecord): Promise<void> {
    let index = 0
    while (index < record.tasks.length) {
      const taskIndex = index++
      const task = record.tasks[taskIndex]!
      if (task.status !== 'queued') continue
      await this.runTask(record, task, taskIndex)
      // Publication must finish, but shutdown must not start another child.
      if (!this.#accepting && index < record.tasks.length)
        record.controller.abort(new Error('Application is shutting down'))
    }
    this.closeGroup(record)
  }

  private async runTask(
    record: JobRecord,
    task: JobTask,
    taskIndex: number,
  ): Promise<void> {
    // Isolate per-manifest scratch while cleaning all children with their parent job.
    const workspace = record.groupKey
      ? join(record.workspace, String(taskIndex))
      : record.workspace
    this.prepareTask(record, task)
    try {
      record.controller.signal.throwIfAborted()
      await mkdir(workspace, { recursive: true })
      const value = await task.definition.run(
        this.createContext(record, task, workspace),
      )
      record.controller.signal.throwIfAborted()
      task.status = 'completed'
      task.value = value
    } catch (cause) {
      task.status = 'failed'
      task.error = cause instanceof Error ? cause : new Error(String(cause))
    }
    if (record.groupKey) {
      this.syncManifestProgress(record)
      this.notify()
    }
  }

  private prepareTask(record: JobRecord, task: JobTask): void {
    record.publishing = false
    record.state.phase = 'preparing'
    record.state.source = task.definition.source ?? null
    task.status = 'active'
    if (record.groupKey) this.syncManifestProgress(record)
    else {
      record.state.transferredBytes = 0
      record.state.totalBytes = null
    }
    this.notify()
  }

  private createContext(
    record: JobRecord,
    task: JobTask,
    workspace: string,
  ): JobContext {
    return {
      signal: record.controller.signal,
      workspace,
      progress: (phase, transferredBytes, totalBytes) => {
        if (record.state.status !== 'active') return
        record.state.phase = phase
        if (record.groupKey) {
          if (transferredBytes !== undefined)
            task.transferredBytes = transferredBytes
          if (totalBytes !== undefined) task.totalBytes = totalBytes
          this.syncManifestProgress(record)
        } else {
          if (transferredBytes !== undefined)
            record.state.transferredBytes = transferredBytes
          if (totalBytes !== undefined) record.state.totalBytes = totalBytes
        }
        this.notify()
      },
      setSource: (source) => {
        if (record.state.status !== 'active') return
        // Byte counts belong to the current provider, not a previous fallback.
        if (record.state.source !== source) {
          if (record.groupKey) {
            task.transferredBytes = 0
            task.totalBytes = null
            this.syncManifestProgress(record)
          } else {
            record.state.transferredBytes = 0
            record.state.totalBytes = null
          }
        }
        record.state.source = source
        this.notify()
      },
      beginPublish: () => {
        record.controller.signal.throwIfAborted()
        record.publishing = true
        record.state.phase = 'publishing'
        this.notify()
      },
    }
  }

  private async cleanupWorkspace(
    record: JobRecord,
  ): Promise<Error | undefined> {
    try {
      await rm(record.workspace, { recursive: true, force: true })
      return undefined
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause))
    }
  }

  private failTasks(record: JobRecord, error: Error): void {
    for (const task of record.tasks) {
      task.status = 'failed'
      task.value = undefined
      task.error = error
    }
  }

  private syncManifestProgress(record: JobRecord): void {
    const progress = record.state.manifestProgress
    if (!progress) return
    const currentIndex = record.tasks.findIndex(
      ({ status }) => status === 'active',
    )
    const current = record.tasks[currentIndex]
    progress.finishedCount = record.tasks.filter(
      ({ status }) => status === 'completed' || status === 'failed',
    ).length
    progress.currentIndex = current ? currentIndex + 1 : null
    progress.currentDepotId = current?.definition.depotId ?? null
    progress.transferredBytes = current?.transferredBytes ?? 0
    progress.totalBytes = current?.totalBytes ?? null
    record.state.transferredBytes = record.tasks.reduce(
      (sum, task) => sum + task.transferredBytes,
      0,
    )
    // Queued or size-unknown manifests cannot contribute a reliable group total.
    record.state.totalBytes = record.tasks.every(
      ({ status, totalBytes }) =>
        (status === 'completed' || status === 'failed') && totalBytes !== null,
    )
      ? record.tasks.reduce((sum, task) => sum + task.totalBytes!, 0)
      : null
  }

  private settleTasks(record: JobRecord): void {
    for (const task of record.tasks) {
      if (this.#pending.get(task.definition.key) === task)
        this.#pending.delete(task.definition.key)
      if (task.status === 'completed')
        task.settle({ status: 'completed', value: task.value })
      else
        task.settle({
          status: 'failed',
          error: task.error ?? new Error('Background task failed'),
        })
    }
  }

  private closeGroup(record: JobRecord): void {
    if (record.groupKey && this.#groups.get(record.groupKey) === record) {
      this.#groups.delete(record.groupKey)
    }
  }

  private finishRecord(record: JobRecord): void {
    if (this.#running === record) this.#running = undefined
    if (record.groupKey) this.syncManifestProgress(record)
    const failed = record.tasks.filter(({ status }) => status === 'failed')
    record.state.status = failed.length ? 'failed' : 'completed'
    record.state.phase = record.state.status
    record.state.error = failed.length
      ? failed
          .map(({ error }) => error?.message ?? 'Background task failed')
          .join('\n')
      : null
    this.notify()
    record.complete()
    if (
      record.state.status === 'completed' &&
      record.tasks[0]?.definition.holdQueueAfterCompletion
    ) {
      this.#heldKey = record.state.key
      return
    }
    this.startNext()
  }

  private startNext() {
    if (this.#running || this.#heldKey || !this.#accepting) return
    const priority = this.#priorityId
      ? this.#jobs.get(this.#priorityId)
      : undefined
    const next =
      (priority?.state.status === 'queued' ? priority : undefined) ??
      [...this.#jobs.values()].find(({ state }) => state.status === 'queued')
    if (!next) return
    this.#priorityId = undefined
    this.#running = next
    next.state.status = 'active'
    this.notify()
    void this.run(next)
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
