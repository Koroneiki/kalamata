<script setup lang="ts">
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import type { AvailableUpdateCandidate } from '@/types/rpc'
import { formatBytes } from '@/utils/bytes'

const props = defineProps<{
  candidate: AvailableUpdateCandidate
  reviewing: boolean
  disabled: boolean
  error: string
}>()

const depotLabel = computed(() =>
  props.candidate.outdatedDepots.length === 1 ? 'depot' : 'depots',
)
const actionLabel = computed(() => {
  if (props.reviewing) return 'Preparing...'
  return props.error ? 'Retry' : 'Review update'
})

defineEmits<{ review: [] }>()
</script>

<template>
  <li
    class="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3"
  >
    <div class="min-w-0">
      <p class="truncate text-sm font-medium">{{ candidate.app.name }}</p>
      <p class="text-muted-foreground text-xs">
        {{ candidate.outdatedDepots.length }} {{ depotLabel }}
        <template v-if="candidate.totalDownloadBytes !== null">
          - {{ formatBytes(candidate.totalDownloadBytes) }}
        </template>
      </p>
      <p v-if="error" class="text-destructive mt-1 text-xs" role="alert">
        {{ error }}
      </p>
    </div>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      :disabled="disabled"
      @click="$emit('review')"
    >
      {{ actionLabel }}
    </Button>
  </li>
</template>
