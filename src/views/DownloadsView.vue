<script setup lang="ts">
import { computed, reactive } from 'vue'

import AvailableUpdatesSection from '@/components/shared/AvailableUpdatesSection.vue'
import BackgroundDownloadsSection from '@/components/shared/BackgroundDownloadsSection.vue'
import CurrentOperationPanel from '@/components/shared/CurrentOperationPanel.vue'
import DownloadHistorySection from '@/components/shared/DownloadHistorySection.vue'
import DownloadIssueRow from '@/components/shared/DownloadIssueRow.vue'
import PendingOperationRow from '@/components/shared/PendingOperationRow.vue'
import { useOperationStore } from '@/stores/operation'
import type { OperationState } from '@/types/rpc'

const operation = useOperationStore()
const removing = reactive(new Set<string>())
const prioritizing = reactive(new Set<string>())
const rowErrors = reactive(new Map<string, string>())

const current = computed(() =>
  isVisibleOperation(operation.state) ? operation.state : null,
)
const issues = computed(() => {
  const unresolved = new Map(
    operation.issues.map((state) => [state.appId, state]),
  )
  const state = operation.state
  if (state.status === 'failed' || state.status === 'repair-required')
    unresolved.set(state.appId, state)
  const rows = [...unresolved.values()].filter(
    (issue) => !operation.pending.some((item) => item.appId === issue.appId),
  )
  return state.status === 'resumable' ? [state, ...rows] : rows
})
function isVisibleOperation(
  state: OperationState,
): state is Extract<OperationState, { status: 'active' | 'paused' }> {
  return state.status === 'active' || state.status === 'paused'
}

async function remove(id: string) {
  removing.add(id)
  rowErrors.delete(id)
  try {
    await operation.removePending(id)
  } catch (error) {
    rowErrors.set(id, error instanceof Error ? error.message : String(error))
  } finally {
    removing.delete(id)
  }
}

async function prioritize(id: string) {
  prioritizing.add(id)
  rowErrors.delete(id)
  try {
    await operation.prioritizePending(id)
  } catch (error) {
    rowErrors.set(id, error instanceof Error ? error.message : String(error))
  } finally {
    prioritizing.delete(id)
  }
}
</script>

<template>
  <main class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
    <h1 class="text-2xl font-semibold tracking-tight">Downloads</h1>

    <section v-if="current" class="mt-7" aria-label="Current download">
      <CurrentOperationPanel :state="current" />
    </section>

    <section
      v-if="operation.pending.length || issues.length"
      class="mt-10"
      aria-labelledby="next-up-heading"
    >
      <h2
        id="next-up-heading"
        class="flex items-baseline gap-2 border-b pb-3 text-lg font-semibold"
      >
        Next up
        <span
          class="text-muted-foreground font-mono text-xs font-normal tabular-nums"
        >
          {{ operation.pending.length + issues.length }}
        </span>
      </h2>
      <ol class="divide-border divide-y">
        <PendingOperationRow
          v-for="item in operation.pending"
          :key="item.id"
          :item="item"
          :removing="removing.has(item.id)"
          :prioritizing="prioritizing.has(item.id)"
          :error="rowErrors.get(item.id) ?? ''"
          @download="prioritize(item.id)"
          @remove="remove(item.id)"
        />
        <DownloadIssueRow
          v-for="state in issues"
          :key="state.appId"
          :state="state"
        />
      </ol>
    </section>

    <AvailableUpdatesSection />
    <BackgroundDownloadsSection />
    <DownloadHistorySection />
  </main>
</template>
