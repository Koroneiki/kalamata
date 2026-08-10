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
        <DialogTitle>Remove {{ appName }} from the library?</DialogTitle>
        <DialogDescription>
          Kalamata's selections and installation records will be removed.
          Downloaded files will remain on disk.
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
          {{ removing ? 'Removing…' : 'Remove' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
