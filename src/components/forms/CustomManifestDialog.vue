<script setup lang="ts">
import { ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { manifestIdSchema } from '@/types/schemas'

const props = defineProps<{
  open: boolean
  removable?: boolean
  acquiring: boolean
  error: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: [manifestId: string]
  remove: []
}>()

const manifestId = ref('')
const validationError = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    manifestId.value = ''
    validationError.value = ''
  },
)

function submit() {
  const value = manifestId.value.trim()
  if (!manifestIdSchema.safeParse(value).success) {
    validationError.value = 'Enter a decimal manifest GID.'
    return
  }
  validationError.value = ''
  emit('confirm', value)
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent>
      <form novalidate @submit.prevent="submit">
        <DialogHeader>
          <DialogTitle>Use a custom manifest</DialogTitle>
        </DialogHeader>

        <div class="mt-5">
          <Label for="custom-manifest-gid">Manifest GID</Label>
          <Input
            id="custom-manifest-gid"
            v-model="manifestId"
            class="mt-2 font-mono tabular-nums"
            inputmode="numeric"
            autocomplete="off"
            :disabled="acquiring"
            :aria-invalid="Boolean(validationError || error)"
            :aria-describedby="
              validationError || error ? 'custom-manifest-error' : undefined
            "
            autofocus
          />
          <p
            v-if="validationError || error"
            id="custom-manifest-error"
            class="text-destructive mt-2 text-sm"
            role="alert"
          >
            {{ validationError || error }}
          </p>
        </div>

        <DialogFooter class="mt-5">
          <Button
            v-if="removable"
            class="sm:mr-auto"
            type="button"
            variant="ghost"
            :disabled="acquiring"
            @click="emit('remove')"
          >
            Unpin manifest
          </Button>
          <Button
            type="button"
            variant="outline"
            :disabled="acquiring"
            @click="emit('update:open', false)"
          >
            Cancel
          </Button>
          <Button type="submit" :disabled="acquiring">
            {{ acquiring ? 'Acquiring…' : 'Use manifest' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
