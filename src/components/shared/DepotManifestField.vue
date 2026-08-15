<script setup lang="ts">
import { computed } from 'vue'
import { Pin } from '@lucide/vue'

import DepotResourceAction from '@/components/shared/DepotResourceAction.vue'
import type { AppDepot, EligibleAppDepot } from '@/types/rpc'

const props = defineProps<{
  depot: AppDepot
  readOnly?: boolean
  selectionPending?: boolean
  acquiring?: boolean
  automatic?: boolean
  customManifestTargets?: ReadonlyMap<number, string>
}>()

const emit = defineEmits<{
  acquireResources: []
  editCustomManifest: [depot: EligibleAppDepot]
}>()

const displayedManifestId = computed(
  () =>
    props.customManifestTargets?.get(props.depot.depotId) ??
    props.depot.installedManifestId ??
    props.depot.manifestId,
)
const isLatestManifest = computed(
  () => displayedManifestId.value === props.depot.manifestId,
)
const isDisplayedManifestPinned = computed(
  () =>
    props.customManifestTargets?.has(props.depot.depotId) || props.depot.pinned,
)
const editable = computed(() => props.depot.eligible && !props.readOnly)
const manifestLabel = computed(() =>
  isLatestManifest.value ? 'Latest manifest GID' : 'Manifest GID',
)
const manifestId = computed(() => displayedManifestId.value ?? 'Unavailable')
const acquiring = computed(() => props.acquiring ?? false)
const automatic = computed(() => props.automatic ?? false)

function editCustomManifest() {
  if (props.depot.eligible) emit('editCustomManifest', props.depot)
}
</script>

<template>
  <div class="min-w-0">
    <button
      v-if="editable"
      class="hover:bg-accent/50 focus-visible:ring-ring -m-2 flex w-[calc(100%+1rem)] min-w-0 flex-col items-start gap-1 rounded-md p-2 text-left focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      type="button"
      :disabled="selectionPending"
      :aria-label="`Change manifest GID for depot ${depot.depotId}`"
      @click="editCustomManifest"
    >
      <span class="text-muted-foreground text-xs">
        {{ manifestLabel }}
      </span>
      <span
        class="flex min-w-0 items-center gap-1.5 font-mono text-sm break-all"
      >
        <span>{{ manifestId }}</span>
        <Pin
          v-if="isDisplayedManifestPinned"
          class="text-primary size-4 shrink-0"
          aria-label="Manifest pinned"
        />
      </span>
    </button>
    <dl v-else class="space-y-1">
      <dt class="text-muted-foreground text-xs">
        {{ manifestLabel }}
      </dt>
      <dd class="min-w-0 font-mono text-sm break-all">
        {{ manifestId }}
      </dd>
    </dl>
    <div class="mt-1 flex min-w-0 items-center gap-2">
      <DepotResourceAction
        :depot="depot"
        :acquiring="acquiring"
        :automatic="automatic"
        @acquire="$emit('acquireResources')"
      />
    </div>
  </div>
</template>
