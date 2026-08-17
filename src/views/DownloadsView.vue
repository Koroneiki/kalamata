<script setup lang="ts">
import { computed, reactive } from 'vue'

import AvailableUpdatesSection from '@/components/shared/AvailableUpdatesSection.vue'
import CurrentOperationPanel from '@/components/shared/CurrentOperationPanel.vue'
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
function isVisibleOperation(
  state: OperationState,
): state is Exclude<
  OperationState,
  { status: 'idle' | 'completed' | 'cancelled' }
> {
  return !['idle', 'completed', 'cancelled'].includes(state.status)
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
      v-if="operation.pending.length"
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
          {{ operation.pending.length }}
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
      </ol>
    </section>

    <AvailableUpdatesSection />
  </main>
</template>
