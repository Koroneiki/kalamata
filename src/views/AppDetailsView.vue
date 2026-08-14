<script setup lang="ts">
import { useMutation, useQuery, useQueryCache } from '@pinia/colada'
import { Download, ImageOff, Plus, Settings, Trash2 } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import DownloadDepotsDialog from '@/components/forms/DownloadDepotsDialog.vue'
import CustomManifestDialog from '@/components/forms/CustomManifestDialog.vue'
import GameSettingsDialog from '@/components/forms/GameSettingsDialog.vue'
import RemoveLibraryEntryDialog from '@/components/forms/RemoveLibraryEntryDialog.vue'
import DepotAccordion from '@/components/shared/DepotAccordion.vue'
import InlineOperationStatus from '@/components/shared/InlineOperationStatus.vue'
import {
  appQueryKeys,
  libraryQueryKey,
  useSettingsQuery,
} from '@/composables/queries'
import { acquireDepotKeys, acquireManifest, getAppDetails } from '@/api/apps'
import {
  addLibraryEntry,
  removeLibraryEntry,
  setDepotPinned,
  setSelectedDepots,
} from '@/api/library'
import { useOperationStore } from '@/stores/operation'
import { useManifestQueueStore } from '@/stores/manifest-queue'
import type {
  ActiveOperationState,
  AppDepot,
  EligibleAppDepot,
  OperationState,
  PausedOperationState,
  ResumableOperationState,
} from '@/types/rpc'
import { filterDepots, matchesDepotPlatform } from '@/utils/depots'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
const iconIndex = ref(0)
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
const customManifestTargets = reactive(new Map<number, string>())
const customManifestDialogOpen = ref(false)
const customManifestDepot = ref<EligibleAppDepot | null>(null)
const customManifestError = ref('')
const customManifestAcquiring = ref(false)

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
        customManifestDialogOpen.value = false
        customManifestDepot.value = null
        customManifestError.value = ''
        customManifestAcquiring.value = false
        attemptedManifests.clear()
        attemptedDepotKeys.clear()
        customManifestTargets.clear()
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

watch(
  () => data.value?.iconUrls,
  () => {
    iconIndex.value = 0
  },
)

const iconUrl = computed(() => data.value?.iconUrls?.[iconIndex.value] ?? null)
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

type ProgressOperation =
  | ActiveOperationState
  | PausedOperationState
  | ResumableOperationState
type RepairRequiredOperation = Extract<
  OperationState,
  { status: 'repair-required' }
>
type FailedOperation = Extract<OperationState, { status: 'failed' }>
type VisibleOperation =
  | ProgressOperation
  | FailedOperation
  | RepairRequiredOperation

function isProgressOperation(
  state: OperationState,
): state is ProgressOperation {
  return ['active', 'paused', 'resumable'].includes(state.status)
}

function latestCounter(current: string, displayed: string) {
  return BigInt(current) >= BigInt(displayed) ? current : displayed
}

