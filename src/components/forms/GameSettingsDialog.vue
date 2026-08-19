<script setup lang="ts">
import { RefreshCw, Settings2, Trash2, TriangleAlert } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ColdClientStatus } from '@/types/cold-client'

defineProps<{
  open: boolean
  appName: string
  verifyDisabled: boolean
  removeDisabled: boolean
  coldClientStatus?: ColdClientStatus
  coldClientReady: boolean
  coldClientDisabled: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  verify: []
  remove: []
  setupColdClient: []
  regenerateColdClient: []
  updateColdClientCore: []
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

      <section
        v-if="coldClientStatus?.status !== 'unsupported'"
        class="border-border border-t pt-4"
      >
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-medium">ColdClient</h3>
          <span
            v-if="coldClientStatus?.status === 'configured'"
            class="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs font-medium"
          >
            Configured
          </span>
          <span
            v-else-if="coldClientStatus?.status === 'invalid'"
            class="text-destructive inline-flex items-center gap-1 text-xs font-medium"
          >
            <TriangleAlert class="size-3.5" aria-hidden="true" />
            Repair required
          </span>
        </div>
        <p
          v-if="coldClientStatus?.status === 'configured'"
          class="text-muted-foreground mt-1 text-sm"
        >
          GBE {{ coldClientStatus.installedGbeTag }} · GSE Tools
          {{ coldClientStatus.installedGseTag }}
        </p>
        <div
          v-if="
            coldClientStatus?.status === 'configured' &&
            coldClientStatus.recommendationReasons.length
          "
          class="bg-muted mt-3 rounded-md p-3 text-sm"
        >
          <p class="font-medium">Regeneration recommended</p>
          <p class="text-muted-foreground mt-1">
            {{
              coldClientStatus.recommendationReasons
                .map((reason) =>
                  reason === 'depots-changed'
                    ? 'Installed depots changed'
                    : 'GSE Tools was updated',
                )
                .join(' · ')
            }}
          </p>
        </div>
        <p
          v-else-if="coldClientStatus?.status === 'invalid'"
          class="text-destructive mt-1 text-sm"
        >
          {{ coldClientStatus.message }} Run setup again to replace it safely.
        </p>
        <p class="text-muted-foreground mt-1 text-sm">
          {{
            coldClientStatus?.status === 'configured'
              ? 'The installed loader and generated settings are ready.'
              : coldClientReady
                ? 'Review the detected executable, Steam API DLL, and launch arguments before setup.'
                : 'Install dependencies and add the GSE Tools login file in Settings before setup.'
          }}
        </p>
        <Button
          v-if="coldClientStatus?.status !== 'configured'"
          type="button"
          size="sm"
          class="mt-3"
          :disabled="coldClientDisabled"
          @click="emit('setupColdClient')"
        >
          <Settings2 aria-hidden="true" />
          {{
            coldClientReady
              ? coldClientStatus?.status === 'invalid'
                ? 'Repair ColdClient'
                : 'Set up ColdClient'
              : 'Open ColdClient settings'
          }}
        </Button>
        <div v-else class="mt-3">
          <div
            v-if="coldClientStatus.coreUpdateAvailable"
            class="bg-muted mb-3 rounded-md p-3"
          >
            <p class="text-sm font-medium">
              GBE {{ coldClientStatus.availableGbeTag }} is ready to install.
            </p>
            <p class="text-muted-foreground mt-1 text-sm">
              Updating replaces managed core files. Loader configuration,
              generated settings, and custom files are preserved.
            </p>
            <Button
              type="button"
              size="sm"
              class="mt-3"
              :disabled="coldClientDisabled"
              @click="emit('updateColdClientCore')"
            >
              <RefreshCw aria-hidden="true" />
              Update ColdClient
            </Button>
          </div>
          <p class="text-sm">
            Regeneration replaces every file in
            <code>steam_settings</code>, including user edits. Loader and core
            files are preserved.
          </p>
          <Button
            type="button"
            size="sm"
            class="mt-3"
            :disabled="coldClientDisabled"
            @click="emit('regenerateColdClient')"
          >
            <RefreshCw aria-hidden="true" />
            Regenerate configuration
          </Button>
        </div>
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
