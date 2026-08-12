<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue'

defineProps<{
  completed: number
  total: number
}>()
</script>

<template>
  <div class="flex h-16 items-center gap-3 px-4">
    <LoaderCircle
      class="text-primary size-4 shrink-0 animate-spin"
      aria-hidden="true"
    />
    <p class="min-w-0 flex-1 text-sm font-medium">Downloading manifests</p>
    <span class="text-muted-foreground font-mono text-xs tabular-nums">
      {{ completed }} / {{ total }}
    </span>
  </div>
</template>
