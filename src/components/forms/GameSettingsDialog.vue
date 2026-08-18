<script setup lang="ts">
import { Trash2 } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

defineProps<{
  open: boolean
  appName: string
  verifyDisabled: boolean
  removeDisabled: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  verify: []
  remove: []
}>()
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle class="text-primary">{{ appName }}</DialogTitle>
      </DialogHeader>

      <div class="border-border flex items-center gap-2 border-t pt-4">
        <Button
          type="button"
          size="sm"
          variant="outline"
          :disabled="verifyDisabled"
          @click="emit('verify')"
        >
          Verify game files
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          :disabled="removeDisabled"
          aria-label="Remove from library"
          @click="emit('remove')"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
