import {
  computed,
  onBeforeUnmount,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue'

import type {
  ActiveOperationState,
  OperationState,
  PausedOperationState,
  ResumableOperationState,
} from '../types/rpc'

export type ProgressOperation =
  | ActiveOperationState
  | PausedOperationState
  | ResumableOperationState
type RepairRequiredOperation = Extract<
  OperationState,
  { status: 'repair-required' }
>
type FailedOperation = Extract<OperationState, { status: 'failed' }>
type VisibleOperation =
  | ProgressOperation
  | FailedOperation
  | RepairRequiredOperation

type DisplayTransition =
  | { kind: 'progress'; state: ProgressOperation }
  | { kind: 'error'; state: FailedOperation | RepairRequiredOperation }
  | { kind: 'clear' }
  | { kind: 'complete' }

export function isProgressOperation(
  state: OperationState,
): state is ProgressOperation {
  return ['active', 'paused', 'resumable'].includes(state.status)
}

function isVisibleError(
  state: OperationState,
): state is FailedOperation | RepairRequiredOperation {
  return state.status === 'repair-required' || state.status === 'failed'
}

function latestCounter(current: string, displayed: string) {
  return BigInt(current) >= BigInt(displayed) ? current : displayed
}

export function mergeOperationProgress(
  state: ProgressOperation,
  displayed: ProgressOperation,
): ProgressOperation {
  return {
    ...state,
    installedBytesCompleted: latestCounter(
      state.installedBytesCompleted,
      displayed.installedBytesCompleted,
    ),
    installedBytesTotal: latestCounter(
      state.installedBytesTotal,
      displayed.installedBytesTotal,
    ),
    reusedLocalBytes: latestCounter(
      state.reusedLocalBytes,
      displayed.reusedLocalBytes,
    ),
    networkBytes: latestCounter(state.networkBytes, displayed.networkBytes),
  }
}

export function remainingOperationVisibility(
  visibleSince: number,
  now: number,
) {
  return Math.max(1_000, 3_000 - (now - visibleSince))
}

function shouldClearDisplay(
  state: OperationState | null,
  displayed: VisibleOperation | null,
  appId: number,
) {
  if (!state || displayed?.appId !== appId) return true
  return isVisibleError(displayed)
}

function displayTransition(
  state: OperationState | null,
  displayed: VisibleOperation | null,
  appId: number,
): DisplayTransition {
  if (state && isProgressOperation(state)) return { kind: 'progress', state }
  if (state && isVisibleError(state)) return { kind: 'error', state }
  if (shouldClearDisplay(state, displayed, appId)) return { kind: 'clear' }
  return { kind: 'complete' }
}

function startsVisibilityPeriod(
  previous: VisibleOperation | null,
  state: ProgressOperation,
  finished: boolean,
) {
  if (finished || !previous) return true
  if (previous.appId !== state.appId) return true
  return isVisibleError(previous)
}

function canPreserveProgress(
  previous: VisibleOperation | null,
  state: ProgressOperation,
  finished: boolean,
): previous is ProgressOperation {
  return (
    !finished &&
    previous !== null &&
    previous.appId === state.appId &&
    isProgressOperation(previous)
  )
}

export function useAppOperationDisplay(options: {
  appId: MaybeRefOrGetter<number>
  operationState: MaybeRefOrGetter<OperationState>
  selectedPath: Ref<string>
}) {
  const currentOperationForApp = computed(() => {
    const state = toValue(options.operationState)
    const appId = toValue(options.appId)
    return state.status !== 'idle' && state.appId === appId ? state : null
  })
  const operationForApp = ref<VisibleOperation | null>(null)
  const operationFinished = ref(false)
  let operationVisibleSince = 0
  let hideOperationTimer: ReturnType<typeof setTimeout> | undefined

  function clearHideTimer() {
    if (hideOperationTimer) clearTimeout(hideOperationTimer)
    hideOperationTimer = undefined
  }

  function clearDisplay() {
    operationForApp.value = null
    operationFinished.value = false
  }

  function showProgress(state: ProgressOperation) {
    const previous = operationForApp.value
    if (startsVisibilityPeriod(previous, state, operationFinished.value))
      operationVisibleSince = Date.now()
    // Resume replans from zero; visible progress must remain monotonic.
    operationForApp.value = canPreserveProgress(
      previous,
      state,
      operationFinished.value,
    )
      ? mergeOperationProgress(state, previous)
      : state
    operationFinished.value = false
    options.selectedPath.value = state.installPath
  }

  function showError(state: FailedOperation | RepairRequiredOperation) {
    operationForApp.value = state
    operationFinished.value = false
    options.selectedPath.value = state.installPath
  }

  function finishDisplay() {
    operationFinished.value = true
    hideOperationTimer = setTimeout(
      () => {
        clearDisplay()
        hideOperationTimer = undefined
      },
      remainingOperationVisibility(operationVisibleSince, Date.now()),
    )
  }

  watch(
    [currentOperationForApp, () => toValue(options.appId)],
    ([state, currentAppId]) => {
      clearHideTimer()
      const transition = displayTransition(
        state,
        operationForApp.value,
        currentAppId,
      )
      if (transition.kind === 'progress') return showProgress(transition.state)
      if (transition.kind === 'error') return showError(transition.state)
      if (transition.kind === 'clear') return clearDisplay()
      finishDisplay()
    },
    { immediate: true },
  )

  onBeforeUnmount(clearHideTimer)

  return { operationForApp, operationFinished }
}
