<script setup lang="ts">
import { computed } from 'vue'

import DownloadAppIdentity from '@/components/shared/DownloadAppIdentity.vue'
import { useAppSummaryQuery } from '@/composables/queries'
import type { BackgroundDownloadJob } from '@/types/background-downloads'

const props = defineProps<{ job: BackgroundDownloadJob }>()
// This component is mounted only for app-associated jobs, so no summary query
// is sent for dependencies, updates, or the global depot key cache.
const { data, isPending } = useAppSummaryQuery(computed(() => props.job.appId!))
</script>

<template>
  <DownloadAppIdentity
    :app-id="job.appId!"
    :app="data"
    :pending="isPending"
    artwork="wide"
  />
</template>
