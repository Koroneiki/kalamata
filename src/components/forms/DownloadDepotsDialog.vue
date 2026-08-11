<script setup lang="ts">
import {
  Download,
  FolderOpen,
  HardDrive,
  Layers3,
  Lock,
  Minus,
  Plus,
  RefreshCw,
} from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import { selectInstallDirectory } from '@/api/install-directory'
import { previewApplicationOperation } from '@/api/operations'
import DepotBadges from '@/components/shared/DepotBadges.vue'
import DepotSummary from '@/components/shared/DepotSummary.vue'
import { useOperationStore } from '@/stores/operation'
import type {
  AppDetails,
  ApplicationOperationPreview,
  EligibleAppDepot,
} from '@/types/rpc'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

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

const operation = useOperationStore()
const selectedPath = ref('')
const pathError = ref('')
const startError = ref('')
const previewError = ref('')
const choosingPath = ref(false)
const starting = ref(false)
const downloadStarted = ref(false)
const previewLoading = ref(false)
const preview = ref<ApplicationOperationPreview | null>(null)
let previewRequest = 0

const visibleDepots = computed(
  () =>
    new Map(
      props.app.depots
        .filter((depot): depot is EligibleAppDepot => depot.eligible)
        .map((depot) => [depot.depotId, depot]),
    ),
)
const displayedActions = computed(() => preview.value?.depots ?? [])
const actionByDepotId = computed(
  () => new Map(displayedActions.value.map((item) => [item.depotId, item])),
)
const touchedIds = computed(() => new Set(actionByDepotId.value.keys()))
const touchedDepots = computed(() =>
  installableDepots(props.app.depots).filter((depot) =>
    touchedIds.value.has(depot.depotId),
  ),
)
const depotSummary = computed(() =>
  summarizeDepots(installableDepots(props.app.depots), touchedIds.value),
)
const depotGroups = computed(() =>
  installableDepotGroups.flatMap((name) => {
    const allDepots = depotsInGroup(props.app.depots, name)
    const depots = allDepots.filter((depot) =>
      touchedIds.value.has(depot.depotId),
    )
    return depots.length
      ? [
          {
            name,
            depots,
            summary: summarizeDepots(allDepots, touchedIds.value),
          },
        ]
      : []
  }),
)
const unrepresentedActions = computed(() =>
  displayedActions.value.filter(
    (item) => !visibleDepots.value.has(item.depotId),
  ),
)
const isFirstInstall = computed(() => !props.app.installPath)
const confirmationLabel = computed(() => {
  if (isFirstInstall.value) return 'Install'
  return props.selectedDepotIds.length === 0 ? 'Uninstall' : 'Update'
})
const canStart = computed(
  () =>
    Boolean(selectedPath.value) &&
    preview.value !== null &&
    !previewLoading.value &&
    !previewError.value &&
    (!isFirstInstall.value || props.selectedDepotIds.length > 0) &&
    !['active', 'paused', 'resumable'].includes(operation.state.status) &&
    !(
      operation.state.status === 'repair-required' &&
      operation.state.appId === props.app.appId
    ) &&
    !starting.value,
)

watch(
  [() => props.open, () => props.selectedDepotIds],
  ([open]) => {
    if (!open) return
    void requestPreview()
  },
  { deep: true },
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selectedPath.value = props.app.installPath ?? props.initialPath
    pathError.value = ''
    startError.value = ''
    previewError.value = ''
    downloadStarted.value = false
  },
)

