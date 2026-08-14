<script setup lang="ts">
import { Minus, Plus, RefreshCw } from '@lucide/vue'
import { computed } from 'vue'

import DepotBadges from '@/components/shared/DepotBadges.vue'
import type { ApplicationOperationPreview, EligibleAppDepot } from '@/types/rpc'
import { formatBytes, formatSignedBytes } from '@/utils/bytes'

import { Badge } from '@/components/ui/badge'

type PreviewDepot = ApplicationOperationPreview['depots'][number]
type DepotAction = PreviewDepot['action']
type PreviewOverlap = ApplicationOperationPreview['overlaps'][number]

const props = defineProps<{
  item: PreviewDepot & { depot?: EligibleAppDepot }
  overlap?: PreviewOverlap
}>()

const actionClasses = {
  install:
    'border-primary/40 bg-primary/15 text-primary dark:border-ring/50 dark:bg-ring/15 dark:text-ring',
  remove: 'border-destructive/40 bg-destructive/10 text-destructive',
  update: 'border-info/40 bg-info/10 text-info',
} satisfies Record<DepotAction, string>
const actionIcons = {
  install: Plus,
  remove: Minus,
  update: RefreshCw,
} as const

const actionClass = computed(() => actionClasses[props.item.action])
const actionIcon = computed(() => actionIcons[props.item.action])
const actionLabel = computed(
  () => props.item.action[0].toUpperCase() + props.item.action.slice(1),
)
const updating = computed(() => props.item.action === 'update')
const manifestLabel = computed(() =>
  updating.value ? 'Manifest change' : 'Manifest',
)
const showCurrentSize = computed(() => props.item.action !== 'install')
const sizeDelta = computed(() =>
  formatSignedBytes(
    (
      BigInt(props.item.targetSizeBytes) - BigInt(props.item.currentSizeBytes)
    ).toString(),
  ),
)
</script>

<template>
  <li class="border-border border-t px-3 py-3">
    <div class="flex flex-wrap items-center gap-3">
      <Badge variant="outline" :class="actionClass">
        <component :is="actionIcon" class="size-3" aria-hidden="true" />
        {{ actionLabel }}
      </Badge>
      <span class="font-medium tabular-nums">
        <span class="text-muted-foreground font-normal">Depot</span>
        {{ item.depotId }}
      </span>
      <Badge v-if="overlap" variant="secondary" class="tabular-nums">
        Depot {{ overlap.overriddenByDepotIds.join(', ') }} takes priority
      </Badge>
      <DepotBadges v-if="item.depot" class="ml-auto" :depot="item.depot" />
    </div>
    <dl class="mt-3 grid gap-3 text-xs sm:grid-cols-2">
      <div class="min-w-0 sm:col-span-2">
        <dt class="text-muted-foreground">{{ manifestLabel }}</dt>
        <dd
          class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono break-all tabular-nums"
        >
          <span v-if="item.currentManifestId">{{
            item.currentManifestId
          }}</span>
          <span v-if="updating" class="text-muted-foreground" aria-hidden="true"
            >→</span
          >
          <span v-if="item.targetManifestId">{{ item.targetManifestId }}</span>
        </dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Target download size</dt>
        <dd class="mt-1 font-medium tabular-nums">
          {{ formatBytes(item.targetDownloadBytes) }}
        </dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Size on disk</dt>
        <dd
          class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-medium tabular-nums"
        >
          <template v-if="showCurrentSize">
            <span>{{ formatBytes(item.currentSizeBytes) }}</span>
            <span class="text-muted-foreground" aria-hidden="true">→</span>
          </template>
          <span>{{ formatBytes(item.targetSizeBytes) }}</span>
          <span
            v-if="showCurrentSize"
            class="text-muted-foreground font-normal"
          >
            ({{ sizeDelta }})
          </span>
        </dd>
      </div>
    </dl>
  </li>
</template>
