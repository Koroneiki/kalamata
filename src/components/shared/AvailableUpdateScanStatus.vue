<script setup lang="ts">
import { RefreshCw } from '@lucide/vue'
import { computed, onMounted } from 'vue'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAvailableUpdates } from '@/composables/use-available-updates'

defineProps<{ candidateCount: number }>()

const availableUpdates = useAvailableUpdates()
const failureMessage = computed(() => {
  if (availableUpdates.scanError.value) return availableUpdates.scanError.value
  const count = availableUpdates.failures.value.length
  if (!count) return ''
  return `${count} update ${count === 1 ? 'check' : 'checks'} failed.`
})

function retry() {
  return availableUpdates.scanError.value
    ? availableUpdates.refreshAll()
    : availableUpdates.retryFailed()
}

onMounted(() => void availableUpdates.refreshAll())
</script>

<template>
  <div class="flex items-center justify-between gap-4 border-b pb-3">
    <h2
      id="available-updates-heading"
      class="flex min-w-0 items-baseline gap-2 text-lg font-semibold"
    >
      Available updates
      <span
        v-if="candidateCount"
        class="text-muted-foreground font-mono text-xs font-normal tabular-nums"
      >
        {{ candidateCount }}
      </span>
    </h2>
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Refresh available updates"
      title="Refresh available updates"
      :disabled="availableUpdates.running.value"
      @click="availableUpdates.refreshAll()"
    >
      <RefreshCw aria-hidden="true" />
    </Button>
  </div>
  <div
    v-if="availableUpdates.running.value"
    class="border-b py-4"
    role="status"
    aria-label="Checking for available updates"
  >
    <Skeleton class="h-4 w-40 max-w-full" />
  </div>
  <div
    v-if="failureMessage"
    class="flex flex-col items-start gap-2 border-b py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
  >
    <p class="text-destructive text-sm" role="alert">
      {{ failureMessage }}
    </p>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      :disabled="availableUpdates.running.value"
      @click="retry"
    >
      Retry
    </Button>
  </div>
</template>
