<script setup lang="ts">
import DownloadHistoryRow from '@/components/shared/DownloadHistoryRow.vue'
import { Button } from '@/components/ui/button'
import { useDownloadHistory } from '@/composables/use-download-history'

const { history, clear, dismiss } = useDownloadHistory()
const { data: entries, error, isPending } = history
const { mutate: clearAll, isLoading: clearing, error: clearError } = clear
const {
  mutate: dismissEntry,
  isLoading: dismissing,
  error: dismissError,
} = dismiss
</script>

<template>
  <section class="mt-10" aria-labelledby="download-history-heading">
    <div class="flex items-center justify-between gap-4 border-b pb-3">
      <h2 id="download-history-heading" class="text-xl font-semibold">
        History
      </h2>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :disabled="clearing || dismissing || !entries?.length"
        @click="clearAll()"
        >Clear all</Button
      >
    </div>
    <p
      v-if="error || clearError || dismissError"
      class="text-destructive mt-3 text-sm"
      role="alert"
    >
      {{ (error || clearError || dismissError)?.message }}
    </p>
    <ul v-if="entries?.length" class="divide-border divide-y">
      <DownloadHistoryRow
        v-for="entry in entries"
        :key="entry.id"
        :entry="entry"
        :dismissing="clearing || dismissing"
        @dismiss="dismissEntry(entry.id)"
      />
    </ul>
    <p v-else class="text-muted-foreground py-4 text-sm">
      {{ isPending ? 'Loading history…' : 'No history yet.' }}
    </p>
  </section>
</template>
