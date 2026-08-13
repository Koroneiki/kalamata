<script setup lang="ts">
import { ConfigProvider } from 'reka-ui'
import { computed } from 'vue'
import { RouterView } from 'vue-router'
import 'vue-sonner/style.css'

import AppHeader from '@/components/shared/AppHeader.vue'
import AppSidebar from '@/components/shared/AppSidebar.vue'
import { Button } from '@/components/ui/button'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { useManifestQueueToasts } from '@/composables/use-manifest-queue-toasts'
import { useOperationToasts } from '@/composables/use-operation-toasts'
import { useOperationStore } from '@/stores/operation'

const operation = useOperationStore()
useOperationToasts()
const { active: manifestQueueActive } = useManifestQueueToasts()
const notificationOffset = computed(() => (manifestQueueActive.value ? 94 : 20))
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
