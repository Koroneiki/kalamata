<script setup lang="ts">
import { ConfigProvider } from 'reka-ui'
import { RouterView } from 'vue-router'

import AppHeader from '@/components/shared/AppHeader.vue'
import AppSidebar from '@/components/shared/AppSidebar.vue'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
</script>

<template>
  <ConfigProvider :scroll-body="false">
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset class="min-w-0">
        <AppHeader />
        <RouterView />
      </SidebarInset>
    </SidebarProvider>
  </ConfigProvider>
</template>
