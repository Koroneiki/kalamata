<script setup lang="ts">
import { ImageOff } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { useAppSummaryQuery } from '@/composables/queries'
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
const iconIndex = ref(0)

watch(
  () => data.value?.iconUrls,
  () => {
    iconIndex.value = 0
  },
)

const iconUrl = computed(() => data.value?.iconUrls?.[iconIndex.value] ?? null)
const name = computed(() => data.value?.name ?? `App ${props.entry.appId}`)
const isActive = computed(
  () =>
    route.name === 'app-details' &&
    Number(route.params.appId) === props.entry.appId,
)

function handleIconError() {
  iconIndex.value += 1
}
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
          class="bg-muted text-muted-foreground grid size-5 shrink-0 place-items-center overflow-hidden rounded-sm"
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
