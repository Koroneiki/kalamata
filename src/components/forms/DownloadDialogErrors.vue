<script setup lang="ts">
import { Button } from '@/components/ui/button'

defineProps<{
  previewError: string
  startError: string
}>()

defineEmits<{
  retry: []
}>()
</script>

<template>
  <div
    v-if="previewError"
    class="border-destructive/30 bg-destructive/5 rounded-lg border p-4"
    role="alert"
  >
    <p class="text-destructive text-sm font-medium">
      Couldn't calculate changes
    </p>
    <p class="text-muted-foreground mt-1 text-sm">{{ previewError }}</p>
    <Button
      type="button"
      size="sm"
      variant="outline"
      class="mt-3"
      @click="$emit('retry')"
    >
      Retry
    </Button>
  </div>
  <p v-if="startError" class="text-destructive text-sm" role="alert">
    {{ startError }}
  </p>
</template>
