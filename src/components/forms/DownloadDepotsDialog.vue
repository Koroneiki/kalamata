<script setup lang="ts">
import { FolderOpen, Lock } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import { selectInstallDirectory } from '@/api/install-directory'
import { useDownloadQueueStore } from '@/stores/download-queue'
import type { AppDepot, AppDetails } from '@/types/rpc'
import { formatBytes } from '@/utils/bytes'

import InstallPathValue from '@/components/shared/InstallPathValue.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'

const props = defineProps<{
  open: boolean
  app: AppDetails
  initialPath: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'download-started': []
}>()

const queue = useDownloadQueueStore()
const selectedPath = ref('')
const selectedDepotIds = ref<number[]>([])
const pathError = ref('')
const depotError = ref('')
const startError = ref('')
const choosingPath = ref(false)
const starting = ref(false)
const downloadStarted = ref(false)

const queueIdle = computed(() => queue.state.status !== 'running')
const canStart = computed(
  () =>
    Boolean(selectedPath.value) &&
    selectedDepotIds.value.length > 0 &&
    queueIdle.value &&
    !starting.value,
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selectedPath.value = props.app.installPath ?? props.initialPath
    selectedDepotIds.value = []
    pathError.value = ''
    depotError.value = ''
    startError.value = ''
    downloadStarted.value = false
  },
)

function unavailableReason(depot: AppDepot) {
  if (!depot.eligible) return 'Not eligible for download'
  if (depot.installStatus === 'current') return 'Already installed and current'
  if (depot.manifestStatus !== 'ready')
    return `Manifest ${depot.manifestStatus}`
  if (depot.keyStatus !== 'ready') return `Depot key ${depot.keyStatus}`
  return 'Unavailable'
}

function depotSizeEvidence(depot: AppDepot) {
  const download = depot.downloadBytes
    ? `Download size: ${formatBytes(depot.downloadBytes)}`
    : 'Download size unavailable from Steam'
  const installed = depot.sizeBytes
    ? `Installed size: ${formatBytes(depot.sizeBytes)}`
    : 'Installed size unavailable from Steam'
  return `${download} · ${installed}`
}

function handleCloseAutoFocus(event: Event) {
  if (!downloadStarted.value) return

  event.preventDefault()
  downloadStarted.value = false
  emit('download-started')
}

async function chooseDirectory() {
  choosingPath.value = true
  pathError.value = ''
  try {
    const path = await selectInstallDirectory(selectedPath.value || undefined)
    if (path) selectedPath.value = path
  } catch (error) {
    pathError.value = error instanceof Error ? error.message : String(error)
  } finally {
    choosingPath.value = false
  }
}

function updateDepot(depotId: number, checked: boolean | 'indeterminate') {
  if (checked === true) {
    if (!selectedDepotIds.value.includes(depotId)) {
      selectedDepotIds.value = [...selectedDepotIds.value, depotId]
    }
  } else {
    selectedDepotIds.value = selectedDepotIds.value.filter(
      (id) => id !== depotId,
    )
  }
  depotError.value = ''
}

async function submit() {
  pathError.value = selectedPath.value ? '' : 'Choose an install directory.'
  depotError.value = selectedDepotIds.value.length
    ? ''
    : 'Select at least one ready depot.'
  startError.value = ''
  if (!canStart.value) return

  starting.value = true
  try {
    await queue.startDownload({
      appId: props.app.appId,
      installPath: selectedPath.value,
      depotIds: selectedDepotIds.value,
    })
    downloadStarted.value = true
    emit('update:open', false)
  } catch (error) {
    startError.value = error instanceof Error ? error.message : String(error)
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-xl"
      @close-auto-focus="handleCloseAutoFocus"
    >
      <DialogHeader class="min-w-0">
        <DialogTitle>Download depots</DialogTitle>
        <DialogDescription
          >{{ app.name }} · App {{ app.appId }}</DialogDescription
        >
      </DialogHeader>

      <div class="min-w-0 space-y-2">
        <Label>Install directory</Label>
        <div
          class="bg-muted/40 flex min-w-0 flex-col items-stretch gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center"
        >
          <Lock
            v-if="app.installPath"
            class="text-muted-foreground size-4 shrink-0"
            aria-hidden="true"
          />
          <FolderOpen
            v-else
            class="text-muted-foreground size-4 shrink-0"
            aria-hidden="true"
          />
          <InstallPathValue
            v-if="selectedPath"
            class="min-w-0 flex-1"
            :path="selectedPath"
          />
          <span v-else class="text-muted-foreground min-w-0 flex-1 text-sm"
            >No directory selected</span
          >
          <Button
            v-if="!app.installPath"
            type="button"
            size="sm"
            variant="outline"
            :disabled="choosingPath"
            @click="chooseDirectory"
          >
            {{ choosingPath ? 'Choosing…' : 'Choose' }}
          </Button>
        </div>
        <p v-if="pathError" class="text-destructive text-xs" role="alert">
          {{ pathError }}
        </p>
        <p v-else-if="!selectedPath" class="text-muted-foreground text-xs">
          Choose a directory before starting the download.
        </p>
      </div>

      <div class="min-h-0 min-w-0 space-y-2">
        <div class="flex items-baseline justify-between gap-3">
          <Label>Select depots</Label>
          <span class="text-muted-foreground text-xs"
            >None selected by default</span
          >
        </div>
        <ScrollArea class="h-[min(19rem,42vh)] rounded-md border">
          <div class="divide-border divide-y">
            <label
              v-for="depot in app.depots"
              :key="depot.depotId"
              class="flex gap-3 px-3 py-3"
              :class="
                depot.selectable
                  ? 'hover:bg-muted/50 cursor-pointer'
                  : 'cursor-not-allowed opacity-65'
              "
            >
              <Checkbox
                class="mt-0.5"
                :model-value="selectedDepotIds.includes(depot.depotId)"
                :disabled="!depot.selectable"
                :aria-describedby="`depot-${depot.depotId}-status`"
                @update:model-value="updateDepot(depot.depotId, $event)"
              />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span class="font-medium tabular-nums"
                    >Depot {{ depot.depotId }}</span
                  >
                  <span class="text-muted-foreground text-xs">
                    Platform: {{ depot.platform || 'All platforms' }}
                  </span>
                  <span class="text-muted-foreground text-xs">
                    Language: {{ depot.language || 'All languages' }}
                  </span>
                </span>
                <span
                  :id="`depot-${depot.depotId}-status`"
                  class="text-muted-foreground mt-1 block text-xs"
                >
                  {{
                    depot.selectable
                      ? 'Ready to download'
                      : unavailableReason(depot)
                  }}
                </span>
                <span class="mt-1 block text-sm">
                  {{ depotSizeEvidence(depot) }}
                </span>
              </span>
            </label>
            <p
              v-if="app.depots.length === 0"
              class="text-muted-foreground p-4 text-sm"
            >
              No public depots are available.
            </p>
          </div>
        </ScrollArea>
        <p v-if="depotError" class="text-destructive text-xs" role="alert">
          {{ depotError }}
        </p>
        <p
          v-else-if="selectedDepotIds.length === 0"
          class="text-muted-foreground text-xs"
        >
          Select at least one ready depot to continue.
        </p>
        <p v-if="startError" class="text-destructive text-sm" role="alert">
          {{ startError }}
        </p>
      </div>

      <DialogFooter class="min-w-0">
        <Button
          type="button"
          variant="outline"
          @click="emit('update:open', false)"
          >Cancel</Button
        >
        <Button type="button" :disabled="!canStart" @click="submit">
          {{ starting ? 'Starting…' : 'Start download' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
