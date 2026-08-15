<script setup lang="ts">
import { useMutation, useQuery, useQueryCache } from '@pinia/colada'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import CustomManifestDialog from '@/components/forms/CustomManifestDialog.vue'
import DownloadDepotsDialog from '@/components/forms/DownloadDepotsDialog.vue'
import GameSettingsDialog from '@/components/forms/GameSettingsDialog.vue'
import RemoveLibraryEntryDialog from '@/components/forms/RemoveLibraryEntryDialog.vue'
import AppDetailsActionBar from '@/components/shared/AppDetailsActionBar.vue'
import AppDetailsHeader from '@/components/shared/AppDetailsHeader.vue'
import AppDetailsQueryState from '@/components/shared/AppDetailsQueryState.vue'
import DepotAccordion from '@/components/shared/DepotAccordion.vue'
import {
  appQueryKeys,
  libraryQueryKey,
  useSettingsQuery,
} from '@/composables/queries'
import { useFallbackImage } from '@/composables/use-fallback-image'
import { useAppOperationDisplay } from '@/composables/use-app-operation-display'
import { useCustomManifest } from '@/composables/use-custom-manifest'
import {
  acquireDepotKeys,
  acquireManifest,
  getAppDetails,
  openInstallDirectory,
} from '@/api/apps'
import {
  addLibraryEntry,
  removeLibraryEntry,
  setDepotPinned,
  setSelectedDepots,
} from '@/api/library'
import { useOperationStore } from '@/stores/operation'
import { useManifestQueueStore } from '@/stores/manifest-queue'
import type { AppDepot } from '@/types/rpc'
import { filterDepots, matchesDepotPlatform } from '@/utils/depots'

import { steamIdStringSchema } from '@/types/schemas'

const route = useRoute()
const operation = useOperationStore()
const manifestQueue = useManifestQueueStore()
const queryCache = useQueryCache()
const { data: settings } = useSettingsQuery()
const parsedAppId = computed(() =>
  steamIdStringSchema.safeParse(String(route.params.appId)),
)
const appId = computed(() =>
  parsedAppId.value.success ? parsedAppId.value.data : 0,
)
const validAppId = computed(() => parsedAppId.value.success)

const { data, error, isPending, refetch } = useQuery(() => ({
  key: appQueryKeys.details(appId.value),
  query: () => getAppDetails(appId.value),
  enabled: validAppId.value,
}))

const selectedPath = ref('')
const artworkFailed = ref(false)
const dialogOpen = ref(false)
const gameSettingsOpen = ref(false)
const removeDialogOpen = ref(false)
const selectedDepotIds = ref<number[]>([])
const mutationError = ref('')
const manifestError = ref('')
const acquiringManifests = reactive(new Set<string>())
const attemptedManifests = new Set<string>()
const attemptedDepotKeys = new Set<number>()
const removeError = ref('')
const operationPanel = ref<{ focusHeading: () => void } | null>(null)
const loadedAppId = ref<number | null>(null)
const draftDirty = ref(false)

