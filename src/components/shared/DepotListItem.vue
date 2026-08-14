<script setup lang="ts">
import { computed } from 'vue'

import DepotBadges from '@/components/shared/DepotBadges.vue'
import DepotManifestField from '@/components/shared/DepotManifestField.vue'
import DepotSizeFields from '@/components/shared/DepotSizeFields.vue'
import type { AppDepot, EligibleAppDepot } from '@/types/rpc'

import { Checkbox } from '@/components/ui/checkbox'

const props = defineProps<{
  depot: AppDepot
  selected: boolean
  readOnly?: boolean
  selectionPending?: boolean
  acquiring?: boolean
  automatic?: boolean
  customManifestTargets?: ReadonlyMap<number, string>
}>()

defineEmits<{
  updateSelected: [checked: boolean | 'indeterminate']
  acquireResources: []
  editCustomManifest: [depot: EligibleAppDepot]
}>()

const selectionDisabled = computed(
  () =>
    props.selectionPending ||
    (!props.depot.selectable &&
      props.depot.installStatus === 'not-installed' &&
      !props.selected),
)
const dimmed = computed(() => !props.depot.selectable && !props.selected)
const showSelection = computed(() => !props.readOnly && props.depot.eligible)
</script>

<template>
  <li
    class="border-border flex gap-3 border-t px-4 py-4"
    :class="{ 'opacity-65': dimmed }"
  >
    <Checkbox
      v-if="showSelection"
      class="mt-1"
      :model-value="selected"
      :disabled="selectionDisabled"
      :aria-label="`Select depot ${depot.depotId}`"
      @update:model-value="$emit('updateSelected', $event)"
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
        <DepotManifestField
          :depot="depot"
          :read-only="readOnly"
          :selection-pending="selectionPending"
          :acquiring="acquiring"
          :automatic="automatic"
          :custom-manifest-targets="customManifestTargets"
          @acquire-resources="$emit('acquireResources')"
          @edit-custom-manifest="$emit('editCustomManifest', $event)"
        />
        <DepotSizeFields
          :download-bytes="depot.downloadBytes"
          :size-bytes="depot.sizeBytes"
        />
      </dl>
    </div>
  </li>
</template>
