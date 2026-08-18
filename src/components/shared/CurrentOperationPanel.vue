<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'

import DownloadAppIdentity from '@/components/shared/DownloadAppIdentity.vue'
import InlineOperationStatus from '@/components/shared/InlineOperationStatus.vue'
import {
  isProgressOperation,
  mergeOperationProgress,
} from '@/composables/use-app-operation-display'
import { useAppSummaryQuery } from '@/composables/queries'
import type { OperationState } from '@/types/rpc'

type VisibleOperation = Exclude<
  OperationState,
  { status: 'idle' | 'completed' | 'cancelled' }
>

const props = defineProps<{ state: VisibleOperation }>()
const { data, isPending } = useAppSummaryQuery(
  computed(() => props.state.appId),
)
const displayedState = shallowRef<VisibleOperation>(props.state)

watch(
  () => props.state,
  (state) => {
    const displayed = displayedState.value
    // Resume briefly reports zeroed counters while the backend replans.
    displayedState.value =
      isProgressOperation(state) &&
      isProgressOperation(displayed) &&
      state.appId === displayed.appId
        ? mergeOperationProgress(state, displayed)
        : state
  },
)
</script>

<template>
  <div
    class="bg-muted/60 grid min-w-0 gap-5 border-b px-4 py-5 sm:px-5 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(20rem,1.2fr)] lg:items-center"
  >
    <div class="min-w-0">
      <DownloadAppIdentity
        :app-id="state.appId"
        :app="data"
        :pending="isPending"
        artwork="wide"
      />
    </div>

    <div class="min-w-0">
      <InlineOperationStatus :state="displayedState" show-installed-progress />
    </div>
  </div>
</template>
