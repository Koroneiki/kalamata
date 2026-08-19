<script setup lang="ts">
import { Settings2, Trash2 } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

defineProps<{
  open: boolean
  appName: string
  verifyDisabled: boolean
  removeDisabled: boolean
  coldClientSupported: boolean
  coldClientReady: boolean
  coldClientDisabled: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  verify: []
  remove: []
  setupColdClient: []
}>()
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle class="text-primary">{{ appName }}</DialogTitle>
        <DialogDescription>
          Manage installed game files and optional ColdClient setup.
        </DialogDescription>
      </DialogHeader>

      <section v-if="coldClientSupported" class="border-border border-t pt-4">
        <h3 class="text-sm font-medium">ColdClient</h3>
        <p class="text-muted-foreground mt-1 text-sm">
          {{
            coldClientReady
              ? 'Review the detected executable, Steam API DLL, and launch arguments before setup.'
              : 'Install dependencies and add the GSE Tools login file in Settings before setup.'
          }}
        </p>
        <Button
          type="button"
          size="sm"
          class="mt-3"
          :disabled="coldClientDisabled"
          @click="emit('setupColdClient')"
        >
          <Settings2 aria-hidden="true" />
          {{
            coldClientReady ? 'Set up ColdClient' : 'Open ColdClient settings'
          }}
        </Button>
      </section>

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