async function requestPreview() {
  // Selection changes can race planning; only the latest response is usable.
  const request = ++previewRequest
  previewLoading.value = true
  preview.value = null
  previewError.value = ''
  try {
    const result = await previewApplicationOperation({
      appId: props.app.appId,
      desiredDepotIds: props.selectedDepotIds,
    })
    if (request === previewRequest) preview.value = result
  } catch (error) {
    if (request === previewRequest) {
      preview.value = null
      previewError.value =
        error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (request === previewRequest) previewLoading.value = false
  }
}

function formattedSignedBytes(value: string) {
  const bytes = BigInt(value)
  if (bytes === 0n) return formatBytes('0')
  return `${bytes > 0n ? '+' : '−'}${formatBytes((bytes < 0n ? -bytes : bytes).toString())}`
}

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
    if (isFirstInstall.value) {
      await operation.install({
        appId: props.app.appId,
        installPath: selectedPath.value,
        depotIds: props.selectedDepotIds,
      })
    } else {
      await operation.reconcile({
        appId: props.app.appId,
        desiredDepotIds: props.selectedDepotIds,
      })
    }
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
        <DialogTitle>{{ confirmationLabel }} {{ app.name }}</DialogTitle>
        <DialogDescription class="sr-only">
          Review changed depots and the operation size before confirming.
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
            >{{ selectedPath }}</span
          >
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

        <div
          class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-xs tabular-nums"
          aria-label="Operation preview summary"
        >
          <template v-if="previewLoading">
            <Skeleton v-for="index in 6" :key="index" class="h-5 w-12" />
          </template>
          <template v-else-if="preview">
            <Tooltip>
              <TooltipTrigger as-child
                ><span
                  class="text-primary flex items-center gap-1 font-semibold"
                  :aria-label="`${preview.counts.install} depots to install`"
                  ><Plus class="size-5 stroke-[2.5]" />{{
                    preview.counts.install
                  }}</span
                ></TooltipTrigger
              >
              <TooltipContent>Depots to install</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child
                ><span
                  class="text-destructive flex items-center gap-1 font-semibold"
                  :aria-label="`${preview.counts.remove} depots to remove`"
                  ><Minus class="size-5 stroke-[2.5]" />{{
                    preview.counts.remove
                  }}</span
                ></TooltipTrigger
              >
              <TooltipContent>Depots to remove</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child
                ><span
                  class="text-info flex items-center gap-1 font-semibold"
                  :aria-label="`${preview.counts.update} depots to update`"
                  ><RefreshCw class="size-5 stroke-[2.5]" />{{
                    preview.counts.update
                  }}</span
                ></TooltipTrigger
              >
              <TooltipContent>Depots to update</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child
                ><span
                  class="text-primary flex items-center gap-1 font-semibold"
                  :aria-label="`Logical size change ${formattedSignedBytes(preview.logicalSizeDeltaBytes)}`"
                  ><HardDrive class="size-5 stroke-[2.5]" />{{
                    formattedSignedBytes(preview.logicalSizeDeltaBytes)
                  }}</span
                ></TooltipTrigger
              >
              <TooltipContent>Signed logical size change</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child
                ><span
                  class="flex items-center gap-1"
                  :aria-label="`Network payload upper bound ${preview.networkPayloadUpperBoundBytes === null ? 'unavailable' : formatBytes(preview.networkPayloadUpperBoundBytes)}`"
                  ><Download class="size-4" />{{
                    preview.networkPayloadUpperBoundBytes === null
                      ? '—'
                      : formatBytes(preview.networkPayloadUpperBoundBytes)
                  }}</span
                ></TooltipTrigger
              >
              <TooltipContent>Network payload upper bound</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child
                ><span
                  class="text-primary flex items-center gap-1 font-semibold"
                  :aria-label="`Maximum temporary disk space ${formatBytes(preview.stagingLogicalUpperBoundBytes)}`"
                  ><Layers3 class="size-5 stroke-[2.5]" />{{
                    formatBytes(preview.stagingLogicalUpperBoundBytes)
                  }}</span
                ></TooltipTrigger
              >
              <TooltipContent>Maximum temporary disk space</TooltipContent>
            </Tooltip>
          </template>
        </div>
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
                    <p class="flex items-center gap-2 font-medium tabular-nums">
                      <span>
                        <span class="text-muted-foreground">ID</span>
                        {{ depot.depotId }}
                      </span>
                      <Badge
                        variant="outline"
                        class="size-5 p-0"
                        :class="{
                          'border-primary/40 bg-primary/15 text-primary':
                            actionByDepotId.get(depot.depotId)?.action ===
                            'install',
                          'border-destructive/40 bg-destructive/10 text-destructive':
                            actionByDepotId.get(depot.depotId)?.action ===
                            'remove',
                          'border-info/40 bg-info/10 text-info':
                            actionByDepotId.get(depot.depotId)?.action ===
                            'update',
                        }"
                        :aria-label="`${actionByDepotId.get(depot.depotId)?.action} depot ${depot.depotId}`"
                      >
                        <Plus
                          v-if="
                            actionByDepotId.get(depot.depotId)?.action ===
                            'install'
                          "
                          class="size-3.5 stroke-[2.5]"
                          aria-hidden="true"
                        />
                        <Minus
                          v-else-if="
                            actionByDepotId.get(depot.depotId)?.action ===
                            'remove'
                          "
                          class="size-3.5 stroke-[2.5]"
                          aria-hidden="true"
                        />
                        <RefreshCw
                          v-else
                          class="size-3.5 stroke-[2.5]"
                          aria-hidden="true"
                        />
                      </Badge>
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

        <ul
          v-if="unrepresentedActions.length"
          class="border-border mt-2 overflow-hidden rounded-lg border"
          aria-label="Unavailable touched depots"
        >
          <li
            v-for="item in unrepresentedActions"
            :key="item.depotId"
            class="border-border flex items-center gap-2 border-b px-3 py-3 font-medium tabular-nums last:border-b-0"
          >
            <span class="text-muted-foreground">ID</span> {{ item.depotId }}
            <Badge
              variant="outline"
              class="size-5 p-0"
              :aria-label="`${item.action} depot ${item.depotId}`"
            >
              <Minus
                v-if="item.action === 'remove'"
                class="text-destructive size-3.5 stroke-[2.5]"
                aria-hidden="true"
              />
              <RefreshCw
                v-else-if="item.action === 'update'"
                class="text-info size-3.5 stroke-[2.5]"
                aria-hidden="true"
              />
              <Plus
                v-else
                class="text-primary size-3.5 stroke-[2.5]"
                aria-hidden="true"
              />
            </Badge>
          </li>
        </ul>

        <p
          v-if="
            !previewLoading &&
            !previewError &&
            !touchedDepots.length &&
            !unrepresentedActions.length
          "
          class="text-muted-foreground mt-2 text-sm"
        >
          No depot changes.
        </p>
      </section>

      <p v-if="previewError" class="text-destructive text-sm" role="alert">
        {{ previewError }}
      </p>
      <p v-if="startError" class="text-destructive text-sm" role="alert">
        {{ startError }}
      </p>

      <DialogFooter class="min-w-0">
        <Button
          type="button"
          variant="outline"
          @click="emit('update:open', false)"
          >Cancel</Button
        >
        <Button type="button" :disabled="!canStart" @click="submit">
          {{
            starting
              ? `${confirmationLabel === 'Uninstall' ? 'Uninstalling' : confirmationLabel === 'Update' ? 'Updating' : 'Installing'}…`
              : confirmationLabel
          }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
