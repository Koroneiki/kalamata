<script setup lang="ts">
import { Download, X } from '@lucide/vue'
import { computed } from 'vue'

import DownloadAppIdentity from '@/components/shared/DownloadAppIdentity.vue'
import { Button } from '@/components/ui/button'
import { useAppSummaryQuery } from '@/composables/queries'
import type { PendingDownload } from '@/types/rpc'

const props = defineProps<{
  item: PendingDownload
  removing: boolean
  prioritizing: boolean
  error: string
}>()

defineEmits<{ download: []; remove: [] }>()

const { data, isPending } = useAppSummaryQuery(computed(() => props.item.appId))
const appName = computed(() => data.value?.name ?? `App ${props.item.appId}`)
const busy = computed(() => props.removing || props.prioritizing)
</script>

<template>
  <li
    class="grid min-w-0 gap-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
  >
    <div class="min-w-0">
      <DownloadAppIdentity
        :app-id="item.appId"
        :app="data"
        :pending="isPending"
        artwork="wide"
      />
      <p v-if="error" class="text-destructive mt-2 text-sm" role="alert">
        {{ error }}
      </p>
    </div>
    <div class="flex items-center justify-end gap-2">
      <Button
        class="flex-1 sm:flex-none"
        type="button"
        size="sm"
        :disabled="busy"
        @click="$emit('download')"
      >
        <Download aria-hidden="true" />
        {{ prioritizing ? 'Starting...' : 'Download' }}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        :disabled="busy"
        :aria-label="`Remove ${appName} from queue`"
        :title="`Remove ${appName} from queue`"
        @click="$emit('remove')"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  </li>
</template>
