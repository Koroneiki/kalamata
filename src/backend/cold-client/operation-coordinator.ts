import type {
  CancelColdClientOperationResult,
  ColdClientOperationKind,
  ColdClientOperationPhase,
  ColdClientOperationSnapshot,
} from '../../types/cold-client.ts'
import { ColdClientMutationMutex } from './mutation-mutex.ts'

export interface ColdClientOperationContext {
  readonly signal: AbortSignal
  setPhase(phase: Exclude<ColdClientOperationPhase, 'replacing'>): void
  beginReplacement(): void
}

interface ActiveOperation {
  appId: number
  kind: ColdClientOperationKind
  phase: ColdClientOperationPhase
  cancellable: boolean
  abortController: AbortController
  promise: Promise<unknown>
}

export class ColdClientOperationCoordinator {
  readonly #mutex: ColdClientMutationMutex
  readonly #emit: (snapshot: ColdClientOperationSnapshot) => void
  #active: ActiveOperation | undefined
  #accepting = true

  constructor(
    mutex: ColdClientMutationMutex,
    emit: (snapshot: ColdClientOperationSnapshot) => void = () => {},
  ) {
    this.#mutex = mutex
    this.#emit = emit
  }

  getSnapshot(): ColdClientOperationSnapshot {
    const active = this.#active
    return active
      ? {
          status: 'active',
          appId: active.appId,
          kind: active.kind,
          phase: active.phase,
          cancellable: active.cancellable,
        }
      : { status: 'idle' }
  }

  run<Result>(
    kind: ColdClientOperationKind,
    appId: number,
    operation: (context: ColdClientOperationContext) => Promise<Result>,
  ): Promise<Result> {
    if (!this.#accepting) throw new Error('Application is shutting down')
    if (this.#active)
      throw new Error('Another ColdClient operation is already running')

    const abortController = new AbortController()
    const active: ActiveOperation = {
      appId,
      kind,
      phase: kind === 'update-core' ? 'building' : 'waiting-for-generator',
      cancellable: true,
      abortController,
      promise: Promise.resolve(),
    }
    this.#active = active
    this.#emit(this.getSnapshot())

    const setPhase = (
      phase: Exclude<ColdClientOperationPhase, 'replacing'>,
    ) => {
      if (this.#active !== active) return
      active.abortController.signal.throwIfAborted()
      active.phase = phase
      this.#emit(this.getSnapshot())
    }
    const beginReplacement = () => {
      if (this.#active !== active)
        throw new Error('Operation is no longer active')
      active.abortController.signal.throwIfAborted()
      active.phase = 'replacing'
      active.cancellable = false
      this.#emit(this.getSnapshot())
    }

    const promise = this.#mutex
      .runExclusive(async () => {
        active.abortController.signal.throwIfAborted()
        return operation({
          signal: active.abortController.signal,
          setPhase,
          beginReplacement,
        })
      })
      .finally(() => {
        if (this.#active !== active) return
        this.#active = undefined
        this.#emit(this.getSnapshot())
      })
    active.promise = promise
    return promise
  }

  cancel(appId: number): CancelColdClientOperationResult {
    const active = this.#active
    if (!active || active.appId !== appId) {
      return { accepted: false, reason: 'no-active-operation' }
    }
    if (!active.cancellable) {
      return { accepted: false, reason: 'replacement-in-progress' }
    }
    active.abortController.abort(new Error('ColdClient operation cancelled'))
    return { accepted: true }
  }

  async shutdown(): Promise<void> {
    this.#accepting = false
    const active = this.#active
    if (!active) return
    if (active.cancellable)
      active.abortController.abort(new Error('Application is shutting down'))
    await Promise.allSettled([active.promise])
  }
}
