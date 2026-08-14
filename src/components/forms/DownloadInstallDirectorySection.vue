<script setup lang="ts">
import { FolderOpen, Lock } from '@lucide/vue'
import { computed } from 'vue'

import { Button } from '@/components/ui/button'

const props = defineProps<{
  installPath: string | null
  selectedPath: string
  choosingPath: boolean
  pathError: string
}>()

defineEmits<{
  choose: []
}>()

const pathIcon = computed(() => (props.installPath ? Lock : FolderOpen))
const chooseLabel = computed(() =>
  props.choosingPath ? 'Choosing…' : 'Choose',
)
</script>

<template>
  <section class="min-w-0 space-y-2" aria-labelledby="install-path-title">
    <h3 id="install-path-title" class="text-sm font-medium">
      Install directory
    </h3>
    <div
      class="bg-muted/40 flex min-w-0 flex-col items-stretch gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center"
    >
      <component
        :is="pathIcon"
        class="text-muted-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      <span
        v-if="selectedPath"
        class="min-w-0 flex-1 truncate font-mono text-xs"
        :aria-label="`Install path: ${selectedPath}`"
        >{{ selectedPath }}</span
      >
      <span v-else class="text-muted-foreground min-w-0 flex-1 text-sm"
        >No directory selected</span
      >
      <Button
        v-if="!installPath"
        type="button"
        size="sm"
        variant="outline"
        :disabled="choosingPath"
        @click="$emit('choose')"
      >
        {{ chooseLabel }}
      </Button>
    </div>
    <p v-if="pathError" class="text-destructive text-xs" role="alert">
      {{ pathError }}
    </p>
  </section>
</template>
