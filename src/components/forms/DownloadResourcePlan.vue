<script setup lang="ts">
import { Download, Layers3 } from '@lucide/vue'

import type { ApplicationOperationPreview } from '@/types/rpc'
import { formatBytes, formatSignedBytes } from '@/utils/bytes'

import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

defineProps<{
  preview: ApplicationOperationPreview | null
  loading: boolean
  confirmationLabel: string
}>()

function formattedBytes(value: string | null) {
  return value ? formatBytes(value) : 'Unavailable'
}
</script>

<template>
  <section class="min-w-0" aria-labelledby="resource-plan-title">
    <h3 id="resource-plan-title" class="text-sm font-medium">Resource plan</h3>
    <div
      v-if="loading"
      class="bg-muted/40 mt-2 grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2"
      role="status"
    >
      <div v-for="index in 2" :key="index" class="bg-background p-4">
        <Skeleton class="h-4 w-24" />
        <Skeleton class="mt-3 h-7 w-32" />
        <Skeleton class="mt-2 h-3 w-40 max-w-full" />
      </div>
      <div
        v-if="confirmationLabel === 'Update'"
        class="bg-background flex gap-2 p-4 sm:col-span-2"
      >
        <Skeleton v-for="index in 3" :key="index" class="h-7 w-14" />
      </div>
      <span class="sr-only">Calculating operation requirements.</span>
    </div>
    <div
      v-else-if="preview"
      class="bg-muted/40 mt-2 grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2"
    >
      <div class="bg-background p-4">
        <p
          class="text-muted-foreground flex items-center gap-2 text-xs font-medium"
        >
          <Download class="size-4" aria-hidden="true" /> Estimated download
        </p>
        <p class="mt-1 text-xl font-semibold tabular-nums">
          {{ formatBytes(preview.estimatedDownloadBytes) }}
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          Up to
          {{ formattedBytes(preview.networkPayloadUpperBoundBytes) }} before
          reusing local content
        </p>
      </div>
      <div class="bg-background p-4">
        <p
          class="text-muted-foreground flex items-center gap-2 text-xs font-medium"
        >
          <Layers3 class="size-4" aria-hidden="true" /> Temporary space
        </p>
        <p class="mt-1 text-xl font-semibold tabular-nums">
          Up to {{ formatBytes(preview.stagingLogicalUpperBoundBytes) }}
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          Final installation
          {{ formatSignedBytes(preview.logicalSizeDeltaBytes) }}
        </p>
      </div>
      <div
        v-if="confirmationLabel === 'Update'"
        class="bg-background flex flex-wrap gap-2 p-4 sm:col-span-2"
        aria-label="File changes"
      >
        <Tooltip>
          <TooltipTrigger as-child>
            <span
              class="border-primary/40 bg-primary/10 text-primary dark:border-ring/50 dark:bg-ring/15 dark:text-ring rounded-md border px-2 py-1 font-mono text-sm font-semibold tabular-nums"
              tabindex="0"
              aria-label="Files added"
            >
              +{{ preview.fileCounts.added }}
            </span>
          </TooltipTrigger>
          <TooltipContent>Files added</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <span
              class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-2 py-1 font-mono text-sm font-semibold tabular-nums"
              tabindex="0"
              aria-label="Files removed"
            >
              −{{ preview.fileCounts.removed }}
            </span>
          </TooltipTrigger>
          <TooltipContent>Files removed</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <span
              class="border-info/40 bg-info/10 text-info rounded-md border px-2 py-1 font-mono text-sm font-semibold tabular-nums"
              tabindex="0"
              aria-label="Files modified"
            >
              ~{{ preview.fileCounts.changed }}
            </span>
          </TooltipTrigger>
          <TooltipContent>Files modified</TooltipContent>
        </Tooltip>
      </div>
    </div>
  </section>
</template>
