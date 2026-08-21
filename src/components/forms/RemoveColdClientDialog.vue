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
  appName: string
  removing: boolean
  error: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Remove ColdClient from {{ appName }}?</DialogTitle>
        <DialogDescription>
          The entire <code>_ColdClient</code> folder will be deleted, including
          generated settings and any custom files inside it. Game files outside
          that folder will remain on disk.
        </DialogDescription>
      </DialogHeader>

      <p v-if="error" class="text-destructive text-sm" role="alert">
        {{ error }}
      </p>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          :disabled="removing"
          @click="emit('update:open', false)"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          :disabled="removing"
          @click="emit('confirm')"
        >
          {{ removing ? 'Removing…' : 'Remove ColdClient' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
