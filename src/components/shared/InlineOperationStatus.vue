<script setup lang="ts">
import { Computer, Download, Pause, Play, X } from '@lucide/vue'
import { computed, onBeforeUnmount, ref } from 'vue'

import InlineOperationCancelDialog from '@/components/shared/InlineOperationCancelDialog.vue'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useOperationStore } from '@/stores/operation'
import type {
  ActiveOperationState,
  CancelOperationResult,
  OperationState,
  OperationPhase,
  PauseOperationResult,
  PausedOperationState,
  ResumeOperationResult,
  ResumableOperationState,
} from '@/types/rpc'
import { bytePercentage, formatBytes } from '@/utils/bytes'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  state:
    | ProgressOperation
    | Extract<OperationState, { status: 'failed' }>
    | Extract<OperationState, { status: 'repair-required' }>
  finished?: boolean
  showInstalledProgress?: boolean
}>()

const operation = useOperationStore()
const panel = ref<HTMLElement | null>(null)
const cancelOpen = ref(false)
const pausedForCancel = ref(false)
const actionPending = ref(false)
const actionError = ref('')
let unmounted = false

const steamPhaseLabels = {
  planning: 'CALCULATING',
  staging: 'RESERVING SPACE',
  downloading: 'DOWNLOADING',
  verifying: 'VERIFYING',
  committing: 'INSTALLING',
  reconciling: 'FINALIZING',
} satisfies Record<OperationPhase, string>

type ProgressOperation =
  | ActiveOperationState
  | PausedOperationState
  | ResumableOperationState
type ControlResult =
  | CancelOperationResult
  | PauseOperationResult
  | ResumeOperationResult

function isProgressOperation(
  state: OperationState,
): state is ProgressOperation {
  return ['active', 'paused', 'resumable'].includes(state.status)
}

const progressState = computed(() =>
  isProgressOperation(props.state) ? props.state : null,
)
const isUninstall = computed(
  () =>
    progressState.value?.kind === 'reconcile' &&
    !progressState.value.desiredDepotIds.length,
)
const phaseLabel = computed(() => {
  if (props.state.status === 'failed') return 'DOWNLOAD FAILED'
  if (props.state.status === 'repair-required') return 'INSTALLATION BROKEN'
  if (props.state.status === 'paused') return 'PAUSED'
  if (props.state.status === 'resumable') return 'RESUME REQUIRED'
  if (isUninstall.value) return 'UNINSTALLING'
  if (
    progressState.value?.phase === 'staging' &&
    progressState.value.kind !== 'download'
  )
    return 'PATCHING'
  return steamPhaseLabels[progressState.value!.phase]
})
const uninstallRemoving = computed(
  () => !props.finished && progressState.value?.phase === 'committing',
)
const uninstallCompleted = computed(
  () =>
    operation.state.status === 'completed' &&
    operation.state.appId === props.state.appId,
)
const uninstallRemoved = computed(
  () =>
    uninstallCompleted.value || progressState.value?.phase === 'reconciling',
)
const progress = computed(() =>
  progressState.value
    ? bytePercentage(
        progressState.value.installedBytesCompleted,
        progressState.value.installedBytesTotal,
      )
    : 0,
)
const downloadProgress = computed(() => {
  const downloaded = formatBytes(progressState.value?.networkBytes ?? '0')
  const estimate = progressState.value?.estimatedDownloadBytes
  if (estimate === null || estimate === undefined)
    return { text: downloaded, label: `Downloaded ${downloaded}` }
  const estimated = formatBytes(estimate)
  return {
    text: `${downloaded} / ${estimated}`,
    label: `Downloaded ${downloaded} out of an estimated ${estimated}`,
  }
})
const canPause = computed(
  () =>
    !props.finished &&
    props.state.status === 'active' &&
    ['staging', 'downloading', 'verifying'].includes(props.state.phase),
)
const canResume = computed(
  () => !props.finished && ['paused', 'resumable'].includes(props.state.status),
)
const canCancel = computed(
  () =>
    !props.finished &&
    progressState.value !== null &&
    !['committing', 'reconciling'].includes(progressState.value.phase),
)

function rejectionMessage(reason: string) {
  if (reason === 'commit-in-progress')
    return 'Files or metadata are already being committed, so this operation cannot be cancelled.'
  if (reason === 'invalid-phase')
    return 'The operation can no longer be paused.'
  if (reason === 'no-resumable-operation')
    return 'The operation is no longer available to resume.'
  return 'The operation state changed before the action completed.'
}

async function runControl(action: () => Promise<ControlResult>) {
  actionPending.value = true
  actionError.value = ''
  try {
    const result = await action()
    if (!result.accepted) {
      actionError.value = rejectionMessage(result.reason)
      return false
    }
    return true
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    actionPending.value = false
  }
}

async function openCancel() {
  const targetAppId = props.state.appId
  if (props.state.status === 'active' && props.state.phase !== 'planning') {
    if (!(await runControl(() => operation.pause()))) return
    pausedForCancel.value = true
    if (unmounted || props.state.appId !== targetAppId) {
      pausedForCancel.value = false
      if (
        operation.state.status === 'paused' &&
        operation.state.appId === targetAppId
      )
        await operation.resume()
      return
    }
  }
  cancelOpen.value = true
}

