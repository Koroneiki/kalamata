<script setup lang="ts">
import { useMutation, useQueryCache } from '@pinia/colada'
import { Check, Download, FolderOpen, RefreshCw, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import {
  openUserDataFolder as requestOpenUserDataFolder,
  updateSettings,
} from '@/api/settings'
import {
  checkColdClientDependencyUpdates,
  openColdClientLoginDirectory,
  updateColdClientDependencies,
} from '@/api/cold-client'
import SettingsCheckboxRow from '@/components/forms/SettingsCheckboxRow.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  hubcapUsageQueryKey,
  coldClientDependenciesQueryKey,
  coldClientDependencyUpdateMutationKey,
  coldClientQueryKeys,
  settingsQueryKey,
  useColdClientDependenciesQuery,
  useHubcapUsageQuery,
  useSettingsQuery,
} from '@/composables/queries'
import {
  invalidateDepotKeyAcquisitions,
  invalidateResourceAcquisitions,
} from '@/composables/resource-acquisition-cache'
import { cn } from '@/lib/utils'
import type { AppSettings, DepotPlatform } from '@/types/rpc'
import type {
  ColdClientDependencyId,
  ColdClientDependencyItemStatus,
} from '@/types/cold-client'
import { depotPlatforms } from '@/utils/depots'

const queryCache = useQueryCache()
const { data: settings, error, isPending } = useSettingsQuery()
const {
  data: hubcapUsage,
  isLoading: hubcapUsageLoading,
  isPending: hubcapUsagePending,
} = useHubcapUsageQuery()
const updateMutation = useMutation({ mutation: updateSettings })
const openFolderMutation = useMutation({ mutation: requestOpenUserDataFolder })
const {
  data: coldClientDependencies,
  error: coldClientQueryError,
  isPending: coldClientPending,
} = useColdClientDependenciesQuery()
const checkColdClientMutation = useMutation({
  mutation: checkColdClientDependencyUpdates,
})
const updateColdClientMutation = useMutation({
  key: coldClientDependencyUpdateMutationKey,
  mutation: updateColdClientDependencies,
  onSettled: async () => {
    await Promise.allSettled([
      queryCache.invalidateQueries({
        key: coldClientDependenciesQueryKey,
        exact: true,
      }),
      queryCache.invalidateQueries({ key: coldClientQueryKeys.all }),
    ])
  },
})
const openLoginFolderMutation = useMutation({
  mutation: openColdClientLoginDirectory,
})
const mutationError = ref('')
const coldClientMutationError = ref('')
const confirmingDependencyUpdate = ref(false)
const hubcapApiKeyDraft = ref('')
const hubcapKeyFocused = ref(false)
const hubcapUsageLabels = {
  'missing-key': 'No key configured',
  'invalid-key': 'Key invalid',
  'stats-unavailable': 'Usage unavailable',
} as const
const hasError = computed(() =>
  Boolean(
    error.value ||
    mutationError.value ||
    coldClientQueryError.value ||
    coldClientMutationError.value,
  ),
)
const errorMessage = computed(
  () =>
    mutationError.value ||
    coldClientMutationError.value ||
    error.value?.message ||
    coldClientQueryError.value?.message,
)
const dependencyLabels = {
  '7zip': '7-Zip extractor',
  gbe: 'GBE Fork',
  gse: 'GSE Tools',
} satisfies Record<ColdClientDependencyId, string>
const dependencyUpdateIds = computed(
  () =>
    coldClientDependencies.value?.dependencies
      .filter(
        ({ status }) => status === 'missing' || status === 'update-available',
      )
      .map(({ dependencyId }) => dependencyId) ?? [],
)
const coldClientBusy = computed(
  () =>
    checkColdClientMutation.isLoading.value ||
    updateColdClientMutation.isLoading.value ||
    openLoginFolderMutation.isLoading.value,
)
const hubcapUsageText = computed(() => {
  if (!settings.value?.hubcapApiKey) return 'No key configured'
  if (hubcapUsagePending.value || hubcapUsageLoading.value)
    return 'Checking Hubcap usage…'
  const result = hubcapUsage.value
  if (result?.status === 'available')
    return `${result.usage.dailyUsage} / ${result.usage.dailyLimit} Hubcap requests today`
  return result ? hubcapUsageLabels[result.status] : 'No key configured'
})

watch(
  () => settings.value?.hubcapApiKey,
  (apiKey) => {
    if (!hubcapKeyFocused.value) hubcapApiKeyDraft.value = apiKey ?? ''
  },
  { immediate: true },
)

