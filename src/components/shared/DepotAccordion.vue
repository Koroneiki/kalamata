<script setup lang="ts">
import { computed } from 'vue'
import DepotGroupAccordionItem from '@/components/shared/DepotGroupAccordionItem.vue'
import DepotRedistributablesSection from '@/components/shared/DepotRedistributablesSection.vue'
import DepotSummary from '@/components/shared/DepotSummary.vue'
import type { AppDepot, EligibleAppDepot } from '@/types/rpc'
import {
  depotsInGroup,
  installableDepotGroups,
  installableDepots,
  summarizeDepots,
} from '@/utils/depots'

import { Accordion } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'

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
  ...(['Unknown', 'Unused', 'Unavailable'] as const).flatMap((name) => {
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

function updateDepot(depotId: number, checked: boolean | 'indeterminate') {
  const next = new Set(props.selectedDepotIds)
  if (checked === true) next.add(depotId)
  else next.delete(depotId)
  emit('update:selectedDepotIds', [...next])
}

function groupSelectionState(depots: AppDepot[]): boolean | 'indeterminate' {
  // Keep installed depots enabled so users can remove or reselect unavailable content.
  const actionable = installableDepots(depots).filter(
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

function canUpdateGroup(depots: AppDepot[]) {
  return installableDepots(depots).some(
    (depot) =>
      depot.selectable ||
      depot.installStatus !== 'not-installed' ||
      selectedIds.value.has(depot.depotId),
  )
}

function updateGroup(depots: AppDepot[], checked: boolean | 'indeterminate') {
  const next = new Set(props.selectedDepotIds)

  for (const depot of installableDepots(depots)) {
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
        <DepotGroupAccordionItem
          v-for="group in depotGroups"
          :key="group.name"
          :name="group.name"
          :depots="group.depots"
          :summary="group.summary"
          :installable="group.installable"
          :selected-depot-ids="selectedIds"
          :group-selection-state="groupSelectionState(group.depots)"
          :can-update-group="canUpdateGroup(group.depots)"
          :read-only="readOnly"
          :selection-pending="selectionPending"
          :acquiring-depot-ids="acquiringDepotIds"
          :automatic-resource-acquisition="automaticResourceAcquisition"
          :custom-manifest-targets="customManifestTargets"
          @update-group="updateGroup(group.depots, $event)"
          @update-depot="updateDepot"
          @acquire-resources="emit('acquireResources', $event)"
          @edit-custom-manifest="emit('editCustomManifest', $event)"
        />
      </Accordion>
      <p v-else class="text-muted-foreground mt-4 text-sm">
        No public depots are available.
      </p>
    </section>

    <DepotRedistributablesSection
      v-if="redistributables.length"
      :depots="redistributables"
      :acquiring-depot-ids="acquiringDepotIds"
      :automatic-resource-acquisition="automaticResourceAcquisition"
      @acquire-resources="emit('acquireResources', $event)"
    />
  </div>
</template>
