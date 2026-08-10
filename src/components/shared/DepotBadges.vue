<script setup lang="ts">
import type { AppDepot } from '@/types/rpc'
import { depotBadges } from '@/utils/depots'

import { Badge } from '@/components/ui/badge'

defineProps<{ depot: AppDepot }>()
</script>

<template>
  <div v-if="depotBadges(depot).length" class="flex flex-wrap gap-2">
    <Badge
      v-for="badge in depotBadges(depot)"
      :key="badge.label"
      :variant="badge.variant"
    >
      {{ badge.label }}
    </Badge>
  </div>
</template>