const addMutation = useMutation({
  mutation: (id: number) => addLibraryEntry(id),
})
const removeMutation = useMutation({
  mutation: (id: number) => removeLibraryEntry(id),
})
const selectionMutation = useMutation({
  mutation: ({ appId, depotIds }: { appId: number; depotIds: number[] }) =>
    setSelectedDepots(appId, depotIds),
})
const manifestMutation = useMutation({
  mutation: ({
    appId,
    depotId,
    manifestId,
  }: {
    appId: number
    depotId: number
    manifestId: string
  }) => acquireManifest(appId, depotId, manifestId),
})
const depotKeysMutation = useMutation({
  mutation: ({ appId, depotIds }: { appId: number; depotIds: number[] }) =>
    acquireDepotKeys(appId, depotIds),
})
const pinMutation = useMutation({
  mutation: ({
    appId,
    depotId,
    pinned,
  }: {
    appId: number
    depotId: number
    pinned: boolean
  }) => setDepotPinned(appId, depotId, pinned),
})
const openInstallDirectoryMutation = useMutation({
  mutation: (id: number) => openInstallDirectory(id),
})
const {
  customManifestTargets,
  customManifestDialogOpen,
  customManifestDepot,
  customManifestError,
  customManifestAcquiring,
  editCustomManifest,
  resetCustomManifests,
  setCustomManifest,
  removeCustomManifest,
} = useCustomManifest({
  appId,
  selectedDepotIds,
  acquiringManifests,
  updateSelectedDepots,
  acquireDepotKeys: async (id, depotIds) =>
    (
      await depotKeysMutation.mutateAsync({
        appId: id,
        depotIds,
      })
    ).missingDepotIds,
  acquireManifest: async (id, depotId, manifestId) => {
    await manifestMutation.mutateAsync({ appId: id, depotId, manifestId })
  },
  setDepotPinned: async (id, depotId, pinned) => {
    await pinMutation.mutateAsync({ appId: id, depotId, pinned })
  },
  invalidateDetails: async (id) => {
    await queryCache.invalidateQueries({
      key: appQueryKeys.details(id),
      exact: true,
    })
  },
})

watch(
  () => data.value,
  (app) => {
    if (app) {
      const appChanged = loadedAppId.value !== app.appId
      loadedAppId.value = app.appId
      if (appChanged) {
        draftDirty.value = false
        gameSettingsOpen.value = false
        selectedPath.value = app.installPath ?? ''
        manifestError.value = ''
        resetCustomManifests()
        attemptedManifests.clear()
        attemptedDepotKeys.clear()
      } else if (app.installPath) {
        selectedPath.value = app.installPath
      }
      if (appChanged || !draftDirty.value)
        selectedDepotIds.value = [...app.selectedDepotIds]
    }
  },
  { immediate: true },
)

watch(
  () => data.value?.artworkUrl,
  () => {
    artworkFailed.value = false
  },
)

const { imageUrl: iconUrl, handleImageError: handleIconError } =
  useFallbackImage(() => data.value?.iconUrls)
const selectedIdSet = computed(() => new Set(selectedDepotIds.value))
const visibleDepots = computed(() => {
  const depots = data.value?.depots ?? []
  return settings.value
    ? filterDepots(
        depots,
        settings.value.hideRedistributables,
        settings.value.hideUnknownDepots,
        settings.value.hideUnusedDepots,
        settings.value.platforms,
        selectedIdSet.value,
      )
    : depots
})
const automaticResourceAcquisition = computed(
  () => data.value?.inLibrary && settings.value?.automaticManifestAcquisition,
)
const acquiringDepotIds = computed(() =>
  (data.value?.depots ?? [])
    .filter((depot) =>
      [...acquiringManifests].some((key) =>
        key.startsWith(`${data.value!.appId}:${depot.depotId}:`),
      ),
    )
    .map(({ depotId }) => depotId),
)
const releaseDate = computed(() => {
  if (!data.value?.releaseDate) return 'Unavailable'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(data.value.releaseDate)
})

