<script setup lang="ts">
import { computed } from 'vue'
import { Download, LoaderCircle, Pin } from '@lucide/vue'

import DepotBadges from '@/components/shared/DepotBadges.vue'
import DepotSummary from '@/components/shared/DepotSummary.vue'
import type { AppDepot, EligibleAppDepot } from '@/types/rpc'
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
import { Checkbox } from '@/components/ui/checkbox'

const props = defineProps<{
  depots: AppDepot[]
  selectedDepotIds: number[]
  readOnly?: boolean
  selectionPending?: boolean
  acquiringDepotIds?: number[]
  automaticResourceAcquisition?: boolean
  customManifestTargets?: ReadonlyMap<number, string>
}>()

const emit = defineEmits<{
  'update:selectedDepotIds': [value: number[]]
  acquireResources: [depot: AppDepot]
  editCustomManifest: [depot: EligibleAppDepot]
}>()

const selectedIds = computed(() => new Set(props.selectedDepotIds))
const depotGroups = computed(() => [
  ...installableDepotGroups.flatMap((name) => {
    const depots = depotsInGroup(props.depots, name)
    return depots.length
      ? [
          {
            name,
            depots,
            summary: summarizeDepots(depots, selectedIds.value),
            installable: true as const,
          },
        ]
      : []
  }),
  ...(['Unknown', 'Unused'] as const).flatMap((name) => {
    const depots = props.depots.filter((depot) => depot.group === name)
    return depots.length
      ? [{ name, depots, summary: null, installable: false as const }]
      : []
  }),
])
const allInstallableDepots = computed(() => installableDepots(props.depots))
const depotSummary = computed(() =>
  summarizeDepots(allInstallableDepots.value, selectedIds.value),
)
const redistributables = computed(() =>
  props.depots
    .filter((depot) => depot.group === 'Steamworks Common Redistributables')
    .sort((left, right) => left.depotId - right.depotId),
)

function formattedBytes(value: string | null) {
  return value ? formatBytes(value) : 'Unavailable'
}

function canAcquireResources(depot: AppDepot) {
  return (
    depot.manifestId !== null &&
    (!depot.eligible ||
      depot.manifestStatus !== 'ready' ||
      depot.keyStatus !== 'present')
  )
}

function displayedManifestId(depot: AppDepot) {
  return (
    props.customManifestTargets?.get(depot.depotId) ??
    depot.installedManifestId ??
    depot.manifestId
  )
}

function isLatestManifest(depot: AppDepot) {
  return displayedManifestId(depot) === depot.manifestId
}

function isDisplayedManifestPinned(depot: AppDepot) {
  return props.customManifestTargets?.has(depot.depotId) || depot.pinned
}

function updateDepot(depotId: number, checked: boolean | 'indeterminate') {
  const next = new Set(props.selectedDepotIds)
  if (checked === true) next.add(depotId)
  else next.delete(depotId)
  emit('update:selectedDepotIds', [...next])
}

function groupSelectionState(
  depots: EligibleAppDepot[],
): boolean | 'indeterminate' {
  // Installed depots stay actionable so unavailable content can still be removed or reselected.
  const actionable = depots.filter(
    (depot) =>
      depot.selectable ||
      depot.installStatus !== 'not-installed' ||
      selectedIds.value.has(depot.depotId),
  )
  const selected = actionable.filter((depot) =>
    selectedIds.value.has(depot.depotId),
  )

  if (selected.length === 0) return false
  return selected.length === actionable.length ? true : 'indeterminate'
}

function canUpdateGroup(depots: EligibleAppDepot[]) {
  return depots.some(
    (depot) =>
      depot.selectable ||
      depot.installStatus !== 'not-installed' ||
      selectedIds.value.has(depot.depotId),
  )
}

function updateGroup(
  depots: EligibleAppDepot[],
  checked: boolean | 'indeterminate',
) {
  const next = new Set(props.selectedDepotIds)

  for (const depot of depots) {
    if (
      checked === true &&
      (depot.selectable || depot.installStatus !== 'not-installed')
    )
      next.add(depot.depotId)
    else if (checked !== true) next.delete(depot.depotId)
  }

  emit('update:selectedDepotIds', [...next])
}
</script>