const platformLabels = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
} satisfies Record<DepotPlatform, string>

type BooleanSettingKey =
  | 'automaticManifestAcquisition'
  | 'hideRedistributables'
  | 'hideUnknownDepots'
  | 'hideUnusedDepots'
  | 'hideUnavailableDepots'

function settingValue(key: BooleanSettingKey) {
  return settings.value?.[key]
}

function platformClass(platform: DepotPlatform) {
  return cn(
    'border-border hover:bg-accent/60 flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-normal transition-colors',
    settings.value?.platforms.includes(platform) &&
      'border-primary/40 bg-primary/10 text-foreground',
    updateMutation.isLoading.value && 'pointer-events-none opacity-60',
  )
}

async function persist(next: AppSettings, optimistic = true) {
  const previous = settings.value
  mutationError.value = ''
  if (optimistic) queryCache.setQueryData(settingsQueryKey, next)
  try {
    const saved = await updateMutation.mutateAsync(next)
    queryCache.setQueryData(settingsQueryKey, saved)
    if (previous?.hubcapApiKey !== saved.hubcapApiKey) {
      invalidateDepotKeyAcquisitions(queryCache)
    }
    if (
      previous &&
      !previous.automaticManifestAcquisition &&
      saved.automaticManifestAcquisition
    )
      invalidateResourceAcquisitions(queryCache)
    return true
  } catch (error) {
    if (optimistic && previous)
      queryCache.setQueryData(settingsQueryKey, previous)
    mutationError.value = error instanceof Error ? error.message : String(error)
    return false
  }
}

async function saveHubcapApiKey() {
  if (!settings.value || updateMutation.isLoading.value) return
  const apiKey = hubcapApiKeyDraft.value.trim()
  if (apiKey === settings.value.hubcapApiKey) return
  if (!(await persist({ ...settings.value, hubcapApiKey: apiKey }, false)))
    return
  hubcapApiKeyDraft.value = apiKey
  await queryCache.invalidateQueries({ key: hubcapUsageQueryKey, exact: true })
}

function handleHubcapKeyBlur() {
  hubcapKeyFocused.value = false
  void saveHubcapApiKey()
}

function setPlatform(platform: DepotPlatform, active: boolean) {
  if (!settings.value) return
  const next = new Set(settings.value.platforms)
  if (active) next.add(platform)
  else next.delete(platform)
  void persist({
    ...settings.value,
    platforms: depotPlatforms.filter((item) => next.has(item)),
  })
}

function setHideRedistributables(value: boolean | 'indeterminate') {
  if (!settings.value || value === 'indeterminate') return
  void persist({ ...settings.value, hideRedistributables: value })
}

function setAutomaticManifestAcquisition(value: boolean | 'indeterminate') {
  if (!settings.value || value === 'indeterminate') return
  // Cache updates trigger acquisition, so publish this only after persistence succeeds.
  void persist(
    { ...settings.value, automaticManifestAcquisition: value },
    false,
  )
}

function setHideUnknownDepots(value: boolean | 'indeterminate') {
  if (!settings.value || value === 'indeterminate') return
  void persist({ ...settings.value, hideUnknownDepots: value })
}

function setHideUnusedDepots(value: boolean | 'indeterminate') {
  if (!settings.value || value === 'indeterminate') return
  void persist({ ...settings.value, hideUnusedDepots: value })
}

function setHideUnavailableDepots(value: boolean | 'indeterminate') {
  if (!settings.value || value === 'indeterminate') return
  void persist({ ...settings.value, hideUnavailableDepots: value })
}

async function openUserDataFolder() {
  mutationError.value = ''
  try {
    await openFolderMutation.mutateAsync()
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : String(error)
  }
}

function dependencyStatusLabel(item: ColdClientDependencyItemStatus) {
  if (item.status === 'check-failed') return 'Check failed'
  if (item.status === 'update-available') return 'Update available'
  if (item.status === 'missing') return 'Not installed'
  return 'Current'
}

function dependencyVersionText(item: ColdClientDependencyItemStatus) {
  if (!item.currentTag) return item.availableTag ?? 'Version unavailable'
  if (item.availableTag && item.availableAssetId !== item.currentAssetId) {
    return `${item.currentTag} installed · ${item.availableTag} available`
  }
  return `${item.currentTag} installed`
}

