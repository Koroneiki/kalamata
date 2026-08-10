<script setup lang="ts">
import { AlertCircle, CheckCircle2, LoaderCircle } from '@lucide/vue'
import { computed, ref } from 'vue'

import type { DownloadQueueState } from '@/types/rpc'
import { bytePercentage, formatBytes } from '@/utils/bytes'

import { Progress } from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const props = defineProps<{
  state: Exclude<DownloadQueueState, { status: 'idle' }>
}>()

const progress = computed(() => {
  if (props.state.status !== 'running') return 0
  return bytePercentage(props.state.downloadedBytes, props.state.totalBytes)
})

const heading = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const runningAnnouncement = computed(() =>
  props.state.status === 'running'
    ? `Downloading depot ${props.state.currentDepotId}. Queue item ${props.state.position} of ${props.state.total}.${props.state.operation ? ` ${props.state.operation}.` : ''}`
    : '',
)
const progressValueText = computed(() => {
  if (props.state.status !== 'running') return ''
  if (props.state.totalBytes === '0') {
    return `${props.state.downloadedBytes} bytes downloaded; total size not available yet`
  }
  return `${props.state.downloadedBytes} of ${props.state.totalBytes} bytes downloaded`
})

defineExpose({
  focusHeading() {
    const focusTarget = heading.value ?? panel.value
    focusTarget?.focus()
  },
})
</script>

<template>
  <section
    ref="panel"
    class="bg-muted/70 focus-visible:ring-ring rounded-lg p-4 outline-none focus-visible:ring-2"
    tabindex="-1"
    :role="state.status === 'running' ? undefined : 'status'"
    :aria-label="`Download queue ${state.status}`"
  >
    <template v-if="state.status === 'running'">
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {{ runningAnnouncement }}
      </p>
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2
            ref="heading"
            class="focus-visible:ring-ring flex items-center gap-2 rounded-sm font-medium outline-none focus-visible:ring-2"
            tabindex="-1"
          >
            <LoaderCircle
              class="text-primary size-4 animate-spin"
              aria-hidden="true"
            />
            Downloading depot {{ state.currentDepotId }}
          </h2>
          <p class="text-muted-foreground mt-1 text-xs">
            Queue {{ state.position }} of {{ state.total }} ·
            {{ formatBytes(state.downloadedBytes) }} of
            {{
              state.totalBytes === '0'
                ? 'total not available yet'
                : formatBytes(state.totalBytes)
            }}
          </p>
        </div>
        <span class="text-muted-foreground text-xs tabular-nums"
          >{{ Math.round(progress) }}%</span
        >
      </div>
      <Progress
        class="mt-3"
        :model-value="progress"
        :aria-label="`Download progress for depot ${state.currentDepotId}`"
        :aria-valuetext="progressValueText"
      />
      <Tooltip v-if="state.operation">
        <TooltipTrigger as-child>
          <span
            class="text-muted-foreground focus-visible:ring-ring mt-3 block min-w-0 truncate rounded-sm text-xs outline-none focus-visible:ring-3"
            tabindex="0"
            :aria-label="`Current operation: ${state.operation}`"
          >
            {{ state.operation }}
          </span>
        </TooltipTrigger>
        <TooltipContent class="max-w-[min(36rem,80vw)] text-xs break-all">
          {{ state.operation }}
        </TooltipContent>
      </Tooltip>
      <span
        class="mt-2 block truncate font-mono text-xs"
        :aria-label="`Install path: ${state.installPath}`"
      >
        {{ state.installPath }}
      </span>
    </template>

    <template v-else-if="state.status === 'completed'">
      <p class="flex items-center gap-2 font-medium">
        <CheckCircle2 class="text-primary size-4" aria-hidden="true" />
        Download complete
      </p>
      <p class="text-muted-foreground mt-1 text-xs">
        {{ state.completedDepotIds.length }}
        {{ state.completedDepotIds.length === 1 ? 'depot' : 'depots' }}
        installed · {{ formatBytes(state.downloadedBytes) }} downloaded ·
        {{ formatBytes(state.reusedBytes) }} reused
      </p>
      <span
        class="mt-2 block truncate font-mono text-xs"
        :aria-label="`Install path: ${state.installPath}`"
      >
        {{ state.installPath }}
      </span>
    </template>

    <template v-else>
      <p class="text-destructive flex items-center gap-2 font-medium">
        <AlertCircle class="size-4" aria-hidden="true" />
        Depot {{ state.failedDepotId }} failed
      </p>
      <p class="mt-1 text-sm">{{ state.error }}</p>
      <p class="text-muted-foreground mt-2 text-xs">
        {{ state.completedDepotIds.length }} of
        {{ state.depotIds.length }} depots completed before the failure.
      </p>
      <p class="mt-2 text-sm">Completed depots remain installed.</p>
    </template>
  </section>
</template>
