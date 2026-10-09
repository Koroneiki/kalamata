<script setup lang="ts">
import { RouterLink } from 'vue-router'
import DownloadAppSummaryIdentity from '@/components/shared/DownloadAppSummaryIdentity.vue'
import InlineOperationStatus from '@/components/shared/InlineOperationStatus.vue'
import { Button } from '@/components/ui/button'
import type { DownloadIssue, ResumableOperationState } from '@/types/rpc'

defineProps<{ state: DownloadIssue | ResumableOperationState }>()
</script>

<template>
  <li
    class="grid min-w-0 gap-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
  >
    <div class="min-w-0">
      <DownloadAppSummaryIdentity :app-id="state.appId" artwork="wide" />
      <p
        v-if="state.status !== 'resumable'"
        class="text-destructive mt-2 text-sm break-words"
      >
        {{ state.error.message }}
      </p>
    </div>
    <InlineOperationStatus
      v-if="state.status === 'resumable'"
      :state="state"
      class="min-w-0 sm:w-72"
    />
    <Button
      v-else
      as-child
      variant="outline"
      size="sm"
      class="justify-self-end"
    >
      <RouterLink :to="{ name: 'app-details', params: { appId: state.appId } }"
        >Open game</RouterLink
      >
    </Button>
  </li>
</template>
