<script setup lang="ts">
import { LoaderCircle, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import { useColdClientOperationStore } from '@/stores/cold-client-operation'
import type {
  ColdClientOperationKind,
  ColdClientOperationPhase,
} from '@/types/cold-client'

const operation = useColdClientOperationStore()
const cancelling = ref(false)
const cancelError = ref('')

const kindLabels = {
  setup: 'ColdClient setup',
  regenerate: 'ColdClient regeneration',
  'update-core': 'ColdClient update',
  remove: 'ColdClient removal',
} satisfies Record<ColdClientOperationKind, string>

const phaseLabels = {
  'waiting-for-generator': 'Waiting for GSE Tools',
  building: 'Preparing files',
  replacing: 'Installing files',
  validating: 'Validating installation',
  removing: 'Removing files',
} satisfies Record<ColdClientOperationPhase, string>

const label = computed(() => {
  const state = operation.state
  return state.status === 'active'
    ? `${kindLabels[state.kind]}: ${phaseLabels[state.phase]}`
    : ''
})

watch(
  () => operation.state.status,
  () => {
    cancelling.value = false
    cancelError.value = ''
  },
  { immediate: true },
)

async function cancel() {
  const state = operation.state
  if (state.status !== 'active' || !state.cancellable) return
  cancelling.value = true
  cancelError.value = ''
  try {
    const result = await operation.cancel(state.appId)
    if (!result.accepted && result.reason === 'replacement-in-progress')
      cancelError.value =
        'Installation has started and can no longer be cancelled.'
  } catch (error) {
    cancelError.value = error instanceof Error ? error.message : String(error)
  } finally {
    cancelling.value = false
  }
}
</script>

<template>
  <div
    v-if="operation.state.status === 'active'"
    class="bg-muted/70 border-border flex min-w-0 items-center gap-3 border-b px-4 py-2 sm:px-6"
    role="status"
    aria-live="polite"
  >
    <LoaderCircle class="text-primary size-4 shrink-0 animate-spin" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium">{{ label }}</p>
      <p v-if="cancelError" class="text-destructive text-xs" role="alert">
        {{ cancelError }}
      </p>
      <p v-else class="text-muted-foreground text-xs tabular-nums">
        Steam App {{ operation.state.appId }}
      </p>
    </div>
    <Button
      v-if="operation.state.cancellable"
      type="button"
      variant="ghost"
      size="sm"
      :disabled="cancelling"
      @click="cancel"
    >
      <X class="size-4" />
      {{ cancelling ? 'Cancelling' : 'Cancel' }}
    </Button>
    <span v-else class="text-muted-foreground shrink-0 text-xs">
      Finishing
    </span>
  </div>
</template>
