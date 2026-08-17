<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { Button } from '@/components/ui/button'
import { useAvailableUpdates } from '@/composables/use-available-updates'

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
  <div class="mb-3 flex items-center justify-between gap-4">
    <h2 class="text-sm font-medium">Available updates</h2>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      :disabled="availableUpdates.running.value"
      @click="availableUpdates.refreshAll()"
    >
      Refresh
    </Button>
  </div>
  <p
    v-if="availableUpdates.running.value"
    class="text-muted-foreground mb-3 text-sm"
  >
    Checking {{ availableUpdates.checked.value }} of
    {{ availableUpdates.total.value }}
  </p>
  <div
    v-if="failureMessage"
    class="mb-3 flex items-center justify-between gap-4"
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
