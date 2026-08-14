<script setup lang="ts">
import { computed } from 'vue'

import DownloadDepotChangeRow from '@/components/forms/DownloadDepotChangeRow.vue'
import DepotGroupHeading from '@/components/shared/DepotGroupHeading.vue'
import type { ApplicationOperationPreview, EligibleAppDepot } from '@/types/rpc'
import { installableDepotGroups } from '@/utils/depots'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{
  preview: ApplicationOperationPreview | null
  visibleDepots: ReadonlyMap<number, EligibleAppDepot>
  hasPlannedChanges: boolean
}>()

const changeRows = computed(() =>
  (props.preview?.depots ?? []).map((item) => ({
    ...item,
    depot: props.visibleDepots.get(item.depotId),
  })),
)
const overlapByDepotId = computed(
  () => new Map(props.preview?.overlaps.map((item) => [item.depotId, item])),
)
const depotGroups = computed(() =>
  installableDepotGroups.flatMap((name) => {
    const depots = changeRows.value.filter((item) => item.depot?.group === name)
    return depots.length ? [{ name, depots }] : []
  }),
)
const countSummary = computed(() =>
  props.preview && changeRows.value.length
    ? depotCountSummary(props.preview)
    : '',
)
const showNoChanges = computed(
  () => props.preview !== null && !props.hasPlannedChanges,
)

function depotCountSummary(value: ApplicationOperationPreview) {
  const parts = [
    [value.counts.install, 'install'],
    [value.counts.update, 'update'],
    [value.counts.remove, 'removal'],
  ] as const
  return parts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`)
    .join(' · ')
}
</script>

<template>
  <section class="min-w-0" aria-labelledby="selected-depots-title">
    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <div class="flex items-center gap-2">
        <h3 id="selected-depots-title" class="text-sm font-medium">
          Depot changes
        </h3>
        <Badge variant="secondary" class="tabular-nums">
          {{ changeRows.length }}
        </Badge>
      </div>
      <p v-if="countSummary" class="text-muted-foreground text-xs tabular-nums">
        {{ countSummary }}
      </p>
    </header>
    <Accordion v-if="depotGroups.length" type="multiple" class="mt-2 space-y-2">
      <AccordionItem
        v-for="group in depotGroups"
        :key="group.name"
        :value="group.name"
        class="border-border overflow-hidden rounded-lg border last:border-b"
      >
        <AccordionTrigger
          class="hover:bg-accent/50 rounded-none px-3 py-2.5 hover:no-underline"
        >
          <DepotGroupHeading :name="group.name" :count="group.depots.length" />
        </AccordionTrigger>
        <AccordionContent class="pb-0">
          <ul :aria-label="`${group.name} depot changes`">
            <DownloadDepotChangeRow
              v-for="item in group.depots"
              :key="item.depotId"
              :item="item"
              :overlap="overlapByDepotId.get(item.depotId)"
            />
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>

    <p
      v-if="showNoChanges"
      class="bg-muted/40 mt-2 rounded-lg border px-4 py-5 text-sm"
      role="status"
    >
      Everything is already up to date. No operation is needed.
    </p>
  </section>
</template>
