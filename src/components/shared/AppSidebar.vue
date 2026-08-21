<script setup lang="ts">
import {
  Download,
  House,
  Library,
  Plus,
  RefreshCw,
  Settings,
} from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import { watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import AddGameDialog from '@/components/forms/AddGameDialog.vue'
import { useLibraryQuery } from '@/composables/queries'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar'
import LibrarySidebarItem from './LibrarySidebarItem.vue'
import AppSidebarRail from './AppSidebarRail.vue'

const route = useRoute()
const { open, setOpenMobile } = useSidebar()
const compactWindow = useMediaQuery('(max-width: 976px)')
let restoreExpandedAfterCompact = false
let applyingResponsiveState = false
const {
  data: library,
  error: libraryError,
  isPending,
  refetch,
} = useLibraryQuery()

watch(
  () => route.fullPath,
  () => setOpenMobile(false),
)

watch(
  open,
  () => {
    if (compactWindow.value && !applyingResponsiveState) {
      restoreExpandedAfterCompact = false
    }
  },
  { flush: 'sync' },
)

watch(
  compactWindow,
  (compact) => {
    if (compact) {
      restoreExpandedAfterCompact = open.value
      if (!open.value) return
      applyingResponsiveState = true
      open.value = false
      applyingResponsiveState = false
    } else if (restoreExpandedAfterCompact) {
      restoreExpandedAfterCompact = false
      applyingResponsiveState = true
      open.value = true
      applyingResponsiveState = false
    }
  },
  { flush: 'sync', immediate: true },
)
</script>

<template>
  <Sidebar collapsible="icon">
    <SidebarHeader class="pb-0">
      <SidebarGroupLabel
        class="text-sidebar-foreground text-sm font-semibold tracking-tight group-data-[collapsible=icon]:mt-0!"
      >
        Kalamata
      </SidebarGroupLabel>
      <SidebarSeparator class="-translate-y-px" />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            as-child
            :is-active="route.name === 'home'"
            tooltip="Home"
          >
            <RouterLink
              to="/"
              :aria-current="route.name === 'home' ? 'page' : undefined"
              @click="setOpenMobile(false)"
            >
              <House aria-hidden="true" />
              <span>Home</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            as-child
            :is-active="route.name === 'downloads'"
            tooltip="Downloads"
          >
            <RouterLink
              :to="{ name: 'downloads' }"
              :aria-current="route.name === 'downloads' ? 'page' : undefined"
              @click="setOpenMobile(false)"
            >
              <Download aria-hidden="true" />
              <span>Downloads</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            as-child
            :is-active="route.name === 'settings'"
            tooltip="Settings"
          >
            <RouterLink
              :to="{ name: 'settings' }"
              :aria-current="route.name === 'settings' ? 'page' : undefined"
              @click="setOpenMobile(false)"
            >
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarSeparator />
    </SidebarHeader>

    <SidebarContent class="group-data-[collapsible=icon]:overflow-y-auto">
      <SidebarGroup class="min-h-0 flex-1">
        <SidebarGroupLabel>Library</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu aria-label="Library">
            <template v-if="isPending">
              <SidebarMenuItem v-for="index in 3" :key="index">
                <SidebarMenuSkeleton show-icon />
              </SidebarMenuItem>
            </template>

            <SidebarMenuItem v-else-if="libraryError">
              <SidebarMenuButton
                tooltip="Retry loading library"
                @click="refetch()"
              >
                <RefreshCw aria-hidden="true" />
                <span>Retry loading library</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <template v-else-if="library?.length">
              <LibrarySidebarItem
                v-for="entry in library"
                :key="entry.appId"
                :entry="entry"
              />
            </template>

            <SidebarMenuItem v-else>
              <SidebarMenuButton as-child tooltip="No games in library">
                <span aria-disabled="true">
                  <Library aria-hidden="true" />
                  <span>No games in library</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter class="pt-0">
      <SidebarSeparator />
      <SidebarMenu>
        <SidebarMenuItem>
          <AddGameDialog @navigated="setOpenMobile(false)">
            <SidebarMenuButton tooltip="Add a game">
              <Plus aria-hidden="true" />
              <span>Add a game</span>
            </SidebarMenuButton>
          </AddGameDialog>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
    <AppSidebarRail />
  </Sidebar>
</template>
