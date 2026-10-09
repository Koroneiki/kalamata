<script setup lang="ts">
import { computed } from 'vue'

import DownloadAppIdentity from '@/components/shared/DownloadAppIdentity.vue'
import { useAppSummaryQuery } from '@/composables/queries'
const props = withDefaults(
  defineProps<{ appId: number; artwork?: 'wide' | 'compact' | 'icon' }>(),
  { artwork: 'icon' },
)
const { data, isPending } = useAppSummaryQuery(computed(() => props.appId))
</script>

<template>
  <DownloadAppIdentity
    :app-id="appId"
    :app="data"
    :pending="isPending"
    :artwork="artwork"
  />
</template>