async function checkColdClientDependencies() {
  coldClientMutationError.value = ''
  try {
    const status = await checkColdClientMutation.mutateAsync()
    queryCache.setQueryData(coldClientDependenciesQueryKey, status)
  } catch (error) {
    coldClientMutationError.value =
      error instanceof Error ? error.message : String(error)
  }
}

async function confirmColdClientDependencyUpdate() {
  coldClientMutationError.value = ''
  try {
    const status = await updateColdClientMutation.mutateAsync(
      dependencyUpdateIds.value,
    )
    queryCache.setQueryData(coldClientDependenciesQueryKey, status)
    confirmingDependencyUpdate.value = false
  } catch (error) {
    coldClientMutationError.value =
      error instanceof Error ? error.message : String(error)
  }
}

async function openColdClientLoginFolder() {
  coldClientMutationError.value = ''
  try {
    await openLoginFolderMutation.mutateAsync()
  } catch (error) {
    coldClientMutationError.value =
      error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <main class="mx-auto w-full max-w-xl px-4 py-6 sm:px-8 sm:py-10">
    <h1 class="text-lg font-semibold">Settings</h1>

    <section
      class="border-border bg-card mt-6 overflow-hidden rounded-xl border"
      :aria-busy="isPending"
    >
      <div class="p-4 sm:p-5">
        <h2 class="text-sm font-medium">Show platform depots</h2>
        <div v-if="settings" class="mt-3 flex flex-wrap gap-2">
          <Label
            v-for="platform in depotPlatforms"
            :key="platform"
            :for="`platform-${platform}`"
            :class="platformClass(platform)"
          >
            <Checkbox
              :id="`platform-${platform}`"
              class="border-muted-foreground/70"
              :model-value="settings.platforms.includes(platform)"
              :disabled="updateMutation.isLoading.value"
              @update:model-value="setPlatform(platform, $event === true)"
            />
            {{ platformLabels[platform] }}
          </Label>
        </div>
        <div v-else class="mt-3 flex gap-2" aria-label="Loading platforms">
          <Skeleton class="h-9 w-24" />
          <Skeleton class="h-9 w-24" />
          <Skeleton class="h-9 w-24" />
        </div>
      </div>

      <SettingsCheckboxRow
        id="automatic-manifest-acquisition"
        label="Automatically acquire depot keys and latest manifests"
        :model-value="settingValue('automaticManifestAcquisition')"
        :disabled="updateMutation.isLoading.value"
        @update:model-value="setAutomaticManifestAcquisition"
      />
      <div class="border-border border-t p-4 sm:p-5">
        <Label for="hubcap-api-key">Hubcap API key</Label>
        <Input
          id="hubcap-api-key"
          v-model="hubcapApiKeyDraft"
          class="mt-2"
          type="password"
          autocomplete="off"
          :disabled="!settings || updateMutation.isLoading.value"
          aria-describedby="hubcap-api-key-status"
          @focus="hubcapKeyFocused = true"
          @blur="handleHubcapKeyBlur"
          @keydown.enter.prevent="saveHubcapApiKey"
        />
        <p
          id="hubcap-api-key-status"
          class="text-muted-foreground mt-1.5 text-xs"
        >
          {{ hubcapUsageText }}
        </p>
      </div>
      <SettingsCheckboxRow
        id="hide-redistributables"
        label="Hide redistributables"
        :model-value="settingValue('hideRedistributables')"
        :disabled="updateMutation.isLoading.value"
        @update:model-value="setHideRedistributables"
      />
      <SettingsCheckboxRow
        id="hide-unknown-depots"
        label="Hide unknown depots"
        :model-value="settingValue('hideUnknownDepots')"
        :disabled="updateMutation.isLoading.value"
        @update:model-value="setHideUnknownDepots"
      />
      <SettingsCheckboxRow
        id="hide-unused-depots"
        label="Hide unused depots"
        :model-value="settingValue('hideUnusedDepots')"
        :disabled="updateMutation.isLoading.value"
        @update:model-value="setHideUnusedDepots"
      />
      <SettingsCheckboxRow
        id="hide-unavailable-depots"
        label="Hide unavailable depots"
        :model-value="settingValue('hideUnavailableDepots')"
        :disabled="updateMutation.isLoading.value"
        @update:model-value="setHideUnavailableDepots"
      />
    </section>

    <section
      class="border-border bg-card mt-6 overflow-hidden rounded-xl border"
      :aria-busy="coldClientPending || coldClientBusy"
    >
      <div class="p-4 sm:p-5">
        <h2 class="text-sm font-medium">ColdClient dependencies</h2>
      </div>

      <div v-if="coldClientPending" class="border-border border-t p-4 sm:p-5">
        <div class="space-y-3" aria-label="Loading ColdClient dependencies">
          <Skeleton v-for="index in 3" :key="index" class="h-10 w-full" />
        </div>
      </div>

      <div
        v-else-if="coldClientDependencies && !coldClientDependencies.supported"
        class="border-border text-muted-foreground border-t p-4 text-sm sm:p-5"
      >
        ColdClient setup is available only in the Windows build.
      </div>

      <template v-else-if="coldClientDependencies">
        <div class="border-border divide-border divide-y border-t">
          <div
            v-for="item in coldClientDependencies.dependencies"
            :key="item.dependencyId"
            class="flex min-w-0 flex-wrap items-start justify-between gap-3 px-4 py-3 sm:flex-nowrap sm:px-5"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-sm font-medium">
                  {{ dependencyLabels[item.dependencyId] }}
                </p>
                <Tooltip v-if="item.dependencyId === 'gse'">
                  <TooltipTrigger as-child>
                    <Badge
                      as="span"
                      role="img"
                      tabindex="0"
                      :variant="
                        coldClientDependencies.loginFileExists
                          ? 'secondary'
                          : 'destructive'
                      "
                      class="gap-1"
                      :aria-label="
                        coldClientDependencies.loginFileExists
                          ? 'GSE Tools login file present'
                          : 'GSE Tools login file missing'
                      "
                    >
                      <Check
                        v-if="coldClientDependencies.loginFileExists"
                        class="size-3"
                        aria-hidden="true"
                      />
                      <X v-else class="size-3" aria-hidden="true" />
                      Login
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    Indicates whether my_login.txt is present.
                  </TooltipContent>
                </Tooltip>
              </div>
              <p
                class="text-muted-foreground mt-0.5 truncate text-xs tabular-nums"
              >
                {{ dependencyVersionText(item) }}
              </p>
              <p v-if="item.error" class="text-destructive mt-1 text-xs">
                {{ item.error }}
              </p>
            </div>
            <div class="ml-auto flex shrink-0 items-center gap-2">
              <Button
                v-if="item.dependencyId === 'gse'"
                variant="outline"
                size="sm"
                :disabled="
                  !coldClientDependencies.loginDirectory || coldClientBusy
                "
                @click="openColdClientLoginFolder"
              >
                <FolderOpen aria-hidden="true" />
                Open Folder
              </Button>
              <Badge
                :variant="
                  item.status === 'check-failed' ? 'destructive' : 'secondary'
                "
              >
                {{ dependencyStatusLabel(item) }}
              </Badge>
            </div>
          </div>
        </div>

        <div class="border-border border-t p-4 sm:p-5">
          <div class="flex flex-wrap gap-2">
            <Button
              variant="outline"
              :disabled="coldClientBusy"
              @click="checkColdClientDependencies"
            >
              <RefreshCw aria-hidden="true" />
              Check again
            </Button>
            <Button
              v-if="dependencyUpdateIds.length > 0"
              :disabled="coldClientBusy"
              @click="confirmingDependencyUpdate = true"
            >
              <Download aria-hidden="true" />
              Update dependencies
            </Button>
          </div>

          <div
            v-if="confirmingDependencyUpdate"
            class="bg-muted mt-4 rounded-lg p-3"
            role="group"
            aria-label="Confirm dependency update"
          >
            <p class="text-sm">
              Download {{ dependencyUpdateIds.length }}
              {{
                dependencyUpdateIds.length === 1
                  ? 'dependency'
                  : 'dependencies'
              }}? Game files will not change.
            </p>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button
                :disabled="coldClientBusy"
                @click="confirmColdClientDependencyUpdate"
              >
                Confirm download
              </Button>
              <Button
                variant="ghost"
                :disabled="coldClientBusy"
                @click="confirmingDependencyUpdate = false"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </template>
    </section>

    <Button
      variant="outline"
      class="mt-4"
      :disabled="openFolderMutation.isLoading.value"
      @click="openUserDataFolder"
    >
      <FolderOpen aria-hidden="true" />
      Open user data folder
    </Button>

    <p v-if="hasError" class="text-destructive mt-3 text-sm" role="alert">
      {{ errorMessage }}
    </p>
  </main>
</template>
