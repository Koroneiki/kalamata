<script setup lang="ts">
import { ArrowUp, Download } from '@lucide/vue'
import { ref } from 'vue'
import DownloadAppSummaryIdentity from '@/components/shared/DownloadAppSummaryIdentity.vue'
import { Button } from '@/components/ui/button'
import { useBackgroundDownloadsStore } from '@/stores/background-downloads'
import type { BackgroundDownloadJob } from '@/types/background-downloads'
import { backgroundDownloadLabel } from '@/utils/background-downloads'

const props = defineProps<{ job: BackgroundDownloadJob }>()
const downloads = useBackgroundDownloadsStore()
const busy = ref(false)
const error = ref('')

async function prioritize() {
  busy.value = true
  error.value = ''
  try {
    await downloads.prioritize(props.job.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <li
    class="grid min-w-0 gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
  >
    <div class="min-w-0">
      <DownloadAppSummaryIdentity
        v-if="job.appId !== null"
        :app-id="job.appId"
      />
      <p v-else class="flex items-center gap-4 text-sm font-medium">
        <Download class="size-8 shrink-0 p-1.5" aria-hidden="true" />{{
          job.title
        }}
      </p>
      <p class="text-muted-foreground mt-1 text-xs break-words">
        {{ backgroundDownloadLabel(job) }}
      </p>
      <p
        v-if="error"
        class="text-destructive mt-1 text-sm break-words"
        role="alert"
      >
        {{ error }}
      </p>
    </div>
    <div class="flex justify-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="busy"
        :aria-label="`Move ${job.title} next in queue`"
        @click="prioritize"
      >
        <ArrowUp aria-hidden="true" /> Next
      </Button>
    </div>
  </li>
</template>
