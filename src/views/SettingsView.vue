<script setup lang="ts">
import { useMutation, useQueryCache } from '@pinia/colada'
import { FolderOpen } from '@lucide/vue'
import { computed, ref } from 'vue'

import {
  openUserDataFolder as requestOpenUserDataFolder,
  updateSettings,
} from '@/api/settings'
import SettingsCheckboxRow from '@/components/forms/SettingsCheckboxRow.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { settingsQueryKey, useSettingsQuery } from '@/composables/queries'
import { cn } from '@/lib/utils'
import type { AppSettings, DepotPlatform } from '@/types/rpc'
import { depotPlatforms } from '@/utils/depots'

const queryCache = useQueryCache()
const { data: settings, error, isPending } = useSettingsQuery()
const updateMutation = useMutation({ mutation: updateSettings })
const openFolderMutation = useMutation({ mutation: requestOpenUserDataFolder })
const mutationError = ref('')
const hasError = computed(() => Boolean(error.value || mutationError.value))
const errorMessage = computed(() => mutationError.value || error.value?.message)

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
  } catch (error) {
    if (optimistic && previous)
      queryCache.setQueryData(settingsQueryKey, previous)
    mutationError.value = error instanceof Error ? error.message : String(error)
  }
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

async function openUserDataFolder() {
  mutationError.value = ''
  try {
    await openFolderMutation.mutateAsync()
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : String(error)
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
