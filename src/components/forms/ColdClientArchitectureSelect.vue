<script setup lang="ts">
import { computed } from 'vue'

import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ColdClientLoaderArchitecture } from '@/types/cold-client'

const props = defineProps<{
  id: string
  placeholder: string
  options: Array<{
    value: string
    architecture: ColdClientLoaderArchitecture | null
  }>
}>()
const model = defineModel<string>({ required: true })
const selected = computed(() =>
  props.options.find(({ value }) => value === model.value),
)
const architectureLabel = (architecture: ColdClientLoaderArchitecture) =>
  architecture === 'x86' ? '32-bit' : '64-bit'
</script>

<template>
  <Select v-model="model">
    <SelectTrigger :id="id" class="w-full">
      <SelectValue
        :aria-label="model || placeholder"
        :placeholder="placeholder"
      >
        <span
          class="min-w-0 flex-1 truncate text-left font-mono text-xs"
          :title="model || undefined"
        >
          {{ model }}
        </span>
        <Badge
          v-if="selected?.architecture"
          variant="secondary"
          class="h-5 px-1.5 font-mono"
        >
          {{ architectureLabel(selected.architecture) }}
        </Badge>
      </SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem
        v-for="option in options"
        :key="option.value"
        :value="option.value"
        :text-value="option.value"
        class="max-w-[min(36rem,calc(100vw-2rem))]"
      >
        <span
          class="min-w-0 flex-1 truncate font-mono text-xs"
          :title="option.value"
        >
          {{ option.value }}
        </span>
        <Badge
          v-if="option.architecture"
          variant="secondary"
          class="h-5 px-1.5 font-mono"
        >
          {{ architectureLabel(option.architecture) }}
        </Badge>
      </SelectItem>
    </SelectContent>
  </Select>
</template>
