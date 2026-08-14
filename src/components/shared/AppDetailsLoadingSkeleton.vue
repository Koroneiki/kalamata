<script setup lang="ts">
import { Skeleton } from '@/components/ui/skeleton'
</script>

<template>
  <div class="space-y-6" aria-label="Loading app details">
    <div
      class="grid gap-6 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-start lg:grid-cols-[minmax(0,1fr)_18rem]"
    >
      <div class="min-w-0">
        <div class="flex items-start gap-4">
          <Skeleton class="size-9 shrink-0 rounded-lg sm:size-10" />
          <Skeleton class="mt-1 h-9 w-3/5" />
        </div>
        <div class="mt-6 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-3">
          <Skeleton v-for="index in 8" :key="index" class="h-4 w-full" />
        </div>
      </div>
      <Skeleton class="aspect-[46/21] w-full rounded-lg" />
    </div>
    <Skeleton class="h-28 w-full rounded-lg" />
    <Skeleton class="h-12 w-full rounded-lg" />
  </div>
</template>
