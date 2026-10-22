<script setup lang="ts">
import { computed } from 'vue'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { groupDownloadServers } from '@/utils/download-servers'

const props = defineProps<{ urls: string[] }>()
const groups = computed(() => groupDownloadServers(props.urls))
const endpointCount = computed(() => new Set(props.urls).size)
</script>

<template>
  <Tooltip v-if="urls.length">
    <TooltipTrigger as-child>
      <span
        class="text-muted-foreground focus-visible:ring-ring inline-flex w-fit min-w-0 cursor-help flex-wrap gap-x-2 gap-y-1 rounded-sm font-mono text-xs outline-none focus-visible:ring-2"
        tabindex="0"
        :aria-label="`Active download servers: ${endpointCount} cache ${endpointCount === 1 ? 'endpoint' : 'endpoints'}`"
      >
        <span
          v-for="(group, index) in groups"
          :key="group.key"
          class="break-all"
        >
          <span v-if="index > 0" class="mr-2" aria-hidden="true">·</span>
          {{ group.site ?? group.urls[0] }}
        </span>
      </span>
    </TooltipTrigger>
    <TooltipContent
      side="bottom"
      align="start"
      class="max-h-(--reka-tooltip-content-available-height) max-w-[calc(100vw-2rem)] overflow-y-auto text-left text-wrap"
    >
      <p class="mb-2 font-semibold">Active download servers</p>
      <ul class="space-y-2">
        <li v-for="group in groups" :key="group.key">
          <p v-if="group.site" class="mb-1 font-semibold">{{ group.site }}</p>
          <ul class="space-y-1 font-mono">
            <li v-for="url in group.urls" :key="url" class="break-all">
              {{ url }}
            </li>
          </ul>
        </li>
      </ul>
    </TooltipContent>
  </Tooltip>
</template>
