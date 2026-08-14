<script setup lang="ts">
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

defineProps<{
  id: string
  label: string
  modelValue?: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean | 'indeterminate']
}>()
</script>

<template>
  <div
    class="bg-muted/45 border-border flex items-center justify-between gap-6 border-t px-4 py-3.5 sm:px-5"
  >
    <Label :for="id" class="text-sm">
      {{ label }}
    </Label>
    <Skeleton v-if="modelValue === undefined" class="size-4" />
    <Checkbox
      v-else
      :id="id"
      class="border-muted-foreground/70"
      :model-value="modelValue"
      :disabled="disabled"
      :aria-label="label"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>
