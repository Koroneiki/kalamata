<script setup lang="ts">
import type { AppDepot } from '@/types/rpc'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'

defineProps<{ depots: AppDepot[] }>()

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
  <Accordion type="single" collapsible class="border-border border-y">
    <AccordionItem value="depots" class="border-0">
      <AccordionTrigger class="py-3 hover:no-underline">
        <span class="flex items-center gap-2">
          <span class="text-base font-semibold">Depots</span>
          <Badge variant="secondary" class="tabular-nums">{{
            depots.length
          }}</Badge>
        </span>
      </AccordionTrigger>
      <AccordionContent class="pb-2">
        <p
          v-if="depots.length === 0"
          class="text-muted-foreground py-4 text-sm"
        >
          No public depots are available.
        </p>
        <ul v-else class="divide-border divide-y" aria-label="Public depots">
          <li v-for="depot in depots" :key="depot.depotId" class="py-3">
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
              <Badge v-if="installLabel(depot.installStatus)" variant="outline">
                {{ installLabel(depot.installStatus) }}
              </Badge>
            </div>
            <div class="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs">
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
</template>