async function handleCancelOpenChange(open: boolean) {
  if (open || actionPending.value) return
  cancelOpen.value = false
  if (!pausedForCancel.value) return
  pausedForCancel.value = false
  await runControl(() => operation.resume())
}

async function confirmCancel() {
  if (!(await runControl(() => operation.cancel()))) return
  pausedForCancel.value = false
  cancelOpen.value = false
}

onBeforeUnmount(() => {
  unmounted = true
  if (!pausedForCancel.value) return
  pausedForCancel.value = false
  if (
    operation.state.status === 'paused' &&
    operation.state.appId === props.state.appId
  )
    void operation.resume()
})

defineExpose({
  focusHeading() {
    panel.value?.focus()
  },
})
</script>

<template>
  <div v-bind="$attrs" class="flex min-w-0 items-stretch gap-2 sm:h-16">
    <section
      ref="panel"
      class="focus-visible:ring-ring flex min-w-0 flex-1 flex-col justify-center rounded-lg p-2 outline-none focus-visible:ring-2 sm:p-1"
      tabindex="-1"
      :aria-label="`${phaseLabel} operation status`"
    >
      <div class="flex items-baseline justify-between gap-3 leading-4">
        <h2 class="text-xs font-semibold tracking-wide">{{ phaseLabel }}</h2>
        <span
          v-if="progressState && !isUninstall"
          class="font-mono text-xs font-medium tabular-nums"
          >{{ Math.round(progress) }}%</span
        >
      </div>
      <Progress
        v-if="progressState && !isUninstall"
        class="mt-1 h-1"
        :model-value="progress"
        aria-label="Logical installed progress"
        :aria-valuetext="`${progressState.installedBytesCompleted} of ${progressState.installedBytesTotal} bytes installed`"
      />
      <div
        v-else-if="progressState && isUninstall"
        class="bg-primary/20 mt-1 h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-label="Uninstall in progress"
      >
        <div
          v-if="uninstallRemoving"
          class="operation-indeterminate bg-primary h-full w-1/2 rounded-full"
        />
        <div
          v-else-if="uninstallRemoved"
          class="bg-primary h-full w-full rounded-full"
        />
      </div>

      <div class="mt-1 min-w-0 text-xs">
        <span
          v-if="state.status === 'repair-required'"
          class="text-destructive"
        >
          This installation could not be verified. Verify the game files.
        </span>
        <p
          v-else-if="state.status === 'failed'"
          class="text-destructive"
          role="alert"
        >
          {{ state.error.message }}
        </p>
        <span v-else-if="isUninstall" class="text-muted-foreground">
          Removing files
        </span>
        <div
          v-else-if="progressState"
          class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span
            class="text-muted-foreground flex items-center gap-1 whitespace-nowrap tabular-nums"
            :aria-label="downloadProgress.label"
          >
            <Download class="size-3" aria-hidden="true" />
            <span aria-hidden="true">{{ downloadProgress.text }}</span>
          </span>
          <span
            v-if="showInstalledProgress"
            class="ml-auto flex min-w-0 items-center justify-end gap-1 whitespace-nowrap tabular-nums"
          >
            <Computer class="size-3" aria-hidden="true" />
            <span class="sr-only">Logical installed progress:</span>
            {{ formatBytes(progressState.installedBytesCompleted) }} /
            {{ formatBytes(progressState.installedBytesTotal) }}
          </span>
        </div>
        <p
          v-if="state.status === 'resumable'"
          class="text-destructive mt-1"
          role="alert"
        >
          {{ state.error.message }}
        </p>
      </div>
      <p v-if="actionError" class="text-destructive mt-1 text-xs" role="alert">
        {{ actionError }}
      </p>
    </section>

    <div
      class="flex h-16 w-17 shrink-0 items-center justify-end gap-1 sm:h-full"
    >
      <Button
        v-if="canPause"
        type="button"
        size="icon-sm"
        :disabled="actionPending"
        aria-label="Pause operation"
        title="Pause"
        @click="runControl(() => operation.pause())"
      >
        <Pause aria-hidden="true" />
      </Button>
      <Button
        v-else-if="canResume"
        type="button"
        size="icon-sm"
        :disabled="actionPending"
        aria-label="Resume operation"
        title="Resume"
        @click="runControl(() => operation.resume())"
      >
        <Play aria-hidden="true" />
      </Button>
      <Button
        v-if="canCancel"
        type="button"
        size="icon-sm"
        variant="outline"
        :disabled="actionPending"
        aria-label="Cancel operation"
        title="Cancel"
        @click="openCancel"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  </div>

  <InlineOperationCancelDialog
    :open="cancelOpen"
    :paused-for-cancel="pausedForCancel"
    :action-pending="actionPending"
    :action-error="actionError"
    @update:open="handleCancelOpenChange"
    @confirm="confirmCancel"
  />
</template>

<style scoped>
@keyframes operation-indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(200%);
  }
}

.operation-indeterminate {
  animation: operation-indeterminate 1.2s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .operation-indeterminate {
    animation: none;
  }
}
</style>
