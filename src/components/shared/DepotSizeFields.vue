<script setup lang="ts">
import { formatBytes } from '@/utils/bytes'

defineProps<{
  downloadBytes: string | null
  sizeBytes: string | null
}>()

function formattedBytes(value: string | null) {
  return value ? formatBytes(value) : 'Unavailable'
}
</script>

<template>
  <div class="space-y-1">
    <dt class="text-muted-foreground text-xs">Download size</dt>
    <dd class="text-sm font-medium tabular-nums">
      {{ formattedBytes(downloadBytes) }}
    </dd>
  </div>
  <div class="space-y-1">
    <dt class="text-muted-foreground text-xs">Size on disk</dt>
    <dd class="text-sm font-medium tabular-nums">
      {{ formattedBytes(sizeBytes) }}
    </dd>
  </div>
</template>
