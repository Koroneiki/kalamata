<script setup lang="ts">
import { computed } from 'vue'

import type { AppDepot, DepotGroup } from '@/types/rpc'
import { formatBytes } from '@/utils/bytes'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{ depots: AppDepot[] }>()

const depotGroupOrder: DepotGroup[] = ['Base Game', 'DLC', 'Unused']

const depotGroups = computed(() =>
  depotGroupOrder.flatMap((name) => {
    const depots = props.depots
      .filter((depot) => depot.group === name)
      .sort((left, right) => left.depotId - right.depotId)
    return depots.length ? [{ name, depots }] : []
  }),
)

const redistributables = computed(() =>
  props.depots
    .filter((depot) => depot.group === 'Steamworks Common Redistributables')
    .sort((left, right) => left.depotId - right.depotId),
)

const depotCount = computed(() =>
  depotGroups.value.reduce((count, group) => count + group.depots.length, 0),
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

function manifestLabel(status: NonNullable<AppDepot['manifestStatus']>) {
  return `Manifest ${status}`
}

function platforms(platform: string | null) {
  if (!platform) return []
  return platform
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function formattedBytes(value: string | null) {
  return value ? formatBytes(value) : 'Unavailable'
}
</script>

<template>
  <div class="space-y-6">
    <section class="border-border rounded-lg border p-4">
      <header class="flex items-center gap-2">
        <h2 class="text-base font-semibold">Depots</h2>
        <Badge variant="secondary" class="tabular-nums">{{ depotCount }}</Badge>
      </header>

      <Accordion
        v-if="depotGroups.length"
        type="multiple"
        :default-value="['Base Game', 'DLC']"
        class="mt-4 space-y-3"
      >
        <AccordionItem
          v-for="group in depotGroups"
          :key="group.name"
          :value="group.name"
          class="border-border overflow-hidden rounded-lg border last:border-b"
        >
          <AccordionTrigger
            class="hover:bg-accent/50 rounded-none px-4 py-3 hover:no-underline"
          >
            <span class="flex min-w-0 items-center gap-2">
              <span>{{ group.name }}</span>
              <Badge variant="outline" class="tabular-nums">{{
                group.depots.length
              }}</Badge>
            </span>
          </AccordionTrigger>
          <AccordionContent class="pb-0">
            <ul :aria-label="`${group.name} depots`">
              <li
                v-for="depot in group.depots"
                :key="depot.depotId"
                class="border-border border-t px-4 py-4"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0 space-y-2">
                    <p class="font-medium tabular-nums">
                      <span class="text-muted-foreground">ID</span>
                      {{ depot.depotId }}
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <Badge
                        v-for="platform in platforms(depot.platform)"
                        :key="platform"
                        variant="outline"
                      >
                        {{ platform }}
                      </Badge>
                      <Badge v-if="depot.language" variant="outline">
                        {{ depot.language }}
                      </Badge>
                    </div>
                  </div>

                  <div
                    v-if="depot.eligible"
                    class="flex max-w-full flex-wrap justify-end gap-2"
                  >
                    <Badge :variant="resourceVariant(depot.manifestStatus)">
                      {{ manifestLabel(depot.manifestStatus) }}
                    </Badge>
                    <Badge :variant="resourceVariant(depot.keyStatus)">
                      Key {{ depot.keyStatus }}
                    </Badge>
                    <Badge
                      v-if="installLabel(depot.installStatus)"
                      variant="outline"
                    >
                      {{ installLabel(depot.installStatus) }}
                    </Badge>
                  </div>
                </div>

                <dl class="mt-4 grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-3">
                  <div class="min-w-0 space-y-1">
                    <dt class="text-muted-foreground text-xs">
                      Latest Manifest GID
                    </dt>
                    <dd class="font-mono text-sm break-all">
                      {{ depot.manifestId ?? 'Unavailable' }}
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
                <div class="min-w-0 space-y-2">
                  <p class="font-medium tabular-nums">
                    <span class="text-muted-foreground">ID</span>
                    {{ depot.depotId }}
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <Badge
                      v-for="platform in platforms(depot.platform)"
                      :key="platform"
                      variant="outline"
                    >
                      {{ platform }}
                    </Badge>
                    <Badge v-if="depot.language" variant="outline">
                      {{ depot.language }}
                    </Badge>
                  </div>
                </div>

                <dl class="mt-4 grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-3">
                  <div class="min-w-0 space-y-1">
                    <dt class="text-muted-foreground text-xs">
                      Latest Manifest GID
                    </dt>
                    <dd class="font-mono text-sm break-all">
                      {{ depot.manifestId ?? 'Unavailable' }}
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
