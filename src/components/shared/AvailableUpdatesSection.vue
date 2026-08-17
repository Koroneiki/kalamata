<script setup lang="ts">
import { computed, ref } from 'vue'

import { getAppDetails } from '@/api/apps'
import DownloadDepotsDialog from '@/components/forms/DownloadDepotsDialog.vue'
import AvailableUpdateRow from '@/components/shared/AvailableUpdateRow.vue'
import AvailableUpdateScanStatus from '@/components/shared/AvailableUpdateScanStatus.vue'
import { useAvailableUpdates } from '@/composables/use-available-updates'
import { useDepotResourceAcquisition } from '@/composables/use-depot-resource-acquisition'
import { useDepotOperationDraftStore } from '@/stores/depot-operation-drafts'
import { useOperationStore } from '@/stores/operation'
import type { AppDetails, AvailableUpdateCandidate } from '@/types/rpc'
import { matchAvailableUpdateDepots } from '@/utils/available-updates'

const operation = useOperationStore()
const availableUpdates = useAvailableUpdates()
const resourceAcquisition = useDepotResourceAcquisition()
const depotDrafts = useDepotOperationDraftStore()
const preparationError = ref('')
const reviewingAppId = ref<number | null>(null)
const reviewCandidate = ref<AvailableUpdateCandidate | null>(null)
const reviewDetails = ref<AppDetails | null>(null)
const reviewDepotIds = ref<number[]>([])
const reviewDialogOpen = ref(false)
const emptyManifestTargets = new Map<number, string>()
const visibleCandidates = computed(() =>
  availableUpdates.candidates.value.filter(
    ({ app }) => !operation.isAppInDownloads(app.appId),
  ),
)
const hasScanFailure = computed(
  () =>
    Boolean(availableUpdates.scanError.value) ||
    availableUpdates.failures.value.length > 0,
)
const showCurrent = computed(
  () =>
    !availableUpdates.running.value &&
    !hasScanFailure.value &&
    visibleCandidates.value.length === 0,
)

async function reviewUpdate(candidate: AvailableUpdateCandidate) {
  if (reviewingAppId.value !== null) return
  const appId = candidate.app.appId
  reviewingAppId.value = appId
  preparationError.value = ''
  reviewCandidate.value = candidate
  try {
    const details = await getAppDetails(appId)
    const depots = matchAvailableUpdateDepots(details, candidate)
    if (!depots) {
      await availableUpdates.refreshApp(appId)
      throw new Error('This update changed. Review the replacement row.')
    }
    await resourceAcquisition.acquireRequiredResources(appId, depots)
    const prepared = await getAppDetails(appId)
    const preparedDepots = matchAvailableUpdateDepots(prepared, candidate)
    if (!preparedDepots) {
      await availableUpdates.refreshApp(appId)
      throw new Error('This update changed. Review the replacement row.')
    }
    if (
      preparedDepots.some(
        (depot) =>
          depot.keyStatus !== 'present' || depot.manifestStatus !== 'ready',
      )
    )
      throw new Error('Update resources could not be prepared.')
    reviewDetails.value = prepared
    reviewDepotIds.value = [...prepared.installedDepotIds]
    reviewDialogOpen.value = true
  } catch (error) {
    preparationError.value =
      error instanceof Error ? error.message : String(error)
  } finally {
    reviewingAppId.value = null
  }
}

function updateReviewDepotIds(depotIds: number[]) {
  reviewDepotIds.value = depotIds
  if (reviewDetails.value)
    depotDrafts.editDepotIds(reviewDetails.value.appId, depotIds)
}

function updateSubmitted() {
  const appId = reviewDetails.value?.appId
  if (appId) void availableUpdates.invalidateApp(appId)
}
</script>

<template>
  <section class="mt-10" aria-labelledby="available-updates-heading">
    <AvailableUpdateScanStatus :candidate-count="visibleCandidates.length" />
    <ul class="divide-border divide-y" aria-label="Available updates">
      <AvailableUpdateRow
        v-for="candidate in visibleCandidates"
        :key="candidate.app.appId"
        :candidate="candidate"
        :reviewing="reviewingAppId === candidate.app.appId"
        :disabled="reviewingAppId !== null"
        :error="
          reviewCandidate?.app.appId === candidate.app.appId
            ? preparationError
            : ''
        "
        @review="reviewUpdate(candidate)"
      />
      <li
        v-if="showCurrent"
        class="text-muted-foreground py-5 text-sm"
        role="status"
      >
        Your installed apps are up to date
      </li>
    </ul>
  </section>
  <DownloadDepotsDialog
    v-if="reviewDetails"
    :open="reviewDialogOpen"
    :app="reviewDetails"
    :initial-path="reviewDetails.installPath ?? ''"
    :selected-depot-ids="reviewDepotIds"
    :custom-manifest-targets="emptyManifestTargets"
    priority
    @update:open="reviewDialogOpen = $event"
    @update:selected-depot-ids="updateReviewDepotIds"
    @download-started="updateSubmitted"
  />
</template>
