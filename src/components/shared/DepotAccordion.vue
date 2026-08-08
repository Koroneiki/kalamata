<script setup lang="ts">
import { computed } from 'vue'

import type { AppDepot, DepotGroup } from '@/types/rpc'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{ depots: AppDepot[] }>()

const groupOrder: DepotGroup[] = [
  'Base Game',
  'DLC',
  'Steamworks Common Redistributables',
  'Unused',
]

const groups = computed(() =>
  groupOrder.flatMap((name) => {
    const depots = props.depots
      .filter((depot) => depot.group === name)
      .sort((left, right) => left.depotId - right.depotId)
    return depots.length ? [{ name, depots }] : []
  }),
)

const initiallyExpanded = computed(() =>
  groups.value
    .filter(({ name }) => name === 'Base Game' || name === 'DLC')
    .map(({ name }) => name),
)

function resourceVariant(
  status: AppDepot['manifestStatus'] | AppDepot['keyStatus'],
) {
  if (status === 'ready') return 'secondary'
  if (status === 'invalid') return 'destructive'
  return 'outline'
}

function installLabel(status: AppDepot['installStatus']) {
  if (status === 'current') return 'Installed'
  if (status === 'outdated') return 'Update available'
  return null
}
</script>

<template>
  <div class="border-border overflow-hidden rounded-lg border">
    <header class="bg-muted/40 flex items-center gap-2 px-4 py-3">
      <h2 class="text-base font-semibold">Depots</h2>
      <Badge variant="secondary" class="tabular-nums">{{
        depots.length
      }}</Badge>
    </header>

    <Accordion
      v-if="groups.length"
      type="multiple"
      :default-value="initiallyExpanded"
      class="border-border border-t"
    >
      <AccordionItem
        v-for="group in groups"
        :key="group.name"
        :value="group.name"
        class="px-4 last:border-0"
      >
        <AccordionTrigger class="py-3 hover:no-underline">
          <span class="flex min-w-0 items-center gap-2">
            <span>{{ group.name }}</span>
            <Badge variant="outline" class="tabular-nums">{{
              group.depots.length
            }}</Badge>
          </span>
        </AccordionTrigger>
        <AccordionContent class="pb-2">
          <ul
            class="divide-border divide-y"
            :aria-label="`${group.name} depots`"
          >
            <li
              v-for="depot in group.depots"
              :key="depot.depotId"
              class="py-3 first:pt-1"
            >
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span class="font-medium tabular-nums"
                  >Depot {{ depot.depotId }}</span
                >
                <span class="text-muted-foreground text-xs">{{
                  depot.platform || 'All platforms'
                }}</span>
                <span class="text-muted-foreground text-xs">{{
                  depot.language || 'All languages'
                }}</span>
                <Badge
                  v-if="installLabel(depot.installStatus)"
                  variant="outline"
                >
                  {{ installLabel(depot.installStatus) }}
                </Badge>
              </div>
              <div
                v-if="depot.eligible"
                class="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs"
              >
                <span
                  class="text-muted-foreground max-w-full min-w-0 truncate font-mono"
                  :title="depot.manifestId ?? 'Unavailable'"
                >
                  Manifest {{ depot.manifestId ?? 'unavailable' }}
                </span>
                <Badge :variant="resourceVariant(depot.manifestStatus)">
                  Manifest {{ depot.manifestStatus }}
                </Badge>
                <Badge :variant="resourceVariant(depot.keyStatus)"
                  >Key {{ depot.keyStatus }}</Badge
                >
              </div>
            </li>
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
    <p v-else class="text-muted-foreground px-4 py-4 text-sm">
      No public depots are available.
    </p>
  </div>
</template>
