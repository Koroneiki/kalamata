<script setup lang="ts">
import { Badge } from '@/components/ui/badge'

defineProps<{
  name: string
  count: number
}>()
</script>

<template>
  <span
    class="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 pr-2"
  >
    <span class="flex items-center gap-2">
      <span>{{ name }}</span>
      <Badge variant="outline" class="tabular-nums">
        {{ count }}
      </Badge>
    </span>
    <slot />
  </span>
</template>
