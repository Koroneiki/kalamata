<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { SidebarTrigger } from '@/components/ui/sidebar'

const route = useRoute()
const pageLabel = computed(() => {
  if (route.name === 'app-details') return 'App details'
  return 'Library'
})
</script>

<template>
  <header
    class="bg-background sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4"
  >
    <SidebarTrigger class="-ml-1" />
    <span class="text-sm font-medium">{{ pageLabel }}</span>
  </header>
</template>
