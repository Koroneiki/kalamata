<script setup lang="ts">
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

defineProps<{
  open: boolean
  pausedForCancel: boolean
  actionPending: boolean
  actionError: string
}>()

defineEmits<{
  'update:open': [open: boolean]
  confirm: []
}>()
</script>

<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Cancel operation?</DialogTitle>
        <DialogDescription>
          {{
            pausedForCancel
              ? 'The operation is paused. Kalamata will discard its staged files.'
              : 'Kalamata will stop the operation before installation begins.'
          }}
        </DialogDescription>
      </DialogHeader>
      <p v-if="actionError" class="text-destructive text-sm" role="alert">
        {{ actionError }}
      </p>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          :disabled="actionPending"
          @click="$emit('update:open', false)"
        >
          Keep running
        </Button>
        <Button
          type="button"
          variant="destructive"
          :disabled="actionPending"
          @click="$emit('confirm')"
        >
          {{ actionPending ? 'Cancelling…' : 'Cancel operation' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
