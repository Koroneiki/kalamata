<script setup lang="ts">
import { computed } from 'vue'

import DepotGroupHeading from '@/components/shared/DepotGroupHeading.vue'
import DepotListItem from '@/components/shared/DepotListItem.vue'
import DepotSummary from '@/components/shared/DepotSummary.vue'
import type { AppDepot, EligibleAppDepot } from '@/types/rpc'
import type { DepotSelectionSummary } from '@/utils/depots'

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Checkbox } from '@/components/ui/checkbox'

const props = defineProps<{
  name: string
  depots: AppDepot[]
  summary: DepotSelectionSummary | null
  installable: boolean
  selectedDepotIds: ReadonlySet<number>
  groupSelectionState: boolean | 'indeterminate'
  canUpdateGroup: boolean
  readOnly?: boolean
  selectionPending?: boolean
  acquiringDepotIds?: number[]
  automaticResourceAcquisition?: boolean
  customManifestTargets?: ReadonlyMap<number, string>
}>()

defineEmits<{
  updateGroup: [checked: boolean | 'indeterminate']
  updateDepot: [depotId: number, checked: boolean | 'indeterminate']
  acquireResources: [depot: AppDepot]
  editCustomManifest: [depot: EligibleAppDepot]
}>()

const showGroupSelection = computed(() => !props.readOnly && props.installable)
const groupSelectionDisabled = computed(
  () => props.selectionPending || !props.canUpdateGroup,
)
const triggerPadding = computed(() =>
  props.readOnly || !props.installable ? 'pl-4' : 'pl-11',
)
const automaticResourceAcquisition = computed(
  () => props.automaticResourceAcquisition ?? false,
)

function isAcquiring(depotId: number) {
  return props.acquiringDepotIds?.includes(depotId) ?? false
}
</script>

<template>
  <AccordionItem
    :value="name"
    class="border-border relative overflow-hidden rounded-lg border last:border-b"
  >
    <Checkbox
      v-if="showGroupSelection"
      class="absolute top-3.5 left-4 z-10"
      :model-value="groupSelectionState"
      :disabled="groupSelectionDisabled"
      :aria-label="`Select all ${name} depots`"
      @update:model-value="$emit('updateGroup', $event)"
    />
    <AccordionTrigger
      class="hover:bg-accent/50 rounded-none py-3 pr-4 hover:no-underline"
      :class="triggerPadding"
    >
      <DepotGroupHeading :name="name" :count="depots.length">
        <DepotSummary v-if="summary" :summary="summary" />
      </DepotGroupHeading>
    </AccordionTrigger>
    <AccordionContent class="pb-0">
      <ul :aria-label="`${name} depots`">
        <DepotListItem
          v-for="depot in depots"
          :key="depot.depotId"
          :depot="depot"
          :selected="selectedDepotIds.has(depot.depotId)"
          :read-only="readOnly"
          :selection-pending="selectionPending"
          :acquiring="isAcquiring(depot.depotId)"
          :automatic="automaticResourceAcquisition"
          :custom-manifest-targets="customManifestTargets"
          @update-selected="$emit('updateDepot', depot.depotId, $event)"
          @acquire-resources="$emit('acquireResources', depot)"
          @edit-custom-manifest="$emit('editCustomManifest', $event)"
        />
      </ul>
    </AccordionContent>
  </AccordionItem>
</template>
