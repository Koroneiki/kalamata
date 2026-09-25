<script setup lang="ts">
import { ArrowUp, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import BackgroundDownloadIdentity from '@/components/shared/BackgroundDownloadIdentity.vue'
import { Button } from '@/components/ui/button'
import { useBackgroundDownloadsStore } from '@/stores/background-downloads'
import type { BackgroundDownloadJob } from '@/types/background-downloads'
import { formatBytes } from '@/utils/bytes'
import { backgroundDownloadLabel } from '@/utils/background-downloads'

const props = defineProps<{ job: BackgroundDownloadJob }>()
const router = useRouter()
const downloads = useBackgroundDownloadsStore()
const busy = ref(false)
const error = ref('')
const history = computed(() =>
  ['completed', 'failed'].includes(props.job.status),
)
const retryLabel = computed(() =>
  props.job.kind === 'dependency'
    ? 'Retry in Settings'
    : props.job.kind === 'application-update'
      ? 'Retry in Settings'
      : props.job.kind === 'cold-client'
        ? 'Retry from game'
        : 'Retry',
)

function retry() {
  if (
    props.job.kind === 'dependency' ||
    props.job.kind === 'application-update'
  )
    return router.push('/settings')
  if (props.job.kind === 'cold-client')
    return router.push(`/app/${props.job.appId}`)
  return downloads.retry(props.job.id)
}

async function action(kind: 'retry' | 'dismiss' | 'prioritize') {
  busy.value = true
  error.value = ''
  try {
    if (kind === 'retry') await retry()
    else await downloads[kind](props.job.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <li
    class="grid min-w-0 gap-4 py-4"
    :class="
      history
        ? 'grid-cols-[minmax(0,1fr)_auto]'
        : 'sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center'
    "
  >
    <div
      class="min-w-0"
      :class="
        history &&
        'grid gap-3 md:grid-cols-[minmax(17rem,1fr)_minmax(0,1fr)] md:items-center'
      "
    >
      <BackgroundDownloadIdentity v-if="job.appId !== null" :job="job" />
      <p v-else class="font-medium">{{ job.title }}</p>
      <div class="min-w-0">
        <p class="text-muted-foreground text-sm break-words">
          {{ backgroundDownloadLabel(job) }}
          <template v-if="history"> · {{ job.status }}</template>
        </p>
        <p
          v-if="job.totalBytes !== null || job.transferredBytes > 0"
          class="mt-1 text-base font-medium tabular-nums"
        >
          <span class="sr-only">Download size </span>
          {{ formatBytes(String(job.transferredBytes)) }}
        </p>
        <p
          v-if="job.error || error"
          class="text-destructive mt-1 text-sm break-words"
          role="alert"
        >
          {{ error || job.error }}
        </p>
      </div>
    </div>
    <div v-if="job.status === 'queued'" class="flex justify-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="busy"
        :aria-label="`Move ${job.title} next in queue`"
        @click="action('prioritize')"
      >
        <ArrowUp aria-hidden="true" /> Next
      </Button>
    </div>
    <div
      v-else-if="history"
      class="flex flex-col items-end justify-between gap-2"
    >
      <div class="flex items-center gap-2">
        <Button
          v-if="job.status === 'failed'"
          type="button"
          variant="outline"
          size="sm"
          :disabled="busy"
          @click="action('retry')"
          >{{ retryLabel }}</Button
        >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          :disabled="busy"
          :aria-label="`Dismiss ${job.title}`"
          :title="`Dismiss ${job.title}`"
          @click="action('dismiss')"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <time
        v-if="job.finishedAt !== null"
        class="text-muted-foreground text-right text-xs tabular-nums"
        :datetime="new Date(job.finishedAt).toISOString()"
      >
        {{
          new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(job.finishedAt)
        }}
      </time>
    </div>
  </li>
</template>
