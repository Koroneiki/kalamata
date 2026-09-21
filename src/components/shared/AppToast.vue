<script setup lang="ts">
import { CircleCheck, Info, OctagonX, TriangleAlert } from '@lucide/vue'

defineProps<{
  variant: 'success' | 'warning' | 'error' | 'info'
  message: string
  description?: string
}>()
</script>

<template>
  <div class="flex min-h-16 items-center gap-3 px-4 py-3">
    <CircleCheck
      v-if="variant === 'success'"
      class="text-primary size-4 shrink-0"
      aria-hidden="true"
    />
    <TriangleAlert
      v-else-if="variant === 'warning'"
      class="text-foreground size-4 shrink-0"
      aria-hidden="true"
    />
    <OctagonX
      v-else-if="variant === 'error'"
      class="text-destructive size-4 shrink-0"
      aria-hidden="true"
    />
    <Info
      v-else
      class="text-muted-foreground size-4 shrink-0"
      aria-hidden="true"
    />
    <div class="min-w-0 flex-1">
      <p class="text-sm leading-5 font-medium">{{ message }}</p>
      <p
        v-if="description"
        class="text-muted-foreground mt-0.5 text-xs leading-4"
      >
        {{ description }}
      </p>
    </div>
  </div>
</template>
