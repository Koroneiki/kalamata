import type {
  BackgroundDownloadCoordinator,
  JobContext,
} from '../backend/downloads/background-download-coordinator.ts'
import type { ApplicationUpdateStatus } from '../types/rpc.ts'

interface ApplicationUpdater {
  check(): Promise<{
    updateAvailable: boolean
    version: string
    error?: string
  }>
  download(context: JobContext): Promise<void>
  info(): { updateReady: boolean; error?: string }
}

export class ApplicationUpdatePreparer {
  readonly #status: ApplicationUpdateStatus
  #check: Promise<void> | undefined

  constructor(
    currentVersion: string,
    private readonly updater: ApplicationUpdater,
    private readonly jobs: BackgroundDownloadCoordinator,
    private readonly changed: (status: ApplicationUpdateStatus) => void,
    private readonly stopping: () => boolean,
  ) {
    this.#status = {
      currentVersion,
      availableVersion: null,
      checking: false,
      ready: false,
      error: null,
    }
  }

  status(): ApplicationUpdateStatus {
    return { ...this.#status }
  }

  checkAndStage(): Promise<void> {
    if (this.#check) return this.#check
    if (this.stopping() || this.#status.ready) return Promise.resolve()
    this.#check = this.performCheck().finally(() => {
      this.#check = undefined
    })
    return this.#check
  }

  private async performCheck() {
    this.#status.checking = true
    this.#status.error = null
    this.publish()
    try {
      const update = await this.updater.check()
      if (update.error) throw new Error(update.error)
      this.#status.availableVersion = update.updateAvailable
        ? update.version
        : null
      if (update.updateAvailable) {
        this.publish()
        await this.jobs.enqueue({
          key: 'application-update',
          kind: 'application-update',
          title: 'Application update',
          canCancel: false,
          run: async (context) => {
            await this.updater.download(context)
            context.signal.throwIfAborted()
            const prepared = this.updater.info()
            if (!prepared.updateReady)
              throw new Error(
                prepared.error || 'The update could not be prepared',
              )
          },
        })
        this.#status.ready = true
      }
    } catch (cause) {
      this.#status.error =
        cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.#status.checking = false
      this.publish()
    }
  }

  private publish() {
    // A detached webview must not strand native update work.
    try {
      this.changed(this.status())
    } catch {
      /* The next RPC snapshot restores status. */
    }
  }
}