const { operationForApp, operationFinished } = useAppOperationDisplay({
  appId,
  operationState: () => operation.state,
  selectedPath,
})
const hasDepotAdditionsOrRemovals = computed(() =>
  data.value?.depots.some(
    (depot) =>
      depot.eligible &&
      ((depot.installStatus === 'not-installed' &&
        selectedIdSet.value.has(depot.depotId)) ||
        (depot.installStatus !== 'not-installed' &&
          !selectedIdSet.value.has(depot.depotId))),
  ),
)
const hasInstalledDepots = computed(() =>
  Boolean(
    data.value?.depots.some(
      (depot) => depot.eligible && depot.installStatus !== 'not-installed',
    ),
  ),
)
const customManifestRemovable = computed(() =>
  customManifestDepot.value
    ? customManifestTargets.has(customManifestDepot.value.depotId) ||
      customManifestDepot.value.pinned
    : false,
)
// A first download reserves installPath before any depot is installed.
const primaryActionLabel = computed(() => {
  if (operation.isAppInDownloads(appId.value)) return 'In Downloads'
  if (!hasInstalledDepots.value) return 'Install'
  if (selectedDepotIds.value.length === 0) return 'Uninstall'
  return hasDepotAdditionsOrRemovals.value ||
    [...customManifestTargets].some(
      ([depotId, manifestId]) =>
        selectedIdSet.value.has(depotId) &&
        data.value?.depots.find((depot) => depot.depotId === depotId)
          ?.installedManifestId !== manifestId,
    ) ||
    data.value!.depots.some(
      (depot) =>
        depot.eligible &&
        depot.installStatus === 'outdated' &&
        selectedIdSet.value.has(depot.depotId),
    )
    ? 'Update'
    : 'Installed'
})
const operationBusy = computed(() => operation.isAppInDownloads(appId.value))
const repairRequiredForApp = computed(() =>
  operation.isRepairRequired(appId.value),
)
const globalOperationBusy = computed(
  () => operationBusy.value && !repairRequiredForApp.value,
)
const hasLocalInstallationActions = computed(
  () => hasInstalledDepots.value || repairRequiredForApp.value,
)
const canOpenDownload = computed(() => {
  if (!data.value?.inLibrary || operationBusy.value) return false
  if (!data.value.installPath)
    return selectedDepotIds.value.some(
      (depotId) =>
        customManifestTargets.has(depotId) ||
        data.value?.depots.find((depot) => depot.depotId === depotId)
          ?.selectable,
    )
  return primaryActionLabel.value !== 'Installed'
})

function openDownload() {
  dialogOpen.value = true
}

function setDownloadDialogOpen(open: boolean) {
  dialogOpen.value = open
  if (!open) {
    customManifestTargets.clear()
  }
}

async function invalidateDetailsAndLibrary(id = appId.value) {
  await Promise.all([
    queryCache.invalidateQueries({
      key: appQueryKeys.details(id),
      exact: true,
    }),
    queryCache.invalidateQueries({ key: libraryQueryKey, exact: true }),
  ])
}

async function addToLibrary() {
  const targetAppId = appId.value
  mutationError.value = ''
  try {
    await addMutation.mutateAsync(targetAppId)
    await invalidateDetailsAndLibrary(targetAppId)
  } catch (error) {
    if (appId.value === targetAppId)
      mutationError.value =
        error instanceof Error ? error.message : String(error)
  }
}

async function updateSelectedDepots(depotIds: number[]) {
  // Installed-app selections remain drafts until confirmed planning persists them.
  if (data.value?.installPath) {
    selectedDepotIds.value = depotIds
    draftDirty.value = true
    mutationError.value = ''
    return
  }
  const targetAppId = appId.value
  const previous = selectedDepotIds.value
  selectedDepotIds.value = depotIds
  mutationError.value = ''
  try {
    const selected = await selectionMutation.mutateAsync({
      appId: targetAppId,
      depotIds,
    })
    await queryCache.invalidateQueries({
      key: appQueryKeys.details(targetAppId),
      exact: true,
    })
    if (appId.value === targetAppId) selectedDepotIds.value = selected
    draftDirty.value = false
  } catch (error) {
    if (appId.value === targetAppId) {
      selectedDepotIds.value = previous
      mutationError.value =
        error instanceof Error ? error.message : String(error)
    }
  }
}

function correctSelectedDepots(depotIds: number[]) {
  // Preview corrections remain drafts until the confirmed operation persists them.
  selectedDepotIds.value = depotIds
  draftDirty.value = true
  mutationError.value = ''
}

async function removeFromLibrary() {
  const targetAppId = appId.value
  removeError.value = ''
  try {
    await removeMutation.mutateAsync(targetAppId)
    if (appId.value === targetAppId) {
      removeDialogOpen.value = false
      selectedDepotIds.value = []
    }
    await invalidateDetailsAndLibrary(targetAppId)
  } catch (error) {
    if (appId.value === targetAppId)
      removeError.value = error instanceof Error ? error.message : String(error)
  }
}

