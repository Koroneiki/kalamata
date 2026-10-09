<script setup lang="ts">
import { Download } from '@lucide/vue'
import DownloadAppSummaryIdentity from '@/components/shared/DownloadAppSummaryIdentity.vue'
import type { BackgroundDownloadJob } from '@/types/background-downloads'
import { backgroundDownloadLabel } from '@/utils/background-downloads'

defineProps<{ job: BackgroundDownloadJob }>()
</script>

<template>
  <li class="min-w-0 py-3">
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
    </div>
  </li>
</template>
