import type {
  BackgroundDownloadCoordinator,
  JobContext,
} from '../downloads/background-download-coordinator.ts'
import type {
  ColdClientOperationKind,
  ColdClientOperationSnapshot,
} from '../../types/cold-client.ts'

const titles: Record<ColdClientOperationKind, string> = {
  setup: 'ColdClient setup',
  regenerate: 'ColdClient regeneration',
  'update-core': 'ColdClient core update',
  remove: 'ColdClient removal',
}

export class ColdClientJobQueue {
  #current: { appId: number; context: JobContext } | undefined

  constructor(
    private readonly jobs: BackgroundDownloadCoordinator,
    private readonly cancelOperation: (appId: number) => void,
  ) {}

  hasPendingForApp(appId: number): boolean {
    return this.jobs
      .snapshot()
      .jobs.some(
        (job) =>
          job.kind === 'cold-client' &&
          job.appId === appId &&
          (job.status === 'queued' || job.status === 'active'),
      )
  }

  onOperationChanged(snapshot: ColdClientOperationSnapshot): void {
    if (snapshot.status !== 'active' || this.#current?.appId !== snapshot.appId)
      return
    if (snapshot.phase === 'replacing') this.#current.context.beginPublish()
    else this.#current.context.progress(snapshot.phase)
  }

  enqueue<T extends object>(
    kind: ColdClientOperationKind,
    appId: number,
    run: () => Promise<T>,
  ): Promise<T> {
    // A second review must not inherit an earlier job's result with different choices.
    if (this.hasPendingForApp(appId))
      throw new Error('This game already has a ColdClient job in Jobs')
    return this.jobs.enqueue({
      key: `cold-client:${kind}:${appId}`,
      kind: 'cold-client',
      title: titles[kind],
      appId,
      run: async (context) => {
        this.#current = { appId, context }
        const cancel = () => this.cancelOperation(appId)
        context.signal.addEventListener('abort', cancel, { once: true })
        try {
          return await run()
        } finally {
          context.signal.removeEventListener('abort', cancel)
          this.#current = undefined
        }
      },
    })
  }
}
