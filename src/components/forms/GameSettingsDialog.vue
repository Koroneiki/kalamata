<script setup lang="ts">
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
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  verify: []
}>()
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle class="text-primary">{{ appName }}</DialogTitle>
      </DialogHeader>

      <div class="border-border border-t pt-4">
        <Button
          type="button"
          size="sm"
          variant="outline"
          :disabled="verifyDisabled"
          @click="emit('verify')"
        >
          Verify game files
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
