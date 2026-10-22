<script setup lang="ts">
import { Check, Clock3, FileText, KeyRound, Minus, X } from '@lucide/vue'
import { computed } from 'vue'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { EligibleAppDepot } from '@/types/rpc'

const props = defineProps<{ depot: EligibleAppDepot }>()

const states = {
  ready: { label: 'Available', icon: Check, class: 'text-success' },
  missing: { label: 'Missing', icon: Minus, class: 'text-muted-foreground' },
  invalid: { label: 'Invalid', icon: X, class: 'text-destructive' },
  outdated: { label: 'Outdated', icon: Clock3, class: 'text-info' },
}

const resources = computed(() => [
  {
    label: 'Depot key',
    icon: KeyRound,
    state:
      states[
        props.depot.keyStatus === 'present' ? 'ready' : props.depot.keyStatus
      ],
  },
  {
    label: 'Manifest',
    icon: FileText,
    state: states[props.depot.manifestStatus],
  },
])
</script>

<template>
  <div class="flex shrink-0 items-center gap-1">
    <Tooltip v-for="resource in resources" :key="resource.label">
      <TooltipTrigger as-child>
        <span
          class="focus-visible:ring-ring relative inline-flex size-7 shrink-0 cursor-help items-center justify-center rounded-sm outline-none focus-visible:ring-2"
          :class="resource.state.class"
          tabindex="0"
          role="img"
          :aria-label="`${resource.label}: ${resource.state.label}`"
        >
          <component :is="resource.icon" class="size-4.5" aria-hidden="true" />
          <!-- Keep a shape cue so availability never relies on colour alone. -->
          <component
            :is="resource.state.icon"
            class="bg-card absolute right-0 bottom-0 size-3.5 rounded-full p-px"
            :stroke-width="3"
            aria-hidden="true"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent
        >{{ resource.label }}: {{ resource.state.label }}</TooltipContent
      >
    </Tooltip>
  </div>
</template>
