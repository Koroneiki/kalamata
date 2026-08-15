<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import InlineOperationStatus from '@/components/shared/InlineOperationStatus.vue'
import { Button } from '@/components/ui/button'
import { useOperationStore } from '@/stores/operation'
import type { OperationState, PendingDownload } from '@/types/rpc'

const operation = useOperationStore()
const removing = reactive(new Set<string>())
const removalError = ref('')

const current = computed(() =>
  isVisibleOperation(operation.state) ? operation.state : null,
)
const empty = computed(() => !current.value && operation.pending.length === 0)

function isVisibleOperation(
  state: OperationState,
): state is Exclude<
  OperationState,
  { status: 'idle' | 'completed' | 'cancelled' }
> {
  return !['idle', 'completed', 'cancelled'].includes(state.status)
}

function operationLabel(item: PendingDownload) {
  if (item.kind === 'download') return 'Install'
  if (item.kind === 'repair') return 'Verify'
  return item.desiredDepotIds.length === 0 ? 'Uninstall' : 'Update'
}

function removeLabel(id: string) {
  return removing.has(id) ? 'Removing...' : 'Remove'
}

async function remove(id: string) {
  removing.add(id)
  removalError.value = ''
  try {
    await operation.removePending(id)
  } catch (error) {
    removalError.value = error instanceof Error ? error.message : String(error)
  } finally {
    removing.delete(id)
  }
}
</script>

<template>
  <section class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
    <h1 class="text-xl font-semibold">Downloads</h1>

    <div v-if="current" class="mt-6">
      <h2 class="mb-3 text-sm font-medium">Current</h2>
      <InlineOperationStatus :state="current" />
    </div>

    <div v-if="operation.pending.length" class="mt-8">
      <h2 class="mb-3 text-sm font-medium">Next up</h2>
      <ul class="divide-border divide-y rounded-md border">
        <li
          v-for="item in operation.pending"
          :key="item.id"
          class="flex min-w-0 items-center justify-between gap-4 px-4 py-3"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">App {{ item.appId }}</p>
            <p class="text-muted-foreground text-xs">
              {{ operationLabel(item) }}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :disabled="removing.has(item.id)"
            @click="remove(item.id)"
          >
            {{ removeLabel(item.id) }}
          </Button>
        </li>
      </ul>
    </div>

    <div v-if="empty" class="mt-6 rounded-md border border-dashed p-6">
      <p class="text-sm font-medium">No downloads</p>
      <p class="text-muted-foreground mt-1 text-sm">
        Work started from an app page will appear here.
      </p>
    </div>

    <p v-show="removalError" class="text-destructive mt-4 text-sm" role="alert">
      {{ removalError }}
    </p>
  </section>
</template>
