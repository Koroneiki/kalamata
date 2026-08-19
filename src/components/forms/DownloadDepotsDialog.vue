<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { selectInstallDirectory } from '@/api/install-directory'
import { previewApplicationOperation } from '@/api/operations'
import DownloadDepotChanges from '@/components/forms/DownloadDepotChanges.vue'
import DownloadDialogErrors from '@/components/forms/DownloadDialogErrors.vue'
import DownloadDialogFooter from '@/components/forms/DownloadDialogFooter.vue'
import DownloadInstallDirectorySection from '@/components/forms/DownloadInstallDirectorySection.vue'
import DownloadResourcePlan from '@/components/forms/DownloadResourcePlan.vue'
import { useOperationStore } from '@/stores/operation'
import type {
  AppDetails,
  ApplicationOperationPreview,
  EligibleAppDepot,
} from '@/types/rpc'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = withDefaults(
  defineProps<{
    open: boolean
    app: AppDetails
    initialPath: string
    selectedDepotIds: number[]
    customManifestTargets: ReadonlyMap<number, string>
    priority?: boolean
  }>(),
  { priority: false },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:selectedDepotIds': [value: number[]]
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
const pendingPreviewKey = ref('')
let previewRequest = 0

const visibleDepots = computed(
  () =>
    new Map(
      props.app.depots
        .filter((depot): depot is EligibleAppDepot => depot.eligible)
        .map((depot) => [depot.depotId, depot]),
    ),
)
const manifestTargets = computed(() =>
  [...props.customManifestTargets]
    .filter(([depotId]) => props.selectedDepotIds.includes(depotId))
    .map(([depotId, manifestId]) => ({
      depotId,
      manifestId,
    })),
)
const isFirstInstall = computed(() => props.app.installedDepotIds.length === 0)
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
    !operation.isAppInDownloads(props.app.appId) &&
    !starting.value,
)

watch(
  () => props.open,
  (open) => {
    if (!open) {
      ++previewRequest
      acceptedPreviewKey.value = ''
      pendingPreviewKey.value = ''
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
  { immediate: true },
)

watch(
  [() => props.open, () => props.selectedDepotIds, manifestTargets],
  ([open]) => {
    if (!open) return
    if (
      currentPreviewKey.value === acceptedPreviewKey.value ||
      currentPreviewKey.value === pendingPreviewKey.value
    )
      return
    void requestPreview()
  },
  { deep: true, immediate: true },
)

async function requestPreview() {
  // Selection changes can race planning; only the latest response is usable.
  const request = ++previewRequest
  const requestKey = currentPreviewKey.value
  const desiredDepotIds = [...props.selectedDepotIds]
  const requestedManifestTargets = [...manifestTargets.value]
  previewLoading.value = true
  pendingPreviewKey.value = requestKey
  preview.value = null
  acceptedPreviewKey.value = ''
  previewError.value = ''
  try {
    const result = await previewApplicationOperation({
      appId: props.app.appId,
      desiredDepotIds,
      manifestTargets: requestedManifestTargets,
    })
    if (request === previewRequest && requestKey === currentPreviewKey.value) {
      const fullyOverridden = new Set(
        result.overlaps
          .filter(({ complete }) => complete)
          .map(({ depotId }) => depotId),
      )
      if (fullyOverridden.size) {
        // The corrected selection immediately triggers its own preview request.
        emit(
          'update:selectedDepotIds',
          desiredDepotIds.filter((depotId) => !fullyOverridden.has(depotId)),
        )
        return
      }
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
    if (pendingPreviewKey.value === requestKey) pendingPreviewKey.value = ''
    if (request === previewRequest) previewLoading.value = false
  }
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
        priority: props.priority,
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
        <DownloadInstallDirectorySection
          :install-path="app.installPath"
          :selected-path="selectedPath"
          :choosing-path="choosingPath"
          :path-error="pathError"
          @choose="chooseDirectory"
        />

        <DownloadResourcePlan
          :preview="preview"
          :loading="previewLoading"
          :confirmation-label="confirmationLabel"
        />

        <DownloadDepotChanges
          :preview="preview"
          :visible-depots="visibleDepots"
          :has-planned-changes="hasPlannedChanges"
        />

        <DownloadDialogErrors
          :preview-error="previewError"
          :start-error="startError"
          @retry="requestPreview"
        />
      </div>
      <DownloadDialogFooter
        :preview="preview"
        :has-planned-changes="hasPlannedChanges"
        :can-start="canStart"
        :starting="starting"
        :confirmation-label="confirmationLabel"
        @cancel="handleOpenChange(false)"
        @confirm="submit"
      />
    </DialogContent>
  </Dialog>
</template>
