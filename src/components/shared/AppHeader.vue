<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { Button } from '@/components/ui/button'
import { SidebarTrigger } from '@/components/ui/sidebar'

const route = useRoute()
const libraryActive = computed(
  () => route.name === 'home' || route.name === 'app-details',
)
</script>

<template>
  <header
    class="bg-background sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4"
  >
    <SidebarTrigger class="-ml-1" />
    <nav class="flex items-center" aria-label="Primary navigation">
      <Button
        as-child
        size="sm"
        variant="ghost"
        :class="libraryActive && 'bg-accent text-accent-foreground'"
      >
        <RouterLink to="/" :aria-current="libraryActive ? 'page' : undefined">
          Library
        </RouterLink>
      </Button>
    </nav>
  </header>
</template>
