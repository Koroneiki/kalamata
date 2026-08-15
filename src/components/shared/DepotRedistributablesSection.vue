<script setup lang="ts">
import { computed } from 'vue'

import DepotBadges from '@/components/shared/DepotBadges.vue'
import DepotResourceAction from '@/components/shared/DepotResourceAction.vue'
import DepotSizeFields from '@/components/shared/DepotSizeFields.vue'
import type { AppDepot } from '@/types/rpc'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{
  depots: AppDepot[]
  acquiringDepotIds?: number[]
  automaticResourceAcquisition?: boolean
}>()

defineEmits<{ acquireResources: [depot: AppDepot] }>()

const automaticResourceAcquisition = computed(
  () => props.automaticResourceAcquisition ?? false,
)

function manifestId(depot: AppDepot) {
  return depot.manifestId ?? 'Unavailable'
}

function isAcquiring(depotId: number) {
  return props.acquiringDepotIds?.includes(depotId) ?? false
}
</script>

<template>
  <section class="border-border rounded-lg border p-4">
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
              {{ depots.length }}
            </Badge>
          </span>
        </AccordionTrigger>
        <AccordionContent class="pb-0">
          <ul
            class="border-border mt-4 overflow-hidden rounded-lg border"
            aria-label="Steamworks Common Redistributables depots"
          >
            <li
              v-for="depot in depots"
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
                    Latest manifest GID
                  </dt>
                  <dd class="flex min-w-0 items-center gap-2">
                    <span class="min-w-0 font-mono text-sm break-all">
                      {{ manifestId(depot) }}
                    </span>
                    <DepotResourceAction
                      :depot="depot"
                      :acquiring="isAcquiring(depot.depotId)"
                      :automatic="automaticResourceAcquisition"
                      @acquire="$emit('acquireResources', depot)"
                    />
                  </dd>
                </div>
                <DepotSizeFields
                  :download-bytes="depot.downloadBytes"
                  :size-bytes="depot.sizeBytes"
                />
              </dl>
            </li>
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </section>
</template>