const currentOperationForApp = computed(() => {
  const state = operation.state
  return state.status !== 'idle' && state.appId === appId.value ? state : null
})
const operationForApp = ref<VisibleOperation | null>(null)
const operationFinished = ref(false)
let operationVisibleSince = 0
let hideOperationTimer: ReturnType<typeof setTimeout> | undefined
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
  data.value?.depots.some(
    (depot) => depot.eligible && depot.installStatus !== 'not-installed',
  ),
)
// A first download reserves installPath before any depot is installed.
const primaryActionLabel = computed(() => {
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
const globalOperationBusy = computed(() =>
  ['active', 'paused', 'resumable'].includes(operation.state.status),
)
const repairRequiredForApp = computed(
  () =>
    operation.state.status === 'repair-required' &&
    operation.state.appId === appId.value,
)
const operationBusy = computed(
  () => globalOperationBusy.value || repairRequiredForApp.value,
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

watch(
  [currentOperationForApp, appId],
  ([state, currentAppId]) => {
    if (hideOperationTimer) clearTimeout(hideOperationTimer)
    hideOperationTimer = undefined
    if (state && isProgressOperation(state)) {
      const previous = operationForApp.value
      if (
        !previous ||
        previous.status === 'repair-required' ||
        operationFinished.value ||
        previous.appId !== state.appId
      )
        operationVisibleSince = Date.now()
      const preserveProgress =
        !operationFinished.value &&
        previous !== null &&
        isProgressOperation(previous) &&
        previous?.appId === state.appId
      // Resume replans from zero; visible progress must remain monotonic.
      operationForApp.value = preserveProgress
        ? {
            ...state,
            installedBytesCompleted: latestCounter(
              state.installedBytesCompleted,
              previous.installedBytesCompleted,
            ),
            installedBytesTotal: latestCounter(
              state.installedBytesTotal,
              previous.installedBytesTotal,
            ),
            reusedLocalBytes: latestCounter(
              state.reusedLocalBytes,
              previous.reusedLocalBytes,
            ),
            networkBytes: latestCounter(
              state.networkBytes,
              previous.networkBytes,
            ),
          }
        : state
      operationFinished.value = false
      selectedPath.value = state.installPath
      return
    }
    if (state?.status === 'repair-required' || state?.status === 'failed') {
      operationForApp.value = state
      operationFinished.value = false
      selectedPath.value = state.installPath
      return
    }
    if (!state || operationForApp.value?.appId !== currentAppId) {
      operationForApp.value = null
      operationFinished.value = false
      return
    }
    if (
      operationForApp.value.status === 'repair-required' ||
      operationForApp.value.status === 'failed'
    ) {
      operationForApp.value = null
      operationFinished.value = false
      return
    }
    operationFinished.value = true
    const remaining = Math.max(
      1_000,
      3_000 - (Date.now() - operationVisibleSince),
    )
    hideOperationTimer = setTimeout(() => {
      operationForApp.value = null
      operationFinished.value = false
      hideOperationTimer = undefined
    }, remaining)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (hideOperationTimer) clearTimeout(hideOperationTimer)
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
      // Manifest acquisition does not require a key; encrypted filenames can
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

function editCustomManifest(depot: EligibleAppDepot) {
  customManifestDepot.value = depot
  customManifestError.value = ''
  customManifestDialogOpen.value = true
}

function clearCustomManifest(depot: EligibleAppDepot) {
  customManifestTargets.delete(depot.depotId)
}

async function removeCustomManifest() {
  const depot = customManifestDepot.value
  if (!depot) return
  const targetAppId = appId.value
  if (customManifestTargets.has(depot.depotId)) {
    clearCustomManifest(depot)
    customManifestDialogOpen.value = false
    return
  }
  if (!depot.pinned) return
  customManifestError.value = ''
  customManifestAcquiring.value = true
  try {
    await pinMutation.mutateAsync({
      appId: targetAppId,
      depotId: depot.depotId,
      pinned: false,
    })
    await queryCache.invalidateQueries({
      key: appQueryKeys.details(targetAppId),
      exact: true,
    })
    if (appId.value === targetAppId) customManifestDialogOpen.value = false
  } catch (error) {
    if (appId.value === targetAppId)
      customManifestError.value =
        error instanceof Error ? error.message : String(error)
  } finally {
    if (appId.value === targetAppId) customManifestAcquiring.value = false
  }
}

async function setCustomManifest(manifestId: string) {
  const depot = customManifestDepot.value
  if (!depot) return
  const targetAppId = appId.value
  customManifestError.value = ''
  customManifestAcquiring.value = true
  const key = `${targetAppId}:${depot.depotId}:${manifestId}`
  acquiringManifests.add(key)
  try {
    if (depot.keyStatus !== 'present') {
      const result = await depotKeysMutation.mutateAsync({
        appId: targetAppId,
        depotIds: [depot.depotId],
      })
      if (result.missingDepotIds.includes(depot.depotId))
        throw new Error(`Depot key ${depot.depotId} is unavailable.`)
    }
    await manifestMutation.mutateAsync({
      appId: depot.ownerAppId,
      depotId: depot.depotId,
      manifestId,
    })
    if (manifestId === depot.installedManifestId) {
      if (!depot.pinned) {
        await pinMutation.mutateAsync({
          appId: targetAppId,
          depotId: depot.depotId,
          pinned: true,
        })
        await queryCache.invalidateQueries({
          key: appQueryKeys.details(targetAppId),
          exact: true,
        })
      }
      if (appId.value !== targetAppId) return
      customManifestTargets.delete(depot.depotId)
      customManifestDialogOpen.value = false
      return
    }
    if (appId.value !== targetAppId) return
    customManifestTargets.set(depot.depotId, manifestId)
    if (!selectedIdSet.value.has(depot.depotId))
      await updateSelectedDepots([...selectedDepotIds.value, depot.depotId])
    customManifestDialogOpen.value = false
  } catch (error) {
    if (appId.value === targetAppId)
      customManifestError.value =
        error instanceof Error ? error.message : String(error)
  } finally {
    acquiringManifests.delete(key)
    if (appId.value === targetAppId) customManifestAcquiring.value = false
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
    if (pending.length === 0) return

    const queueId = manifestQueue.begin(pending.length)
    for (const depot of pending) {
      const key = manifestKey(app.appId, depot)
      // Attempt each manifest version once per app view to avoid reactive refetch loops.
      attemptedManifests.add(key)
      void getManifest(depot, queueId, '', app.appId)
    }
  },
  { immediate: true },
)

watch(
  [
    () => data.value,
    () => settings.value?.automaticManifestAcquisition,
    () => settings.value?.platforms,
  ],
  ([app, automatic, platforms]) => {
    if (!app?.inLibrary || !automatic || !platforms) return
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

function handleIconError() {
  iconIndex.value += 1
}

async function focusDownloadQueue() {
  draftDirty.value = false
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
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
    <p v-if="!validAppId" class="text-destructive" role="alert">
      Invalid App ID.
    </p>

    <div
      v-else-if="isPending"
      class="space-y-6"
      aria-label="Loading app details"
    >
      <div
        class="grid gap-6 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-start lg:grid-cols-[minmax(0,1fr)_18rem]"
      >
        <div class="min-w-0">
          <div class="flex items-start gap-4">
            <Skeleton class="size-9 shrink-0 rounded-lg sm:size-10" />
            <Skeleton class="mt-1 h-9 w-3/5" />
          </div>
          <div
            class="mt-6 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-3"
          >
            <Skeleton v-for="index in 8" :key="index" class="h-4 w-full" />
          </div>
        </div>
        <Skeleton class="aspect-[46/21] w-full rounded-lg" />
      </div>
      <Skeleton class="h-28 w-full rounded-lg" />
      <Skeleton class="h-12 w-full rounded-lg" />
    </div>

    <div v-else-if="error" class="bg-muted rounded-lg p-4" role="alert">
      <p class="font-medium">App details could not be loaded</p>
      <p class="text-muted-foreground mt-1 text-sm">{{ error.message }}</p>
      <Button
        class="mt-3"
        size="sm"
        variant="outline"
        type="button"
        @click="refetch()"
        >Retry</Button
      >
    </div>

    <template v-else-if="data">
      <header
        class="relative grid gap-6 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-start lg:grid-cols-[minmax(0,1fr)_18rem]"
      >
        <div class="min-w-0">
          <div class="flex min-w-0 items-start gap-4">
            <div
              class="bg-muted grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg sm:size-10"
            >
              <img
                v-if="iconUrl"
                class="size-full object-cover"
                :src="iconUrl"
                :alt="`${data.name} icon`"
                @error="handleIconError"
              />
              <ImageOff
                v-else
                class="text-muted-foreground size-5"
                aria-hidden="true"
              />
              <span v-if="!iconUrl" class="sr-only">Icon unavailable</span>
            </div>
            <h1
              class="min-w-0 text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              {{ data.name }}
            </h1>
          </div>
          <dl class="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div class="min-w-0 space-y-1">
              <dt class="text-muted-foreground">App ID</dt>
              <dd class="font-mono tabular-nums">{{ data.appId }}</dd>
            </div>
            <div class="min-w-0 space-y-1">
              <dt class="text-muted-foreground">Developer</dt>
              <dd class="min-w-0 break-words">
                {{ data.developers.join(', ') || 'Unavailable' }}
              </dd>
            </div>
            <div class="min-w-0 space-y-1">
              <dt class="text-muted-foreground">Release Date</dt>
              <dd>{{ releaseDate }}</dd>
            </div>
            <div class="min-w-0 space-y-1">
              <dt class="text-muted-foreground">Publisher</dt>
              <dd class="min-w-0 break-words">
                {{ data.publishers.join(', ') || 'Unavailable' }}
              </dd>
            </div>
          </dl>
        </div>

        <div class="bg-muted aspect-[46/21] overflow-hidden rounded-lg">
          <img
            v-if="data.artworkUrl && !artworkFailed"
            class="size-full object-cover"
            :src="data.artworkUrl"
            :alt="`${data.name} artwork`"
            @error="artworkFailed = true"
          />
          <div
            v-else
            class="text-muted-foreground grid size-full place-items-center gap-1 text-xs"
          >
            <span class="grid justify-items-center gap-1">
              <ImageOff class="size-5" aria-hidden="true" />
              Artwork unavailable
            </span>
          </div>
        </div>

        <Button
          v-if="data.inLibrary"
          class="absolute top-0 right-0"
          type="button"
          size="icon-sm"
          variant="outline"
          :disabled="operationBusy"
          aria-label="Remove from library"
          @click="removeDialogOpen = true"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </header>

      <section class="mt-8" aria-label="Install game content">
        <div
          class="border-border flex flex-col gap-3 border-t py-5 sm:flex-row sm:items-center"
        >
          <Button
            v-if="data.inLibrary"
            class="h-16 w-full min-w-44 shrink-0 gap-3 rounded-sm px-8 text-lg font-semibold tracking-wider shadow-sm sm:w-auto [&_svg:not([class*='size-'])]:size-7"
            type="button"
            :disabled="!canOpenDownload"
            @click="openDownload"
          >
            <Trash2
              v-if="primaryActionLabel === 'Uninstall'"
              aria-hidden="true"
            />
            <Download v-else aria-hidden="true" />
            {{ primaryActionLabel }}
          </Button>
          <Button
            v-else
            class="h-14 w-full min-w-44 gap-3 rounded-sm px-8 text-lg font-semibold tracking-wider shadow-sm sm:w-auto [&_svg:not([class*='size-'])]:size-7"
            type="button"
            :disabled="addMutation.isLoading.value"
            @click="addToLibrary"
          >
            <Plus aria-hidden="true" />
            {{ addMutation.isLoading.value ? 'ADDING…' : 'ADD TO LIBRARY' }}
          </Button>
          <InlineOperationStatus
            v-if="operationForApp"
            ref="operationPanel"
            class="min-w-0 flex-1 sm:max-w-100"
            :state="operationForApp"
            :finished="operationFinished"
          />
          <Button
            v-if="data.inLibrary && hasInstalledDepots"
            class="shrink-0 self-end sm:ml-auto sm:self-auto"
            type="button"
            size="icon-sm"
            variant="outline"
            :disabled="globalOperationBusy"
            aria-label="Game settings"
            title="Game settings"
            @click="gameSettingsOpen = true"
          >
            <Settings aria-hidden="true" />
          </Button>
        </div>

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
          :automatic-resource-acquisition="
            data.inLibrary && settings?.automaticManifestAcquisition
          "
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

      <DownloadDepotsDialog
        v-if="data.inLibrary"
        :open="dialogOpen"
        :app="{ ...data, depots: visibleDepots }"
        :initial-path="selectedPath"
        :selected-depot-ids="selectedDepotIds"
        :custom-manifest-targets="customManifestTargets"
        @update:open="setDownloadDialogOpen"
        @update:selected-depot-ids="correctSelectedDepots"
        @download-started="focusDownloadQueue"
      />

      <CustomManifestDialog
        :open="customManifestDialogOpen"
        :removable="
          customManifestDepot
            ? customManifestTargets.has(customManifestDepot.depotId) ||
              customManifestDepot.pinned
            : false
        "
        :acquiring="customManifestAcquiring"
        :error="customManifestError"
        @update:open="customManifestDialogOpen = $event"
        @confirm="setCustomManifest"
        @remove="removeCustomManifest"
      />

      <GameSettingsDialog
        v-if="data.inLibrary && hasInstalledDepots"
        v-model:open="gameSettingsOpen"
        :app-name="data.name"
        :verify-disabled="globalOperationBusy"
        @verify="verifyGameFiles"
      />

      <RemoveLibraryEntryDialog
        v-if="data.inLibrary"
        v-model:open="removeDialogOpen"
        :app-name="data.name"
        :removing="removeMutation.isLoading.value"
        :error="removeError"
        @confirm="removeFromLibrary"
      />
    </template>
  </div>
</template>
