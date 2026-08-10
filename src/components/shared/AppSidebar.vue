<script setup lang="ts">
import { Download, House, Library, Plus, RefreshCw } from '@lucide/vue'
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
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar'
import LibrarySidebarItem from './LibrarySidebarItem.vue'

const route = useRoute()
const { setOpenMobile } = useSidebar()
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
</script>

<template>
  <Sidebar collapsible="icon">
    <SidebarHeader>
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
      </SidebarMenu>
      <SidebarSeparator />
    </SidebarHeader>

    <SidebarContent class="group-data-[collapsible=icon]:overflow-y-auto">
      <SidebarGroup class="min-h-0 flex-1">
        <SidebarGroupLabel>Installed games</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu aria-label="Installed games">
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
              <SidebarMenuButton as-child tooltip="No installed games">
                <span aria-disabled="true">
                  <Library aria-hidden="true" />
                  <span>No installed games</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
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
    <SidebarRail />
  </Sidebar>
</template>
