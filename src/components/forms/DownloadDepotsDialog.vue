<script setup lang="ts">
import { FolderOpen, Lock } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import { selectInstallDirectory } from '@/api/install-directory'
import DepotBadges from '@/components/shared/DepotBadges.vue'
import DepotSummary from '@/components/shared/DepotSummary.vue'
import { useDownloadQueueStore } from '@/stores/download-queue'
import type { AppDetails } from '@/types/rpc'
import { formatBytes } from '@/utils/bytes'
import {
  depotsInGroup,
  installableDepotGroups,
  installableDepots,
  summarizeDepots,
} from '@/utils/depots'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{
  open: boolean
  app: AppDetails
  initialPath: string
  selectedDepotIds: number[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'download-started': []
}>()

const queue = useDownloadQueueStore()
const selectedPath = ref('')
const pathError = ref('')
const startError = ref('')
const choosingPath = ref(false)
const starting = ref(false)
const downloadStarted = ref(false)

const selectedIds = computed(() => new Set(props.selectedDepotIds))
const selectableDepots = computed(() =>
  installableDepots(props.app.depots).filter((depot) => depot.selectable),
)
const selectedDepots = computed(() =>
  selectableDepots.value.filter((depot) =>
    selectedIds.value.has(depot.depotId),
  ),
)
const depotSummary = computed(() =>
  summarizeDepots(selectableDepots.value, selectedIds.value),
)
const depotGroups = computed(() =>
  installableDepotGroups.flatMap((name) => {
    const allDepots = depotsInGroup(props.app.depots, name).filter(
      (depot) => depot.selectable,
    )
    const depots = allDepots.filter((depot) =>
      selectedIds.value.has(depot.depotId),
    )
    if (!depots.length) return []
    return [
      {
        name,
        depots,
        summary: summarizeDepots(allDepots, selectedIds.value),
      },
    ]
  }),
)
const canStart = computed(
  () =>
    Boolean(selectedPath.value) &&
    selectedDepots.value.length > 0 &&
    queue.state.status !== 'running' &&
    !starting.value,
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selectedPath.value = props.app.installPath ?? props.initialPath
    pathError.value = ''
    startError.value = ''
    downloadStarted.value = false
  },
)

function formattedBytes(value: string | null) {
  return value ? formatBytes(value) : 'Unavailable'
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

async function submit() {
  pathError.value = selectedPath.value ? '' : 'Choose an install directory.'
  startError.value = ''
  if (!canStart.value) return

  starting.value = true
  try {
    await queue.startDownload({
      appId: props.app.appId,
      installPath: selectedPath.value,
      depotIds: selectedDepots.value.map((depot) => depot.depotId),
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
      class="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl"
      @close-auto-focus="handleCloseAutoFocus"
    >
      <DialogHeader class="min-w-0">
        <DialogTitle>Install {{ app.name }}</DialogTitle>
        <DialogDescription class="sr-only">
          Review selected depots and choose an install directory.
        </DialogDescription>
      </DialogHeader>

      <section class="min-w-0 space-y-2" aria-labelledby="install-path-title">
        <h3 id="install-path-title" class="text-sm font-medium">
          Install directory
        </h3>
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
          <span
            v-if="selectedPath"
            class="min-w-0 flex-1 truncate font-mono text-xs"
            :aria-label="`Install path: ${selectedPath}`"
          >
            {{ selectedPath }}
          </span>
          <span v-else class="text-muted-foreground min-w-0 flex-1 text-sm">
            No directory selected
          </span>
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
      </section>

      <section class="min-w-0" aria-labelledby="selected-depots-title">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <h3 id="selected-depots-title" class="text-sm font-medium">Depots</h3>
          <DepotSummary :summary="depotSummary" :show-missing="false" />
        </header>

        <Accordion type="multiple" class="mt-2 space-y-2">
          <AccordionItem
            v-for="group in depotGroups"
            :key="group.name"
            :value="group.name"
            class="border-border overflow-hidden rounded-lg border last:border-b"
          >
            <AccordionTrigger
              class="hover:bg-accent/50 rounded-none px-3 py-2.5 hover:no-underline"
            >
              <span
                class="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 pr-2"
              >
                <span>{{ group.name }}</span>
                <DepotSummary :summary="group.summary" />
              </span>
            </AccordionTrigger>
            <AccordionContent class="pb-0">
              <ul :aria-label="`Selected ${group.name} depots`">
                <li
                  v-for="depot in group.depots"
                  :key="depot.depotId"
                  class="border-border border-t px-3 py-3"
                >
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <p class="font-medium tabular-nums">
                      <span class="text-muted-foreground">ID</span>
                      {{ depot.depotId }}
                    </p>
                    <DepotBadges :depot="depot" />
                  </div>
                  <dl class="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt class="text-muted-foreground">Download Size</dt>
                      <dd class="mt-1 font-medium tabular-nums">
                        {{ formattedBytes(depot.downloadBytes) }}
                      </dd>
                    </div>
                    <div>
                      <dt class="text-muted-foreground">Size on Disk</dt>
                      <dd class="mt-1 font-medium tabular-nums">
                        {{ formattedBytes(depot.sizeBytes) }}
                      </dd>
                    </div>
                  </dl>
                </li>
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>

      <p v-if="startError" class="text-destructive text-sm" role="alert">
        {{ startError }}
      </p>

      <DialogFooter class="min-w-0">
        <Button
          type="button"
          variant="outline"
          @click="emit('update:open', false)"
        >
          Cancel
        </Button>
        <Button type="button" :disabled="!canStart" @click="submit">
          {{ starting ? 'Installing…' : 'Install' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
