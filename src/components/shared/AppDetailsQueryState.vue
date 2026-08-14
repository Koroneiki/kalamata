<script setup lang="ts">
import AppDetailsLoadingSkeleton from '@/components/shared/AppDetailsLoadingSkeleton.vue'

import { Button } from '@/components/ui/button'

defineProps<{
  validAppId: boolean
  pending: boolean
  error: Error | null
  hasData: boolean
}>()

defineEmits<{ retry: [] }>()
</script>

<template>
  <p v-if="!validAppId" class="text-destructive" role="alert">
    Invalid App ID.
  </p>
  <AppDetailsLoadingSkeleton v-else-if="pending" />
  <div v-else-if="error" class="bg-muted rounded-lg p-4" role="alert">
    <p class="font-medium">App details could not be loaded</p>
    <p class="text-muted-foreground mt-1 text-sm">{{ error.message }}</p>
    <Button
      class="mt-3"
      size="sm"
      variant="outline"
      type="button"
      @click="$emit('retry')"
      >Retry</Button
    >
  </div>
  <slot v-else-if="hasData" />
</template>