async function getManifest(
  depot: AppDepot,
  queueId?: number,
  precedingError = '',
  targetAppId = appId.value,
) {
  if (!depot.manifestId) return
  const manifestQueueId = queueId ?? manifestQueue.begin(1)
  const targetManifestId = depot.manifestId
  const key = manifestKey(targetAppId, depot)
  manifestError.value = precedingError
  acquiringManifests.add(key)
  try {
    await manifestMutation.mutateAsync({
      appId: depot.ownerAppId,
      depotId: depot.depotId,
      manifestId: targetManifestId,
    })
    await queryCache.invalidateQueries({
      key: appQueryKeys.details(targetAppId),
      exact: true,
    })
  } catch (error) {
    if (
      appId.value === targetAppId &&
      data.value?.depots.some(
        (current) =>
          current.depotId === depot.depotId &&
          current.manifestId === targetManifestId,
      )
    ) {
      const message = error instanceof Error ? error.message : String(error)
      manifestError.value = precedingError
        ? `${precedingError} Manifest acquisition failed: ${message}`
        : message
    }
  } finally {
    acquiringManifests.delete(key)
    manifestQueue.settle(manifestQueueId)
  }
}

async function getDepotResources(depot: AppDepot) {
  const targetAppId = appId.value
  const key = manifestKey(targetAppId, depot)
  let keyError = ''
  acquiringManifests.add(key)
  try {
    if (depot.eligible && depot.keyStatus !== 'present') {
      try {
        const result = await depotKeysMutation.mutateAsync({
          appId: targetAppId,
          depotIds: [depot.depotId],
        })
        if (result.missingDepotIds.includes(depot.depotId)) {
          keyError = `Depot key ${depot.depotId} is unavailable.`
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        keyError = `Depot key acquisition failed: ${message}`
      }
    }

    if (!depot.eligible || depot.manifestStatus !== 'ready') {
      // Manifest acquisition does not require a key. Encrypted filenames can
      // be validated after the key becomes available.
      await getManifest(depot, undefined, keyError, targetAppId)
    } else {
      if (appId.value === targetAppId) manifestError.value = keyError
      await queryCache.invalidateQueries({
        key: appQueryKeys.details(targetAppId),
        exact: true,
      })
    }
  } finally {
    acquiringManifests.delete(key)
  }
}

function manifestKey(appId: number, depot: AppDepot) {
  return `${appId}:${depot.depotId}:${depot.manifestId}`
}

watch(
  [
    () => data.value,
    () => settings.value?.automaticManifestAcquisition,
    () => settings.value?.platforms,
  ],
  ([app, automatic, platforms]) => {
    if (!app?.inLibrary || !automatic || !platforms) return
    const pending = app.depots.filter(
      (depot) =>
        depot.eligible &&
        depot.manifestId &&
        depot.manifestStatus !== 'ready' &&
        matchesDepotPlatform(depot, platforms) &&
        !attemptedManifests.has(manifestKey(app.appId, depot)),
    )
    if (pending.length > 0) {
      const queueId = manifestQueue.begin(pending.length)
      for (const depot of pending) {
        const key = manifestKey(app.appId, depot)
        // Attempt each manifest version once per app view to avoid reactive refetch loops.
        attemptedManifests.add(key)
        void getManifest(depot, queueId, '', app.appId)
      }
    }

    const depotIds = app.depots
      .filter(
        (depot) =>
          depot.eligible &&
          depot.keyStatus !== 'present' &&
          matchesDepotPlatform(depot, platforms) &&
          !attemptedDepotKeys.has(depot.depotId),
      )
      .map(({ depotId }) => depotId)
    if (depotIds.length === 0) return

    for (const depotId of depotIds) attemptedDepotKeys.add(depotId)
    void depotKeysMutation
      .mutateAsync({ appId: app.appId, depotIds })
      .catch((error) => {
        if (data.value?.appId === app.appId) {
          manifestError.value =
            error instanceof Error ? error.message : String(error)
        }
      })
      .then(() =>
        queryCache.invalidateQueries({
          key: appQueryKeys.details(app.appId),
          exact: true,
        }),
      )
  },
  { immediate: true },
)

async function focusDownloadQueue() {
  customManifestTargets.clear()
  await nextTick()
  operationPanel.value?.focusHeading()
}

async function verifyGameFiles() {
  mutationError.value = ''
  gameSettingsOpen.value = false
  try {
    await operation.verify({ appId: appId.value })
    await nextTick()
    operationPanel.value?.focusHeading()
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : String(error)
  }
}

async function browseLocalFiles() {
  mutationError.value = ''
  try {
    await openInstallDirectoryMutation.mutateAsync(appId.value)
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
    <AppDetailsQueryState
      :valid-app-id="validAppId"
      :pending="isPending"
      :error="error"
      :has-data="Boolean(data)"
      @retry="refetch()"
    >
      <template v-if="data">
        <AppDetailsHeader
          :app="data"
          :icon-url="iconUrl"
          :release-date="releaseDate"
          :artwork-failed="artworkFailed"
          :operation-busy="operationBusy"
          @icon-error="handleIconError"
          @artwork-error="artworkFailed = true"
          @remove="removeDialogOpen = true"
        />

        <section class="mt-8" aria-label="Install game content">
          <AppDetailsActionBar
            ref="operationPanel"
            :app="data"
            :primary-action="{
              label: primaryActionLabel,
              enabled: canOpenDownload,
              pending: addMutation.isLoading.value,
            }"
            :local-actions="{
              hasInstalledDepots: hasLocalInstallationActions,
              browsePending: openInstallDirectoryMutation.isLoading.value,
              globalOperationBusy,
            }"
            :operation-for-app="operationForApp"
            :operation-finished="operationFinished"
            @open-download="openDownload"
            @add-to-library="addToLibrary"
            @browse="browseLocalFiles"
            @open-settings="gameSettingsOpen = true"
          />

          <p
            v-if="mutationError"
            class="text-destructive mb-5 text-sm"
            role="alert"
          >
            {{ mutationError }}
          </p>

          <DepotAccordion
            :depots="visibleDepots"
            :selected-depot-ids="selectedDepotIds"
            :read-only="!data.inLibrary"
            :selection-pending="
              selectionMutation.isLoading.value || operationBusy
            "
            :acquiring-depot-ids="acquiringDepotIds"
            :automatic-resource-acquisition="automaticResourceAcquisition"
            :custom-manifest-targets="customManifestTargets"
            @update:selected-depot-ids="updateSelectedDepots"
            @acquire-resources="getDepotResources"
            @edit-custom-manifest="editCustomManifest"
          />
          <p
            v-if="manifestError"
            class="text-destructive mt-3 text-sm"
            role="alert"
          >
            {{ manifestError }}
          </p>
        </section>

        <template v-if="data.inLibrary">
          <DownloadDepotsDialog
            :open="dialogOpen"
            :app="{ ...data, depots: visibleDepots }"
            :initial-path="selectedPath"
            :selected-depot-ids="selectedDepotIds"
            :custom-manifest-targets="customManifestTargets"
            @update:open="setDownloadDialogOpen"
            @update:selected-depot-ids="correctSelectedDepots"
            @download-started="focusDownloadQueue"
          />

          <RemoveLibraryEntryDialog
            :open="removeDialogOpen"
            :app-name="data.name"
            :removing="removeMutation.isLoading.value"
            :error="removeError"
            @update:open="removeDialogOpen = $event"
            @confirm="removeFromLibrary"
          />
        </template>

        <CustomManifestDialog
          :open="customManifestDialogOpen"
          :removable="customManifestRemovable"
          :acquiring="customManifestAcquiring"
          :error="customManifestError"
          @update:open="customManifestDialogOpen = $event"
          @confirm="setCustomManifest"
          @remove="removeCustomManifest"
        />

        <GameSettingsDialog
          v-if="data.inLibrary && hasLocalInstallationActions"
          :open="gameSettingsOpen"
          :app-name="data.name"
          :verify-disabled="globalOperationBusy"
          @update:open="gameSettingsOpen = $event"
          @verify="verifyGameFiles"
        />
      </template>
    </AppDetailsQueryState>
  </div>
</template>
