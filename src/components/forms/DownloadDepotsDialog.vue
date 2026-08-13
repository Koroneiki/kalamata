<script setup lang="ts">
import {
  Download,
  FolderOpen,
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
import { useOperationStore } from '@/stores/operation'
import type {
  AppDetails,
  ApplicationOperationPreview,
  EligibleAppDepot,
} from '@/types/rpc'
import { formatBytes } from '@/utils/bytes'

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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

const props = defineProps<{
  open: boolean
  app: AppDetails
  initialPath: string
  selectedDepotIds: number[]
  customManifestTargets: ReadonlyMap<number, string>
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
const acceptedPreviewKey = ref('')
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
const manifestTargets = computed(() =>
  [...props.customManifestTargets]
    .filter(([depotId]) => props.selectedDepotIds.includes(depotId))
    .map(([depotId, manifestId]) => ({
      depotId,
      manifestId,
    })),
)
const changeRows = computed(() =>
  displayedActions.value.map((item) => ({
    ...item,
    depot: visibleDepots.value.get(item.depotId),
  })),
)
const isFirstInstall = computed(
  () =>
    !props.app.depots.some(
      (depot) => depot.eligible && depot.installStatus !== 'not-installed',
    ),
)
const confirmationLabel = computed(() => {
  if (isFirstInstall.value) return 'Install'
  return props.selectedDepotIds.length === 0 ? 'Uninstall' : 'Update'
})
const currentPreviewKey = computed(() =>
  JSON.stringify({
    appId: props.app.appId,
    firstInstall: isFirstInstall.value,
    desiredDepotIds: props.selectedDepotIds,
    manifestTargets: [...manifestTargets.value].sort(
      (left, right) => left.depotId - right.depotId,
    ),
    installPath: isFirstInstall.value ? selectedPath.value : null,
  }),
)
const hasPlannedChanges = computed(() => {
  if (!preview.value) return false
  return (
    preview.value.depots.length > 0 ||
    preview.value.logicalSizeDeltaBytes !== '0' ||
    preview.value.estimatedDownloadBytes !== '0' ||
    preview.value.stagingLogicalUpperBoundBytes !== '0'
  )
})
const canStart = computed(
  () =>
    Boolean(selectedPath.value) &&
    preview.value !== null &&
    acceptedPreviewKey.value === currentPreviewKey.value &&
    hasPlannedChanges.value &&
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
  () => props.open,
  (open) => {
    if (!open) {
      ++previewRequest
      acceptedPreviewKey.value = ''
      preview.value = null
      previewLoading.value = false
      return
    }
    selectedPath.value = props.app.installPath ?? props.initialPath
    pathError.value = ''
    startError.value = ''
    previewError.value = ''
    downloadStarted.value = false
  },
)

// The selected directory affects reusable content and therefore the estimate.
watch(
  [
    () => props.open,
    () => props.selectedDepotIds,
    manifestTargets,
    selectedPath,
  ],
  ([open]) => {
    if (!open) return
    void requestPreview()
  },
  { deep: true },
)

async function requestPreview() {
  // Selection changes can race planning; only the latest response is usable.
  const request = ++previewRequest
  const requestKey = currentPreviewKey.value
  const desiredDepotIds = [...props.selectedDepotIds]
  const requestedManifestTargets = manifestTargets.value.map((target) => ({
    ...target,
  }))
  const installPath = isFirstInstall.value
    ? selectedPath.value || undefined
    : undefined
  previewLoading.value = true
  preview.value = null
  acceptedPreviewKey.value = ''
  previewError.value = ''
  try {
    const result = await previewApplicationOperation({
      appId: props.app.appId,
      desiredDepotIds,
      manifestTargets: requestedManifestTargets,
      installPath,
    })
    if (request === previewRequest && requestKey === currentPreviewKey.value) {
      preview.value = result
      acceptedPreviewKey.value = requestKey
    }
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

function formattedDepotSizeDelta(current: string, target: string) {
  return formattedSignedBytes((BigInt(target) - BigInt(current)).toString())
}

function actionLabel(
  action: ApplicationOperationPreview['depots'][number]['action'],
) {
  return action[0].toUpperCase() + action.slice(1)
}

function depotCountSummary(value: ApplicationOperationPreview) {
  const parts = [
    [value.counts.install, 'install'],
    [value.counts.update, 'update'],
    [value.counts.remove, 'removal'],
  ] as const
  return parts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`)
    .join(' · ')
}

function handleOpenChange(value: boolean) {
  if (!value && starting.value) return
  emit('update:open', value)
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
        manifestTargets: manifestTargets.value,
      })
    } else {
      await operation.reconcile({
        appId: props.app.appId,
        desiredDepotIds: props.selectedDepotIds,
        manifestTargets: manifestTargets.value,
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
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl"
      :show-close-button="!starting"
      @close-auto-focus="handleCloseAutoFocus"
    >
      <DialogHeader class="min-w-0 border-b px-5 py-4 pr-12 sm:px-6">
        <DialogTitle>{{ confirmationLabel }} {{ app.name }}</DialogTitle>
      </DialogHeader>

      <div class="min-w-0 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
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
        </section>

        <section class="min-w-0" aria-labelledby="resource-plan-title">
          <h3 id="resource-plan-title" class="text-sm font-medium">
            Resource plan
          </h3>
          <div
            v-if="previewLoading"
            class="bg-muted/40 mt-2 grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2"
            role="status"
          >
            <div v-for="index in 2" :key="index" class="bg-background p-4">
              <Skeleton class="h-4 w-24" />
              <Skeleton class="mt-3 h-7 w-32" />
              <Skeleton class="mt-2 h-3 w-40 max-w-full" />
            </div>
            <span class="sr-only">Calculating operation requirements.</span>
          </div>
          <div
            v-else-if="preview"
            class="bg-muted/40 mt-2 grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2"
          >
            <div class="bg-background p-4">
              <p
                class="text-muted-foreground flex items-center gap-2 text-xs font-medium"
              >
                <Download class="size-4" aria-hidden="true" /> Estimated
                download
              </p>
              <p class="mt-1 text-xl font-semibold tabular-nums">
                {{ formatBytes(preview.estimatedDownloadBytes) }}
              </p>
              <p class="text-muted-foreground mt-1 text-xs">
                Up to
                {{ formattedBytes(preview.networkPayloadUpperBoundBytes) }}
                before reusing local content
              </p>
            </div>
            <div class="bg-background p-4">
              <p
                class="text-muted-foreground flex items-center gap-2 text-xs font-medium"
              >
                <Layers3 class="size-4" aria-hidden="true" /> Temporary space
              </p>
              <p class="mt-1 text-xl font-semibold tabular-nums">
                Up to {{ formatBytes(preview.stagingLogicalUpperBoundBytes) }}
              </p>
              <p class="text-muted-foreground mt-1 text-xs">
                Final installation
                {{ formattedSignedBytes(preview.logicalSizeDeltaBytes) }}
              </p>
            </div>
          </div>
        </section>

        <section class="min-w-0" aria-labelledby="selected-depots-title">
          <header class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="selected-depots-title" class="text-sm font-medium">
              Depot changes
            </h3>
            <p
              v-if="preview && changeRows.length"
              class="text-muted-foreground text-xs tabular-nums"
            >
              {{ depotCountSummary(preview) }}
            </p>
          </header>

          <Accordion
            v-if="changeRows.length"
            type="multiple"
            class="mt-2 overflow-hidden rounded-lg border"
          >
            <AccordionItem
              v-for="item in changeRows"
              :key="item.depotId"
              :value="String(item.depotId)"
              class="last:border-b-0"
            >
              <AccordionTrigger
                class="hover:bg-accent/50 rounded-none px-3 py-3 hover:no-underline"
              >
                <span
                  class="flex min-w-0 flex-1 flex-wrap items-center gap-3 pr-2"
                >
                  <Badge
                    variant="outline"
                    :class="{
                      'border-primary/40 bg-primary/15 text-primary dark:border-ring/50 dark:bg-ring/15 dark:text-ring':
                        item.action === 'install',
                      'border-destructive/40 bg-destructive/10 text-destructive':
                        item.action === 'remove',
                      'border-info/40 bg-info/10 text-info':
                        item.action === 'update',
                    }"
                  >
                    <Plus
                      v-if="item.action === 'install'"
                      class="size-3"
                      aria-hidden="true"
                    />
                    <Minus
                      v-else-if="item.action === 'remove'"
                      class="size-3"
                      aria-hidden="true"
                    />
                    <RefreshCw v-else class="size-3" aria-hidden="true" />
                    {{ actionLabel(item.action) }}
                  </Badge>
                  <span class="font-medium tabular-nums">
                    <span class="text-muted-foreground font-normal">Depot</span>
                    {{ item.depotId }}
                  </span>
                  <DepotBadges
                    v-if="item.depot"
                    class="ml-auto"
                    :depot="item.depot"
                  />
                </span>
              </AccordionTrigger>
              <AccordionContent class="border-t px-3 pb-3">
                <dl class="grid gap-3 pt-3 text-xs sm:grid-cols-2">
                  <div class="min-w-0 sm:col-span-2">
                    <dt class="text-muted-foreground">
                      {{
                        item.action === 'update'
                          ? 'Manifest change'
                          : 'Manifest'
                      }}
                    </dt>
                    <dd
                      class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono break-all tabular-nums"
                    >
                      <span v-if="item.currentManifestId">{{
                        item.currentManifestId
                      }}</span>
                      <span
                        v-if="item.action === 'update'"
                        class="text-muted-foreground"
                        aria-hidden="true"
                        >→</span
                      >
                      <span v-if="item.targetManifestId">{{
                        item.targetManifestId
                      }}</span>
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Target download size</dt>
                    <dd class="mt-1 font-medium tabular-nums">
                      {{ formatBytes(item.targetDownloadBytes) }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Size on disk</dt>
                    <dd
                      class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-medium tabular-nums"
                    >
                      <span v-if="item.action !== 'install'">
                        {{ formatBytes(item.currentSizeBytes) }}
                      </span>
                      <span
                        v-if="item.action !== 'install'"
                        class="text-muted-foreground"
                        aria-hidden="true"
                        >→</span
                      >
                      <span>{{ formatBytes(item.targetSizeBytes) }}</span>
                      <span
                        v-if="item.action !== 'install'"
                        class="text-muted-foreground font-normal"
                      >
                        ({{
                          formattedDepotSizeDelta(
                            item.currentSizeBytes,
                            item.targetSizeBytes,
                          )
                        }})
                      </span>
                    </dd>
                  </div>
                </dl>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <p
            v-if="preview && !hasPlannedChanges"
            class="bg-muted/40 mt-2 rounded-lg border px-4 py-5 text-sm"
            role="status"
          >
            Everything is already up to date. No operation is needed.
          </p>
        </section>

        <div
          v-if="previewError"
          class="border-destructive/30 bg-destructive/5 rounded-lg border p-4"
          role="alert"
        >
          <p class="text-destructive text-sm font-medium">
            Couldn’t calculate changes
          </p>
          <p class="text-muted-foreground mt-1 text-sm">{{ previewError }}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            class="mt-3"
            @click="requestPreview"
          >
            Retry
          </Button>
        </div>
        <p v-if="startError" class="text-destructive text-sm" role="alert">
          {{ startError }}
        </p>
      </div>
      <DialogFooter class="bg-background min-w-0 border-t px-5 py-4 sm:px-6">
        <Button
          type="button"
          variant="outline"
          :disabled="starting"
          @click="handleOpenChange(false)"
          >{{ preview && !hasPlannedChanges ? 'Close' : 'Cancel' }}</Button
        >
        <Button
          v-if="!preview || hasPlannedChanges"
          type="button"
          :disabled="!canStart"
          @click="submit"
        >
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
