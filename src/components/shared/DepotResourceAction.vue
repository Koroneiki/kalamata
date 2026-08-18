<script setup lang="ts">
import { Download, LoaderCircle } from '@lucide/vue'
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import type { AppDepot } from '@/types/rpc'

const props = defineProps<{
  depot: AppDepot
  acquiring: boolean
  automatic: boolean
}>()

defineEmits<{ acquire: [] }>()

const canAcquire = computed(
  () =>
    props.depot.eligible &&
    props.depot.manifestId !== null &&
    (props.depot.manifestStatus !== 'ready' ||
      props.depot.keyStatus !== 'present'),
)
</script>

<template>
  <Button
    v-if="canAcquire && !automatic"
    size="icon-xs"
    variant="outline"
    type="button"
    :disabled="acquiring"
    :aria-label="`Get resources for depot ${depot.depotId}`"
    @click="$emit('acquire')"
  >
    <LoaderCircle v-if="acquiring" class="animate-spin" aria-hidden="true" />
    <Download v-else aria-hidden="true" />
  </Button>
  <LoaderCircle
    v-else-if="canAcquire && acquiring"
    class="size-4 animate-spin"
    aria-label="Acquiring manifest"
  />
</template>
