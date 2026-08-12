<script setup lang="ts">
import { ConfigProvider } from 'reka-ui'
import { computed } from 'vue'
import { RouterView } from 'vue-router'
import 'vue-sonner/style.css'

import AppHeader from '@/components/shared/AppHeader.vue'
import AppSidebar from '@/components/shared/AppSidebar.vue'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { useManifestQueueToasts } from '@/composables/use-manifest-queue-toasts'
import { useOperationToasts } from '@/composables/use-operation-toasts'

useOperationToasts()
const { active: manifestQueueActive } = useManifestQueueToasts()
const notificationOffset = computed(() => (manifestQueueActive.value ? 94 : 20))
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
    <Toaster
      class="notification-toaster"
      position="bottom-right"
      close-button
      :offset="notificationOffset"
      :gap="10"
    />
    <Toaster
      id="manifest-queue"
      position="bottom-right"
      :offset="20"
      :visible-toasts="1"
    />
  </ConfigProvider>
</template>