<template>
  <div class="space-y-6">
    <section class="border-border rounded-lg border p-4">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <h2 class="text-base font-semibold">Depots</h2>
          <Badge variant="secondary" class="tabular-nums">
            {{ allInstallableDepots.length }}
          </Badge>
        </div>
        <DepotSummary :summary="depotSummary" :show-missing="false" />
      </header>

      <Accordion
        v-if="depotGroups.length"
        type="multiple"
        class="mt-4 space-y-3"
      >
        <AccordionItem
          v-for="group in depotGroups"
          :key="group.name"
          :value="group.name"
          class="border-border relative overflow-hidden rounded-lg border last:border-b"
        >
          <Checkbox
            v-if="!readOnly && group.installable"
            class="absolute top-3.5 left-4 z-10"
            :model-value="groupSelectionState(group.depots)"
            :disabled="selectionPending || !canUpdateGroup(group.depots)"
            :aria-label="`Select all ${group.name} depots`"
            @update:model-value="updateGroup(group.depots, $event)"
          />
          <AccordionTrigger
            class="hover:bg-accent/50 rounded-none py-3 pr-4 hover:no-underline"
            :class="readOnly || !group.installable ? 'pl-4' : 'pl-11'"
          >
            <span
              class="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 pr-2"
            >
              <span class="flex items-center gap-2">
                <span>{{ group.name }}</span>
                <Badge variant="outline" class="tabular-nums">
                  {{ group.depots.length }}
                </Badge>
              </span>
              <DepotSummary v-if="group.summary" :summary="group.summary" />
            </span>
          </AccordionTrigger>
          <AccordionContent class="pb-0">
            <ul :aria-label="`${group.name} depots`">
              <li
                v-for="depot in group.depots"
                :key="depot.depotId"
                class="border-border flex gap-3 border-t px-4 py-4"
                :class="{
                  'opacity-65':
                    !depot.selectable && !selectedIds.has(depot.depotId),
                }"
              >
                <Checkbox
                  v-if="!readOnly && depot.eligible"
                  class="mt-1"
                  :model-value="selectedIds.has(depot.depotId)"
                  :disabled="
                    selectionPending ||
                    (!depot.selectable &&
                      depot.installStatus === 'not-installed' &&
                      !selectedIds.has(depot.depotId))
                  "
                  :aria-label="`Select depot ${depot.depotId}`"
                  @update:model-value="updateDepot(depot.depotId, $event)"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <p class="flex items-center gap-1 font-medium tabular-nums">
                      <span class="text-muted-foreground">ID</span>
                      <span>{{ depot.depotId }}</span>
                      <template v-if="depot.ownerAppName">
                        <span aria-hidden="true">·</span>
                        <span>{{ depot.ownerAppName }}</span>
                      </template>
                    </p>
                    <DepotBadges :depot="depot" />
                  </div>

                  <dl class="mt-4 grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-3">
                    <div class="min-w-0">
                      <button
                        v-if="depot.eligible && !readOnly"
                        class="hover:bg-accent/50 focus-visible:ring-ring -m-2 flex w-[calc(100%+1rem)] min-w-0 flex-col items-start gap-1 rounded-md p-2 text-left focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                        type="button"
                        :disabled="selectionPending"
                        :aria-label="`Change manifest GID for depot ${depot.depotId}`"
                        @click="emit('editCustomManifest', depot)"
                      >
                        <span class="text-muted-foreground text-xs">
                          {{
                            isLatestManifest(depot)
                              ? 'Latest Manifest GID'
                              : 'Manifest GID'
                          }}
                        </span>
                        <span
                          class="flex min-w-0 items-center gap-1.5 font-mono text-sm break-all"
                        >
                          <span>
                            {{ displayedManifestId(depot) ?? 'Unavailable' }}
                          </span>
                          <Pin
                            v-if="isDisplayedManifestPinned(depot)"
                            class="text-primary size-4 shrink-0"
                            aria-label="Manifest pinned"
                          />
                        </span>
                      </button>
                      <dl v-else class="space-y-1">
                        <dt class="text-muted-foreground text-xs">
                          {{
                            isLatestManifest(depot)
                              ? 'Latest Manifest GID'
                              : 'Manifest GID'
                          }}
                        </dt>
                        <dd class="min-w-0 font-mono text-sm break-all">
                          {{ displayedManifestId(depot) ?? 'Unavailable' }}
                        </dd>
                      </dl>
                      <div class="mt-1 flex min-w-0 items-center gap-2">
                        <Button
                          v-if="
                            canAcquireResources(depot) &&
                            !automaticResourceAcquisition
                          "
                          size="icon-xs"
                          variant="outline"
                          type="button"
                          :disabled="acquiringDepotIds?.includes(depot.depotId)"
                          :aria-label="`Get resources for depot ${depot.depotId}`"
                          @click="emit('acquireResources', depot)"
                        >
                          <LoaderCircle
                            v-if="acquiringDepotIds?.includes(depot.depotId)"
                            class="animate-spin"
                            aria-hidden="true"
                          />
                          <Download v-else aria-hidden="true" />
                        </Button>
                        <LoaderCircle
                          v-else-if="
                            canAcquireResources(depot) &&
                            acquiringDepotIds?.includes(depot.depotId)
                          "
                          class="size-4 animate-spin"
                          aria-label="Acquiring manifest"
                        />
                      </div>
                    </div>
                    <div class="space-y-1">
                      <dt class="text-muted-foreground text-xs">
                        Download Size
                      </dt>
                      <dd class="text-sm font-medium tabular-nums">
                        {{ formattedBytes(depot.downloadBytes) }}
                      </dd>
                    </div>
                    <div class="space-y-1">
                      <dt class="text-muted-foreground text-xs">
                        Size on Disk
                      </dt>
                      <dd class="text-sm font-medium tabular-nums">
                        {{ formattedBytes(depot.sizeBytes) }}
                      </dd>
                    </div>
                  </dl>
                </div>
              </li>
            </ul>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <p v-else class="text-muted-foreground mt-4 text-sm">
        No public depots are available.
      </p>
    </section>

    <section
      v-if="redistributables.length"
      class="border-border rounded-lg border p-4"
    >
      <Accordion type="single" collapsible>
        <AccordionItem
          value="Steamworks Common Redistributables"
          class="border-b-0"
        >
          <AccordionTrigger class="py-0 hover:no-underline">
            <span class="flex min-w-0 items-center gap-2">
              <span class="text-base font-semibold">
                Steamworks Common Redistributables
              </span>
              <Badge variant="secondary" class="tabular-nums">
                {{ redistributables.length }}
              </Badge>
            </span>
          </AccordionTrigger>
          <AccordionContent class="pb-0">
            <ul
              class="border-border mt-4 overflow-hidden rounded-lg border"
              aria-label="Steamworks Common Redistributables depots"
            >
              <li
                v-for="depot in redistributables"
                :key="depot.depotId"
                class="border-border border-b px-4 py-4 last:border-b-0"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <p class="font-medium tabular-nums">
                    <span class="text-muted-foreground">ID</span>
                    {{ depot.depotId }}
                  </p>
                  <DepotBadges :depot="depot" />
                </div>

                <dl class="mt-4 grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-3">
                  <div class="min-w-0 space-y-1">
                    <dt class="text-muted-foreground text-xs">
                      Latest Manifest GID
                    </dt>
                    <dd class="flex min-w-0 items-center gap-2">
                      <span class="min-w-0 font-mono text-sm break-all">
                        {{ depot.manifestId ?? 'Unavailable' }}
                      </span>
                      <Button
                        v-if="
                          canAcquireResources(depot) &&
                          !automaticResourceAcquisition
                        "
                        size="icon-xs"
                        variant="outline"
                        type="button"
                        :disabled="acquiringDepotIds?.includes(depot.depotId)"
                        :aria-label="`Get resources for depot ${depot.depotId}`"
                        @click="emit('acquireResources', depot)"
                      >
                        <LoaderCircle
                          v-if="acquiringDepotIds?.includes(depot.depotId)"
                          class="animate-spin"
                          aria-hidden="true"
                        />
                        <Download v-else aria-hidden="true" />
                      </Button>
                      <LoaderCircle
                        v-else-if="
                          canAcquireResources(depot) &&
                          acquiringDepotIds?.includes(depot.depotId)
                        "
                        class="size-4 animate-spin"
                        aria-label="Acquiring manifest"
                      />
                    </dd>
                  </div>
                  <div class="space-y-1">
                    <dt class="text-muted-foreground text-xs">Download Size</dt>
                    <dd class="text-sm font-medium tabular-nums">
                      {{ formattedBytes(depot.downloadBytes) }}
                    </dd>
                  </div>
                  <div class="space-y-1">
                    <dt class="text-muted-foreground text-xs">Size on Disk</dt>
                    <dd class="text-sm font-medium tabular-nums">
                      {{ formattedBytes(depot.sizeBytes) }}
                    </dd>
                  </div>
                </dl>
              </li>
            </ul>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  </div>
</template>
