<script setup lang="ts">
import { Download, X } from '@lucide/vue'
import DownloadAppSummaryIdentity from '@/components/shared/DownloadAppSummaryIdentity.vue'
import { Button } from '@/components/ui/button'
import type { DownloadHistoryEntry } from '@/types/download-history'
import { formatBytes } from '@/utils/bytes'

defineProps<{ entry: DownloadHistoryEntry; dismissing: boolean }>()
defineEmits<{ dismiss: [] }>()
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
</script>

<template>
  <li
    class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    :class="entry.compact ? 'py-2' : 'py-4'"
  >
    <div
      class="min-w-0"
      :class="
        entry.compact
          ? 'flex flex-wrap items-center gap-x-4 gap-y-1'
          : 'grid gap-3 md:grid-cols-[minmax(17rem,1fr)_minmax(0,1fr)] md:items-center'
      "
    >
      <DownloadAppSummaryIdentity
        v-if="entry.appId !== null"
        :app-id="entry.appId"
        :artwork="entry.compact ? 'icon' : 'wide'"
      />
      <p v-else class="flex min-w-0 items-center gap-4 text-sm font-medium">
        <Download class="size-8 shrink-0 p-1.5" aria-hidden="true" />{{
          entry.title
        }}
      </p>
      <div class="min-w-0">
        <p class="text-muted-foreground text-sm break-words">
          <template v-if="entry.description"
            >{{ entry.description }} ·
          </template>
          <span class="capitalize">{{ entry.status }}</span>
          <template
            v-if="entry.transferredBytes !== '0' || entry.totalBytes != null"
          >
            · {{ formatBytes(entry.transferredBytes) }}</template
          >
        </p>
        <p v-if="entry.error" class="text-destructive text-sm break-words">
          {{ entry.error }}
        </p>
      </div>
    </div>
    <div class="flex items-center justify-end gap-2">
      <time
        class="text-muted-foreground text-right text-xs tabular-nums"
        :datetime="new Date(entry.finishedAt).toISOString()"
        >{{ dateFormatter.format(entry.finishedAt) }}</time
      >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        :disabled="dismissing"
        :aria-label="`Dismiss ${entry.title}`"
        :title="`Dismiss ${entry.title}`"
        @click="$emit('dismiss')"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  </li>
</template>
