<script setup lang="ts">
import { computed } from 'vue'
import BackgroundCurrentOperationPanel from './BackgroundCurrentOperationPanel.vue'
import BackgroundDownloadRow from './BackgroundDownloadRow.vue'
import { useBackgroundDownloadsStore } from '@/stores/background-downloads'

const downloads = useBackgroundDownloadsStore()
const active = computed(() =>
  downloads.jobs.find((job) => job.status === 'active'),
)
const queued = computed(() =>
  downloads.jobs.filter((job) => job.status === 'queued'),
)
const history = computed(() =>
  downloads.jobs
    .filter((job) => job.status === 'completed' || job.status === 'failed')
    .toReversed()
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0)),
)
</script>

<template>
  <section
    v-if="downloads.jobs.length"
    class="mt-10"
    aria-labelledby="background-downloads-heading"
  >
    <h2
      id="background-downloads-heading"
      class="border-b pb-3 text-xl font-semibold"
    >
      Jobs
    </h2>
    <div v-if="active" class="mt-6" aria-label="Current background job">
      <BackgroundCurrentOperationPanel :job="active" />
    </div>
    <section
      v-if="queued.length"
      class="mt-8"
      aria-labelledby="background-queue-heading"
    >
      <h3
        id="background-queue-heading"
        class="flex items-baseline gap-2 border-b pb-3 text-lg font-semibold"
      >
        Next up
        <span
          class="text-muted-foreground font-mono text-xs font-normal tabular-nums"
          >{{ queued.length }}</span
        >
      </h3>
      <ol class="divide-border divide-y">
        <BackgroundDownloadRow v-for="job in queued" :key="job.id" :job="job" />
      </ol>
    </section>
    <section
      v-if="history.length"
      class="mt-8"
      aria-labelledby="background-history-heading"
    >
      <h3
        id="background-history-heading"
        class="border-b pb-3 text-lg font-semibold"
      >
        History
      </h3>
      <ul class="divide-border divide-y">
        <BackgroundDownloadRow
          v-for="job in history"
          :key="job.id"
          :job="job"
        />
      </ul>
    </section>
  </section>
</template>
