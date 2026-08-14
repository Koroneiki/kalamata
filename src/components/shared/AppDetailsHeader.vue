<script setup lang="ts">
import { ImageOff, Trash2 } from '@lucide/vue'
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import type { AppDetails } from '@/types/rpc'

const props = defineProps<{
  app: AppDetails
  iconUrl: string | null
  releaseDate: string
  artworkFailed: boolean
  operationBusy: boolean
}>()

defineEmits<{
  iconError: []
  artworkError: []
  remove: []
}>()

const developers = computed(
  () => props.app.developers.join(', ') || 'Unavailable',
)
const publishers = computed(
  () => props.app.publishers.join(', ') || 'Unavailable',
)
</script>

<template>
  <header
    class="relative grid gap-6 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-start lg:grid-cols-[minmax(0,1fr)_18rem]"
  >
    <div class="min-w-0">
      <div class="flex min-w-0 items-start gap-4">
        <div
          class="bg-muted grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg sm:size-10"
        >
          <img
            v-if="iconUrl"
            class="size-full object-cover"
            :src="iconUrl"
            :alt="`${app.name} icon`"
            @error="$emit('iconError')"
          />
          <template v-else>
            <ImageOff class="text-muted-foreground size-5" aria-hidden="true" />
            <span class="sr-only">Icon unavailable</span>
          </template>
        </div>
        <h1 class="min-w-0 text-3xl font-semibold tracking-tight sm:text-4xl">
          {{ app.name }}
        </h1>
      </div>
      <dl class="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div class="min-w-0 space-y-1">
          <dt class="text-muted-foreground">App ID</dt>
          <dd class="font-mono tabular-nums">{{ app.appId }}</dd>
        </div>
        <div class="min-w-0 space-y-1">
          <dt class="text-muted-foreground">Developer</dt>
          <dd class="min-w-0 break-words">{{ developers }}</dd>
        </div>
        <div class="min-w-0 space-y-1">
          <dt class="text-muted-foreground">Release Date</dt>
          <dd>{{ releaseDate }}</dd>
        </div>
        <div class="min-w-0 space-y-1">
          <dt class="text-muted-foreground">Publisher</dt>
          <dd class="min-w-0 break-words">{{ publishers }}</dd>
        </div>
      </dl>
    </div>

    <div class="bg-muted aspect-[46/21] overflow-hidden rounded-lg">
      <img
        v-if="app.artworkUrl && !artworkFailed"
        class="size-full object-cover"
        :src="app.artworkUrl"
        :alt="`${app.name} artwork`"
        @error="$emit('artworkError')"
      />
      <div
        v-else
        class="text-muted-foreground grid size-full place-items-center gap-1 text-xs"
      >
        <span class="grid justify-items-center gap-1">
          <ImageOff class="size-5" aria-hidden="true" />
          Artwork unavailable
        </span>
      </div>
    </div>

    <Button
      v-if="app.inLibrary"
      class="absolute top-0 right-0"
      type="button"
      size="icon-sm"
      variant="outline"
      :disabled="operationBusy"
      aria-label="Remove from library"
      @click="$emit('remove')"
    >
      <Trash2 aria-hidden="true" />
    </Button>
  </header>
</template>
