<script setup lang="ts">
import { ImageOff } from '@lucide/vue'
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { useAppSummaryQuery } from '@/composables/queries'
import { useFallbackImage } from '@/composables/use-fallback-image'
import type { LibraryEntry } from '@/types/rpc'

import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@/components/ui/sidebar'

const props = defineProps<{ entry: LibraryEntry }>()

const route = useRoute()
const { setOpenMobile } = useSidebar()
const { data, error, isPending } = useAppSummaryQuery(
  computed(() => props.entry.appId),
)
const { imageUrl: iconUrl, handleImageError: handleIconError } =
  useFallbackImage(() => data.value?.iconUrls)
const name = computed(() => data.value?.name ?? `App ${props.entry.appId}`)
const isActive = computed(
  () =>
    route.name === 'app-details' &&
    Number(route.params.appId) === props.entry.appId,
)
</script>

<template>
  <SidebarMenuItem>
    <SidebarMenuSkeleton v-if="isPending" show-icon />
    <SidebarMenuButton v-else as-child :is-active="isActive" :tooltip="name">
      <RouterLink
        :to="{ name: 'app-details', params: { appId: entry.appId } }"
        :aria-current="isActive ? 'page' : undefined"
        :aria-label="
          error
            ? `Open App ${entry.appId}; Steam metadata unavailable`
            : undefined
        "
        @click="setOpenMobile(false)"
      >
        <span
          class="bg-muted text-muted-foreground grid size-4 shrink-0 place-items-center overflow-hidden rounded-sm"
        >
          <img
            v-if="iconUrl"
            class="size-full object-cover"
            :src="iconUrl"
            alt=""
            @error="handleIconError"
          />
          <ImageOff v-else class="size-3" aria-hidden="true" />
        </span>
        <span>{{ name }}</span>
      </RouterLink>
    </SidebarMenuButton>
  </SidebarMenuItem>
</template>
