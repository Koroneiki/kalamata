<script setup lang="ts">
import { ConfigProvider } from 'reka-ui'
import { computed, watch } from 'vue'
import { RouterView } from 'vue-router'
import 'vue-sonner/style.css'

import AppHeader from '@/components/shared/AppHeader.vue'
import AppSidebar from '@/components/shared/AppSidebar.vue'
import ColdClientOperationStatus from '@/components/shared/ColdClientOperationStatus.vue'
import HubcapQuotaDialog from '@/components/shared/HubcapQuotaDialog.vue'
import { Button } from '@/components/ui/button'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { useManifestQueueToasts } from '@/composables/use-manifest-queue-toasts'
import { useOperationToasts } from '@/composables/use-operation-toasts'
import { useOperationStore } from '@/stores/operation'
import { useAvailableUpdates } from '@/composables/use-available-updates'

const operation = useOperationStore()
const availableUpdates = useAvailableUpdates()
useOperationToasts()
const { active: manifestQueueActive } = useManifestQueueToasts()
const notificationOffset = computed(() => (manifestQueueActive.value ? 94 : 20))

watch(
  () => operation.initialized,
  (initialized) => {
    if (initialized) void availableUpdates.refreshAll()
  },
  { immediate: true },
)

watch(
  () => operation.state,
  (state, previous) => {
    if (
      state.status !== 'completed' ||
      (previous?.status === 'completed' && previous.appId === state.appId)
    )
      return
    queueMicrotask(() => void availableUpdates.syncApp(state.appId))
  },
  { flush: 'sync' },
)
</script>

<template>
  <ConfigProvider :scroll-body="false">
    <main
      v-if="!operation.initialized"
      class="grid min-h-screen place-items-center p-6"
    >
      <div class="max-w-sm text-center">
        <h1 class="text-lg font-semibold">Connecting to Kalamata</h1>
        <p
          v-if="operation.initializationError"
          class="text-destructive mt-2 text-sm"
          role="alert"
        >
          {{ operation.initializationError }}
        </p>
        <p v-else class="text-muted-foreground mt-2 text-sm">
          Loading the current download state…
        </p>
        <Button
          v-if="operation.initializationError"
          class="mt-4"
          type="button"
          variant="outline"
          @click="operation.initialize()"
        >
          Retry
        </Button>
      </div>
    </main>
    <SidebarProvider v-else>
      <AppSidebar />
      <SidebarInset class="min-w-0">
        <AppHeader />
        <ColdClientOperationStatus />
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
    <HubcapQuotaDialog />
    <Toaster
      id="manifest-queue"
      position="bottom-right"
      :offset="20"
      :visible-toasts="1"
    />
  </ConfigProvider>
</template>
