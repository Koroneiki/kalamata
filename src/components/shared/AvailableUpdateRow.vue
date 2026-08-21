<script setup lang="ts">
import { computed } from 'vue'

import DownloadAppIdentity from '@/components/shared/DownloadAppIdentity.vue'
import { Button } from '@/components/ui/button'
import type { AvailableUpdateCandidate } from '@/types/rpc'
import { formatBytes } from '@/utils/bytes'

const props = defineProps<{
  candidate: AvailableUpdateCandidate
  reviewing: boolean
  disabled: boolean
  error: string
}>()

const actionLabel = computed(() => {
  if (props.reviewing) return 'Preparing...'
  return props.error ? 'Retry' : 'Download'
})

defineEmits<{ review: [] }>()
</script>

<template>
  <li
    class="grid min-w-0 gap-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
  >
    <div
      class="grid min-w-0 gap-3 md:grid-cols-[minmax(17rem,1fr)_minmax(0,1fr)] md:items-center"
    >
      <DownloadAppIdentity
        :app-id="candidate.app.appId"
        :app="candidate.app"
        artwork="wide"
      />
      <div class="min-w-0">
        <p class="text-muted-foreground text-xs tabular-nums">
          {{ candidate.outdatedDepots.length }} depots
        </p>
        <p
          v-if="candidate.totalDownloadBytes !== null"
          class="mt-1 text-base font-medium tabular-nums"
        >
          <span class="sr-only">Estimated download size </span>
          {{ formatBytes(candidate.totalDownloadBytes) }}
        </p>
        <p v-if="error" class="text-destructive mt-2 text-sm" role="alert">
          {{ error }}
        </p>
      </div>
    </div>
    <Button
      class="w-full sm:w-auto"
      type="button"
      size="sm"
      :disabled="disabled"
      @click="$emit('review')"
    >
      {{ actionLabel }}
    </Button>
  </li>
</template>
