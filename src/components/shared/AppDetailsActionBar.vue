<script setup lang="ts">
import { Download, FolderOpen, Plus, Settings, Trash2 } from '@lucide/vue'
import { computed, ref } from 'vue'

import InlineOperationStatus from '@/components/shared/InlineOperationStatus.vue'
import { Button } from '@/components/ui/button'
import type {
  ActiveOperationState,
  AppDetails,
  OperationState,
  PausedOperationState,
  ResumableOperationState,
} from '@/types/rpc'

type ProgressOperation =
  | ActiveOperationState
  | PausedOperationState
  | ResumableOperationState
type VisibleOperation =
  | ProgressOperation
  | Extract<OperationState, { status: 'failed' | 'repair-required' }>

const props = defineProps<{
  app: AppDetails
  primaryAction: {
    label: string
    enabled: boolean
    pending: boolean
  }
  localActions: {
    hasInstalledDepots: boolean
    browsePending: boolean
    globalOperationBusy: boolean
  }
  operationForApp: VisibleOperation | null
  operationFinished: boolean
}>()

defineEmits<{
  openDownload: []
  addToLibrary: []
  browse: []
  openSettings: []
}>()

const operationPanel = ref<{ focusHeading: () => void } | null>(null)
const showLocalActions = computed(
  () => Boolean(props.app.installPath) || props.localActions.hasInstalledDepots,
)

defineExpose({
  focusHeading() {
    operationPanel.value?.focusHeading()
  },
})
</script>

<template>
  <div
    class="border-border flex flex-col gap-3 border-t py-5 sm:flex-row sm:flex-wrap sm:items-center"
  >
    <Button
      v-if="app.inLibrary"
      class="h-16 w-full min-w-44 shrink-0 gap-3 rounded-sm px-8 text-lg font-semibold tracking-wider shadow-sm sm:w-auto [&_svg:not([class*='size-'])]:size-7"
      type="button"
      :disabled="!primaryAction.enabled"
      @click="$emit('openDownload')"
    >
      <Trash2 v-if="primaryAction.label === 'Uninstall'" aria-hidden="true" />
      <Download v-else aria-hidden="true" />
      {{ primaryAction.label }}
    </Button>
    <Button
      v-else
      class="h-14 w-full min-w-44 gap-3 rounded-sm px-8 text-lg font-semibold tracking-wider shadow-sm sm:w-auto [&_svg:not([class*='size-'])]:size-7"
      type="button"
      :disabled="primaryAction.pending"
      @click="$emit('addToLibrary')"
    >
      <Plus aria-hidden="true" />
      {{ primaryAction.pending ? 'ADDING…' : 'ADD TO LIBRARY' }}
    </Button>
    <InlineOperationStatus
      v-if="operationForApp"
      ref="operationPanel"
      class="min-w-64 flex-1 sm:max-w-100"
      :state="operationForApp"
      :finished="operationFinished"
    />
    <div
      v-if="showLocalActions"
      class="flex shrink-0 items-center gap-2 self-end sm:ml-auto sm:self-auto"
    >
      <Button
        v-if="app.installPath"
        type="button"
        size="sm"
        variant="outline"
        :disabled="localActions.browsePending"
        @click="$emit('browse')"
      >
        <FolderOpen aria-hidden="true" />
        Browse local files
      </Button>
      <Button
        v-if="localActions.hasInstalledDepots"
        type="button"
        size="icon-sm"
        variant="outline"
        :disabled="localActions.globalOperationBusy"
        aria-label="Game settings"
        title="Game settings"
        @click="$emit('openSettings')"
      >
        <Settings aria-hidden="true" />
      </Button>
    </div>
  </div>
</template>
