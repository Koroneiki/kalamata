<script setup lang="ts">
import { useMutation, useQueryCache } from '@pinia/colada'
import { ref } from 'vue'

import { updateSettings } from '@/api/settings'
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
const mutationError = ref('')

const platformLabels: Record<DepotPlatform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
}

async function persist(next: AppSettings) {
  const previous = settings.value
  mutationError.value = ''
  queryCache.setQueryData(settingsQueryKey, next)
  try {
    const saved = await updateMutation.mutateAsync(next)
    queryCache.setQueryData(settingsQueryKey, saved)
  } catch (error) {
    if (previous) queryCache.setQueryData(settingsQueryKey, previous)
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
  if (!settings.value || typeof value !== 'boolean') return
  void persist({ ...settings.value, hideRedistributables: value })
}

function setHideUnknownDepots(value: boolean | 'indeterminate') {
  if (!settings.value || typeof value !== 'boolean') return
  void persist({ ...settings.value, hideUnknownDepots: value })
}

function setHideUnusedDepots(value: boolean | 'indeterminate') {
  if (!settings.value || typeof value !== 'boolean') return
  void persist({ ...settings.value, hideUnusedDepots: value })
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
            :class="
              cn(
                'border-border hover:bg-accent/60 flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-normal transition-colors',
                settings.platforms.includes(platform) &&
                  'border-primary/40 bg-primary/10 text-foreground',
                updateMutation.isLoading.value &&
                  'pointer-events-none opacity-60',
              )
            "
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
          <Skeleton
            v-for="platform in depotPlatforms"
            :key="platform"
            class="h-9 w-24"
          />
        </div>
      </div>

      <div
        class="bg-muted/45 border-border flex items-center justify-between gap-6 border-t px-4 py-3.5 sm:px-5"
      >
        <Label for="hide-redistributables" class="text-sm">
          Hide redistributables
        </Label>
        <Skeleton v-if="!settings" class="size-4" />
        <Checkbox
          v-else
          id="hide-redistributables"
          class="border-muted-foreground/70"
          :model-value="settings.hideRedistributables"
          :disabled="updateMutation.isLoading.value"
          aria-label="Hide redistributables"
          @update:model-value="setHideRedistributables"
        />
      </div>
      <div
        class="bg-muted/45 border-border flex items-center justify-between gap-6 border-t px-4 py-3.5 sm:px-5"
      >
        <Label for="hide-unknown-depots" class="text-sm">
          Hide unknown depots
        </Label>
        <Skeleton v-if="!settings" class="size-4" />
        <Checkbox
          v-else
          id="hide-unknown-depots"
          class="border-muted-foreground/70"
          :model-value="settings.hideUnknownDepots"
          :disabled="updateMutation.isLoading.value"
          aria-label="Hide unknown depots"
          @update:model-value="setHideUnknownDepots"
        />
      </div>
      <div
        class="bg-muted/45 border-border flex items-center justify-between gap-6 border-t px-4 py-3.5 sm:px-5"
      >
        <Label for="hide-unused-depots" class="text-sm">
          Hide unused depots
        </Label>
        <Skeleton v-if="!settings" class="size-4" />
        <Checkbox
          v-else
          id="hide-unused-depots"
          class="border-muted-foreground/70"
          :model-value="settings.hideUnusedDepots"
          :disabled="updateMutation.isLoading.value"
          aria-label="Hide unused depots"
          @update:model-value="setHideUnusedDepots"
        />
      </div>
    </section>

    <p
      v-if="error || mutationError"
      class="text-destructive mt-3 text-sm"
      role="alert"
    >
      {{ mutationError || error?.message }}
    </p>
  </main>
</template>
