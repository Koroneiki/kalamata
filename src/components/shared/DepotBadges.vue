<script setup lang="ts">
import DepotResourceStatus from '@/components/shared/DepotResourceStatus.vue'
import type { AppDepot } from '@/types/rpc'
import { depotBadges } from '@/utils/depots'

import { Badge } from '@/components/ui/badge'

defineProps<{ depot: AppDepot }>()
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <Badge
      v-for="badge in depotBadges(depot)"
      :key="badge.label"
      :variant="badge.variant"
    >
      {{ badge.label }}
    </Badge>
    <DepotResourceStatus v-if="depot.eligible" :depot="depot" />
  </div>
</template>
