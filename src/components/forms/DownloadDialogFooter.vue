<script setup lang="ts">
import { computed } from 'vue'

import type { ApplicationOperationPreview } from '@/types/rpc'

import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'

const props = defineProps<{
  preview: ApplicationOperationPreview | null
  hasPlannedChanges: boolean
  canStart: boolean
  starting: boolean
  confirmationLabel: string
}>()

defineEmits<{
  cancel: []
  confirm: []
}>()

const closeLabel = computed(() =>
  props.preview && !props.hasPlannedChanges ? 'Close' : 'Cancel',
)
const showConfirm = computed(() => !props.preview || props.hasPlannedChanges)
const activeLabel = computed(() => {
  if (props.confirmationLabel === 'Uninstall') return 'Uninstalling'
  if (props.confirmationLabel === 'Update') return 'Updating'
  return 'Installing'
})
const confirmLabel = computed(() =>
  props.starting ? `${activeLabel.value}…` : props.confirmationLabel,
)
</script>

<template>
  <DialogFooter class="bg-background min-w-0 border-t px-5 py-4 sm:px-6">
    <Button
      type="button"
      variant="outline"
      :disabled="starting"
      @click="$emit('cancel')"
      >{{ closeLabel }}</Button
    >
    <Button
      v-if="showConfirm"
      type="button"
      :disabled="!canStart"
      @click="$emit('confirm')"
    >
      {{ confirmLabel }}
    </Button>
  </DialogFooter>
</template>
