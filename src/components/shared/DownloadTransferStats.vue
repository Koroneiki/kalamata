<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  bytesPerSecond: number | null
  remainingSeconds: number | null
}>()
const eta = computed(() => {
  const seconds = props.remainingSeconds
  if (seconds === null) return null
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
})
</script>

<template>
  <span
    v-if="bytesPerSecond !== null"
    class="text-muted-foreground whitespace-nowrap tabular-nums"
    aria-label="Download speed"
  >
    {{ (bytesPerSecond / 1_000_000).toFixed(2) }} MB/s
  </span>
  <span
    v-if="eta"
    class="text-muted-foreground whitespace-nowrap tabular-nums"
    aria-label="Estimated download time remaining"
    title="Estimated transfer time; excludes installation"
  >
    ETA ≈ {{ eta }}
  </span>
</template>
