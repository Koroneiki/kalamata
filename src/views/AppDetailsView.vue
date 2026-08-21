<script setup lang="ts">
import {
  useMutation,
  useMutationCache,
  useQuery,
  useQueryCache,
} from '@pinia/colada'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Trash2 } from '@lucide/vue'
import { useRoute, useRouter } from 'vue-router'

import CustomManifestDialog from '@/components/forms/CustomManifestDialog.vue'
import DownloadDepotsDialog from '@/components/forms/DownloadDepotsDialog.vue'
import GameSettingsDialog from '@/components/forms/GameSettingsDialog.vue'
import ColdClientSetupDialog from '@/components/forms/ColdClientSetupDialog.vue'
import RemoveColdClientDialog from '@/components/forms/RemoveColdClientDialog.vue'
import RemoveLibraryEntryDialog from '@/components/forms/RemoveLibraryEntryDialog.vue'
import AppDetailsActionBar from '@/components/shared/AppDetailsActionBar.vue'
import AppDetailsHeader from '@/components/shared/AppDetailsHeader.vue'
import AppDetailsQueryState from '@/components/shared/AppDetailsQueryState.vue'
import DepotAccordion from '@/components/shared/DepotAccordion.vue'
import { Button } from '@/components/ui/button'
import {
  appQueryKeys,
  appDetailsQuery,
  libraryQueryKey,
  useSettingsQuery,
  useColdClientDependenciesQuery,
  useColdClientStatusQuery,
  coldClientDependencyUpdateMutationKey,
  coldClientQueryKeys,
} from '@/composables/queries'
import { useFallbackImage } from '@/composables/use-fallback-image'
import { useAppOperationDisplay } from '@/composables/use-app-operation-display'
import { useCustomManifest } from '@/composables/use-custom-manifest'
import { useAvailableUpdates } from '@/composables/use-available-updates'
import { useDepotResourceAcquisition } from '@/composables/use-depot-resource-acquisition'
import { openInstallDirectory } from '@/api/apps'
import {
  removeColdClient as requestRemoveColdClient,
  updateColdClientCore,
} from '@/api/cold-client'
import {
  addLibraryEntry,
  removeLibraryEntry,
  setDepotPinned,
} from '@/api/library'
import {
  normalizeDepotDraftEdit,
  useDepotOperationDraftStore,
} from '@/stores/depot-operation-drafts'
import { useOperationStore } from '@/stores/operation'
import { useColdClientOperationStore } from '@/stores/cold-client-operation'
import type { AppDepot } from '@/types/rpc'
import type { ColdClientSetupMode } from '@/types/cold-client'
import { filterDepots, matchesDepotPlatform } from '@/utils/depots'

import { steamIdStringSchema } from '@/types/schemas'

const route = useRoute()
const router = useRouter()
const operation = useOperationStore()
const coldClientOperation = useColdClientOperationStore()
const availableUpdates = useAvailableUpdates()
const depotDrafts = useDepotOperationDraftStore()
const resourceAcquisition = useDepotResourceAcquisition()
const queryCache = useQueryCache()
const mutationCache = useMutationCache()
const { data: settings } = useSettingsQuery()
const { data: coldClientDependencies } = useColdClientDependenciesQuery()
const coldClientReady = computed(
  () =>
    Boolean(coldClientDependencies.value?.loginFileExists) &&
    Boolean(
      coldClientDependencies.value?.dependencies.every(
        ({ currentAssetId }) => currentAssetId !== null,
      ),
    ),
)
const parsedAppId = computed(() =>
  steamIdStringSchema.safeParse(String(route.params.appId)),
)
const appId = computed(() =>
  parsedAppId.value.success ? parsedAppId.value.data : 0,
)
const {
  data: coldClientStatus,
  error: coldClientStatusError,
  isPending: coldClientStatusPending,
} = useColdClientStatusQuery(appId)
const validAppId = computed(() => parsedAppId.value.success)

const { data, error, isPending, refetch } = useQuery(() => ({
  ...appDetailsQuery(appId.value),
  enabled: validAppId.value,
}))

const selectedPath = ref('')
const artworkFailed = ref(false)
const dialogOpen = ref(false)
const gameSettingsOpen = ref(false)
const removeDialogOpen = ref(false)
const removeColdClientDialogOpen = ref(false)
const coldClientSetupOpen = ref(false)
const coldClientSetupMode = ref<ColdClientSetupMode>('setup')
const mutationError = ref('')
const manifestError = ref('')
const acquiringManifests = reactive(new Set<string>())
const attemptedManifests = new Set<string>()
const attemptedDepotKeys = new Set<number>()
const removeError = ref('')
const removeColdClientError = ref('')
const operationPanel = ref<{ focusHeading: () => void } | null>(null)
const loadedAppId = ref<number | null>(null)

