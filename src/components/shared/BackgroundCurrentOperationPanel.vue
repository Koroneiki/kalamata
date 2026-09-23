<script setup lang="ts">
import { computed } from 'vue'
import { Download } from '@lucide/vue'

import BackgroundDownloadIdentity from '@/components/shared/BackgroundDownloadIdentity.vue'
import { Progress } from '@/components/ui/progress'
import type { BackgroundDownloadJob } from '@/types/background-downloads'
import { formatBytes } from '@/utils/bytes'
import { backgroundDownloadLabel } from '@/utils/background-downloads'

const props = defineProps<{ job: BackgroundDownloadJob }>()
const manifestStatus = computed(() => {
  const { itemCount, manifestProgress } = props.job
  if (!itemCount || !manifestProgress) return null
  const processed = `${manifestProgress.finishedCount} of ${itemCount} processed`
  if (manifestProgress.currentIndex === null) return processed
  const current = `Manifest ${manifestProgress.currentIndex} of ${itemCount}`
  const depot = manifestProgress.currentDepotId
    ? ` · Depot ${manifestProgress.currentDepotId}`
    : ''
  return `${processed} · ${current}${depot}`
})
const totalTransfer = computed(() => {
  const { transferredBytes, totalBytes } = props.job
  return totalBytes !== null || transferredBytes > 0
    ? transferLabel(transferredBytes, totalBytes)
    : null
})
const currentTransfer = computed(() => {
  const progress = props.job.manifestProgress
  return progress &&
    (progress.totalBytes !== null || progress.transferredBytes > 0)
    ? transferLabel(progress.transferredBytes, progress.totalBytes)
    : null
})

function transferLabel(transferred: number, total: number | null): string {
  const amount = formatBytes(String(transferred))
  return total === null ? amount : `${amount} / ${formatBytes(String(total))}`
}

const percentage = computed(() => {
  const { manifestProgress, itemCount } = props.job
  if (manifestProgress && itemCount) {
    // Unknown transfer sizes advance the group bar only when that manifest finishes.
    const currentFraction = manifestProgress.totalBytes
      ? Math.min(
          1,
          manifestProgress.transferredBytes / manifestProgress.totalBytes,
        )
      : 0
    return Math.min(
      100,
      ((manifestProgress.finishedCount + currentFraction) / itemCount) * 100,
    )
  }
  return props.job.totalBytes && props.job.totalBytes > 0
    ? Math.min(100, (props.job.transferredBytes / props.job.totalBytes) * 100)
    : null
})
</script>

<template>
  <div
    class="bg-muted/60 grid min-w-0 gap-5 border-b px-4 py-5 sm:px-5 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(20rem,1.2fr)] lg:items-center"
  >
    <div class="min-w-0">
      <BackgroundDownloadIdentity v-if="job.appId !== null" :job="job" />
      <p v-else class="text-base font-semibold">{{ job.title }}</p>
    </div>
    <div class="min-w-0">
      <div
        class="flex min-w-0 items-baseline justify-between gap-3 text-xs font-semibold tracking-wide"
      >
        <h3 class="min-w-0 break-words">{{ backgroundDownloadLabel(job) }}</h3>
        <span v-if="percentage !== null" class="font-mono tabular-nums">
          {{ Math.round(percentage) }}%
        </span>
      </div>
      <Progress
        v-if="percentage !== null"
        class="mt-2 h-1"
        :model-value="percentage"
        aria-label="Background download progress"
      />
      <div
        v-else
        class="bg-primary/20 mt-2 h-1 overflow-hidden rounded-full"
        role="progressbar"
        :aria-label="`${job.phase} in progress`"
      >
        <div
          class="operation-indeterminate bg-primary h-full w-1/2 rounded-full"
        />
      </div>
      <div
        class="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      >
        <span class="capitalize">{{ job.phase }}</span>
        <span v-if="manifestStatus">{{ manifestStatus }}</span>
        <span v-if="totalTransfer" class="flex items-center gap-1 tabular-nums">
          <Download class="size-3" aria-hidden="true" />
          {{ totalTransfer }}
        </span>
        <span v-if="currentTransfer" class="tabular-nums">
          Current: {{ currentTransfer }}
        </span>
      </div>
    </div>
  </div>
</template>
