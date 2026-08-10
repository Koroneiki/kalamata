<script setup lang="ts">
import type { DepotSelectionSummary } from '@/utils/depots'
import { formatBytes } from '@/utils/bytes'

import { Badge } from '@/components/ui/badge'

withDefaults(
  defineProps<{
    summary: DepotSelectionSummary
    showMissing?: boolean
  }>(),
  { showMissing: true },
)
</script>

<template>
  <span class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
    <span class="tabular-nums">{{ summary.selected }}/{{ summary.total }}</span>
    <span aria-hidden="true">·</span>
    <span class="tabular-nums">
      {{
        summary.sizeBytes === null
          ? 'Size unavailable'
          : formatBytes(summary.sizeBytes)
      }}
    </span>
    <Badge v-if="showMissing && summary.missing" variant="outline">
      Missing
    </Badge>
  </span>
</template>