const addMutation = useMutation({
  mutation: (id: number) => addLibraryEntry(id),
})
const removeMutation = useMutation({
  mutation: (id: number) => removeLibraryEntry(id),
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
const updateColdClientCoreMutation = useMutation({
  mutation: (id: number) => updateColdClientCore(id),
})
const removeColdClientMutation = useMutation({
  mutation: (id: number) => requestRemoveColdClient(id),
})
const acceptedDepotIds = computed(() =>
  operation.acceptedDesiredDepotIds(appId.value),
)
const baselineDepotIds = computed(
  () => acceptedDepotIds.value ?? data.value?.installedDepotIds ?? [],
)
const selectedDepotIds = computed(
  () =>
    acceptedDepotIds.value ??
    depotDrafts.get(appId.value)?.depotIds ??
    baselineDepotIds.value,
)
const customManifestTargets = computed(
  () =>
    new Map(
      (depotDrafts.get(appId.value)?.manifestTargets ?? []).map(
        ({ depotId, manifestId }) => [depotId, manifestId],
      ),
    ),
)
const {
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
  customManifestTargets,
  acquiringManifests,
  setCustomManifestTarget: (depotId, manifestId) =>
    depotDrafts.setManifestTarget(appId.value, baselineDepotIds.value, {
      depotId,
      manifestId,
    }),
  removeCustomManifestTarget: (depotId) =>
    depotDrafts.removeManifestTarget(appId.value, depotId),
  acquireDepotKeys: async (id, depotIds) =>
    (await resourceAcquisition.acquireKeys(id, depotIds)).missingDepotIds,
  acquireManifest: async (id, depotId, manifestId) => {
    await resourceAcquisition.acquireManifestResource(id, depotId, manifestId)
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
  onPinChanged: (id) => availableUpdates.refreshApp(id),
  onAcquireError: (message) => {
    manifestError.value = message
  },
})

watch(
  () => data.value,
  (app) => {
    if (app) {
      const appChanged = loadedAppId.value !== app.appId
      loadedAppId.value = app.appId
      if (appChanged) {
        gameSettingsOpen.value = false
        removeColdClientDialogOpen.value = false
        coldClientSetupOpen.value = false
        selectedPath.value = app.installPath ?? ''
        manifestError.value = ''
        resetCustomManifests()
        attemptedManifests.clear()
        attemptedDepotKeys.clear()
      } else if (app.installPath) {
        selectedPath.value = app.installPath
      }
      const retainedDepotIds = new Set([
        ...app.depots.map(({ depotId }) => depotId),
        ...app.installedDepotIds,
        ...(operation.acceptedDesiredDepotIds(app.appId) ?? []),
      ])
      depotDrafts.prune(app.appId, retainedDepotIds)
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
        settings.value.hideUnavailableDepots,
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
  Boolean(data.value?.installedDepotIds.length),
)
const hasEligibleDepotControl = computed(() =>
  Boolean(data.value?.depots.some((depot) => depot.eligible)),
)
const customManifestRemovable = computed(() =>
  customManifestDepot.value
    ? customManifestTargets.value.has(customManifestDepot.value.depotId) ||
      customManifestDepot.value.pinned
    : false,
)
// A first download reserves installPath before any depot is installed.
const primaryActionLabel = computed(() => {
  if (operation.isAppInDownloads(appId.value)) return 'In Downloads'
  if (!hasInstalledDepots.value) return 'Install'
  if (!hasEligibleDepotControl.value) return 'Uninstall'
  if (selectedDepotIds.value.length === 0) return 'Uninstall'
  return hasDepotAdditionsOrRemovals.value ||
    [...customManifestTargets.value].some(
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
const coldClientMutationBusy = computed(
  () =>
    coldClientOperation.state.status === 'active' ||
    mutationCache
      .getEntries({ key: coldClientDependencyUpdateMutationKey })
      .some((entry) => entry.asyncStatus.value === 'loading'),
)
const hasLocalInstallationActions = computed(
  () => hasInstalledDepots.value || repairRequiredForApp.value,
)
const hasColdClient = computed(
  () =>
    coldClientStatus.value?.status === 'configured' ||
    coldClientStatus.value?.status === 'invalid',
)
const coldClientRemovalMayApply = computed(
  () =>
    coldClientStatusPending.value ||
    Boolean(coldClientStatusError.value) ||
    hasColdClient.value,
)
const hasGameSettings = computed(
  () => hasLocalInstallationActions.value || hasColdClient.value,
)
const canOpenDownload = computed(() => {
  if (!data.value?.inLibrary || operationBusy.value) return false
  if (!data.value.installPath)
    return selectedDepotIds.value.some(
      (depotId) =>
        customManifestTargets.value.has(depotId) ||
        data.value?.depots.find((depot) => depot.depotId === depotId)
          ?.selectable,
    )
  return primaryActionLabel.value !== 'Installed'
})

function openDownload() {
  if (hasInstalledDepots.value && !hasEligibleDepotControl.value)
    depotDrafts.editDepotIds(appId.value, [])
  dialogOpen.value = true
}

function setDownloadDialogOpen(open: boolean) {
  dialogOpen.value = open
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

function updateSelectedDepots(depotIds: number[]) {
  const eligibleDepotIds = new Set(
    data.value?.depots
      .filter((depot) => depot.eligible)
      .map(({ depotId }) => depotId),
  )
  const next = normalizeDepotDraftEdit(depotIds, eligibleDepotIds)
  depotDrafts.editDepotIds(appId.value, next)
  mutationError.value = ''
}

function correctSelectedDepots(depotIds: number[]) {
  updateSelectedDepots(depotIds)
}

function openRemoveDialog() {
  gameSettingsOpen.value = false
  removeDialogOpen.value = true
}

function openColdClientSetup() {
  gameSettingsOpen.value = false
  mutationError.value = ''
  if (!coldClientReady.value) {
    void router.push('/settings')
    return
  }
  coldClientSetupMode.value = 'setup'
  coldClientSetupOpen.value = true
}

function regenerateColdClient() {
  gameSettingsOpen.value = false
  mutationError.value = ''
  coldClientSetupMode.value = 'regenerate'
  coldClientSetupOpen.value = true
}

async function updateColdClient() {
  const targetAppId = appId.value
  mutationError.value = ''
  gameSettingsOpen.value = false
  try {
    await updateColdClientCoreMutation.mutateAsync(targetAppId)
  } catch (error) {
    if (appId.value === targetAppId) {
      mutationError.value =
        error instanceof Error ? error.message : String(error)
    }
  }
}

function openRemoveColdClientDialog() {
  gameSettingsOpen.value = false
  removeColdClientError.value = ''
  removeColdClientDialogOpen.value = true
}

async function removeColdClient() {
  const targetAppId = appId.value
  removeColdClientError.value = ''
  try {
    await removeColdClientMutation.mutateAsync(targetAppId)
    await queryCache.invalidateQueries({
      key: coldClientQueryKeys.status(targetAppId),
      exact: true,
    })
    if (appId.value === targetAppId) {
      removeColdClientDialogOpen.value = false
    }
  } catch (error) {
    if (appId.value === targetAppId) {
      removeColdClientError.value =
        error instanceof Error ? error.message : String(error)
    }
  }
}

async function removeFromLibrary() {
  const targetAppId = appId.value
  removeError.value = ''
  try {
    await removeMutation.mutateAsync(targetAppId)
    availableUpdates.removeApp(targetAppId)
    depotDrafts.clear(targetAppId)
    if (appId.value === targetAppId) {
      removeDialogOpen.value = false
    }
    await invalidateDetailsAndLibrary(targetAppId)
  } catch (error) {
    if (appId.value === targetAppId)
      removeError.value = error instanceof Error ? error.message : String(error)
  }
}

interface ManifestAcquisitionOptions {
  acquire?: (manifestId: string) => Promise<{ fetched: boolean }>
  queueId?: number
  precedingError?: string
  targetAppId?: number
  invalidateDetails?: boolean
}

async function getManifest(
  depot: AppDepot,
  options: ManifestAcquisitionOptions = {},
) {
  if (!depot.manifestId) return
  const targetManifestId = depot.manifestId
  const targetAppId = options.targetAppId ?? appId.value
  const precedingError = options.precedingError ?? ''
  const key = manifestKey(targetAppId, depot)
  manifestError.value = precedingError
  acquiringManifests.add(key)
  try {
    let fetched = true
    if (options.acquire) {
      fetched = (await options.acquire(targetManifestId)).fetched
    } else {
      await resourceAcquisition.acquireManifestResource(
        depot.ownerAppId,
        depot.depotId,
        targetManifestId,
        options.queueId,
      )
    }
    if (fetched && options.invalidateDetails !== false) {
      await queryCache.invalidateQueries({
        key: appQueryKeys.details(targetAppId),
        exact: true,
      })
    }
    return fetched
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
  }
}

async function getDepotResources(depot: AppDepot) {
  if (!depot.eligible) return
  const targetAppId = appId.value
  const key = manifestKey(targetAppId, depot)
  let keyError = ''
  acquiringManifests.add(key)
  try {
    if (depot.keyStatus !== 'present') {
      try {
        const result = await resourceAcquisition.acquireKeys(targetAppId, [
          depot.depotId,
        ])
        if (result.missingDepotIds.includes(depot.depotId)) {
          keyError = `Depot key ${depot.depotId} is unavailable.`
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        keyError = `Depot key acquisition failed: ${message}`
      }
    }

    if (depot.manifestStatus !== 'ready') {
      // Manifest acquisition does not require a key. Encrypted filenames can
      // be validated after the key becomes available.
      await getManifest(depot, { precedingError: keyError, targetAppId })
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

async function acquireAutomaticManifests(
  targetAppId: number,
  pending: AppDepot[],
) {
  const queueId = resourceAcquisition.beginManifestBatch(pending.length)
  const acquisitions = pending.map((depot) => {
    attemptedManifests.add(manifestKey(targetAppId, depot))
    return getManifest(depot, {
      acquire: (manifestId) =>
        resourceAcquisition.acquireManifestAutomatically(
          depot.ownerAppId,
          depot.depotId,
          manifestId,
          queueId,
        ),
      targetAppId,
      invalidateDetails: false,
    })
  })
  if ((await Promise.all(acquisitions)).some(Boolean)) {
    await queryCache.invalidateQueries({
      key: appQueryKeys.details(targetAppId),
      exact: true,
    })
  }
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
      void acquireAutomaticManifests(app.appId, pending)
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
    void resourceAcquisition
      .acquireKeysAutomatically(app.appId, depotIds)
      .then(({ fetched }) => {
        if (!fetched) return
        return queryCache.invalidateQueries({
          key: appQueryKeys.details(app.appId),
          exact: true,
        })
      })
      .catch(async (error) => {
        if (data.value?.appId === app.appId) {
          manifestError.value =
            error instanceof Error ? error.message : String(error)
        }
        await queryCache.invalidateQueries({
          key: appQueryKeys.details(app.appId),
          exact: true,
        })
      })
  },
  { immediate: true },
)

async function focusDownloadQueue() {
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
          @icon-error="handleIconError"
          @artwork-error="artworkFailed = true"
        />

        <Teleport to="#app-header-actions">
          <Button
            v-if="data.inLibrary"
            type="button"
            size="icon-sm"
            variant="ghost"
            :disabled="globalOperationBusy || coldClientMutationBusy"
            aria-label="Remove from library"
            title="Remove from library"
            @click="openRemoveDialog"
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </Teleport>

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
              hasInstalledDepots: hasGameSettings,
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
            :selection-pending="operationBusy"
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
            :removes-cold-client="coldClientRemovalMayApply"
            @update:open="removeDialogOpen = $event"
            @confirm="removeFromLibrary"
          />

          <RemoveColdClientDialog
            :open="removeColdClientDialogOpen"
            :app-name="data.name"
            :removing="removeColdClientMutation.isLoading.value"
            :error="removeColdClientError"
            @update:open="removeColdClientDialogOpen = $event"
            @confirm="removeColdClient"
          />

          <ColdClientSetupDialog
            v-if="data.installPath"
            :open="coldClientSetupOpen"
            :app-id="data.appId"
            :app-name="data.name"
            :install-path="data.installPath"
            :mode="coldClientSetupMode"
            @update:open="coldClientSetupOpen = $event"
            @error="mutationError = $event"
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
          v-if="data.inLibrary && hasGameSettings"
          :open="gameSettingsOpen"
          :app-name="data.name"
          :verify-available="hasLocalInstallationActions"
          :verify-disabled="globalOperationBusy"
          :cold-client-status="coldClientStatus"
          :cold-client-ready="coldClientReady"
          :cold-client-disabled="globalOperationBusy || coldClientMutationBusy"
          @update:open="gameSettingsOpen = $event"
          @verify="verifyGameFiles"
          @remove-cold-client="openRemoveColdClientDialog"
          @setup-cold-client="openColdClientSetup"
          @regenerate-cold-client="regenerateColdClient"
          @update-cold-client-core="updateColdClient"
        />
      </template>
    </AppDetailsQueryState>
  </div>
</template>
