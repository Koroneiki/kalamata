<script setup lang="ts">
import { ImageOff } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import type { AppSummary } from '@/types/rpc'
import { useFallbackImage } from '@/composables/use-fallback-image'

const props = withDefaults(
  defineProps<{
    appId: number
    app?: AppSummary | null
    pending?: boolean
    artwork?: 'wide' | 'compact' | 'icon'
  }>(),
  {
    app: null,
    pending: false,
    artwork: 'compact',
  },
)

const artworkFailed = ref(false)
const name = computed(() => props.app?.name ?? `App ${props.appId}`)
const { imageUrl: iconUrl, handleImageError } = useFallbackImage(
  () => props.app?.iconUrls,
)
const artworkUrl = computed(() =>
  props.artwork === 'icon' ? iconUrl.value : (props.app?.artworkUrl ?? null),
)
const artworkSize = computed(() =>
  props.artwork === 'icon'
    ? 'size-8'
    : props.artwork === 'wide'
      ? 'aspect-[46/21] w-32 sm:w-44'
      : 'aspect-[46/21] w-24 sm:w-32',
)
const artworkFallbackLabel = computed(() =>
  props.pending ? 'Loading artwork' : 'Artwork unavailable',
)
const artworkFallbackClass = computed(() =>
  props.pending ? 'animate-pulse' : '',
)
const showArtwork = computed(
  () => Boolean(artworkUrl.value) && !artworkFailed.value && !props.pending,
)

watch(artworkUrl, () => {
  artworkFailed.value = false
})
</script>

<template>
  <RouterLink
    class="focus-visible:ring-ring group focus-visible:ring-offset-background flex min-w-0 items-center gap-4 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
    :to="{ name: 'app-details', params: { appId } }"
    :aria-label="`Open ${name}`"
  >
    <span
      class="bg-muted text-muted-foreground grid shrink-0 place-items-center overflow-hidden rounded-md"
      :class="artworkSize"
    >
      <img
        v-if="showArtwork"
        class="size-full object-cover"
        :src="artworkUrl ?? undefined"
        :alt="`${name} artwork`"
        @error="
          artwork === 'icon' ? handleImageError() : (artworkFailed = true)
        "
      />
      <span
        v-else
        class="bg-primary/10 grid size-full justify-items-center gap-1 px-2 text-center text-xs"
        :class="artworkFallbackClass"
      >
        <ImageOff class="size-4" aria-hidden="true" />
        <span class="sr-only">{{ artworkFallbackLabel }}</span>
      </span>
    </span>

    <span class="min-w-0">
      <span
        v-if="pending"
        class="bg-muted block h-5 w-32 max-w-full animate-pulse rounded"
        aria-label="Loading app name"
      />
      <span
        v-else
        class="block min-w-0 font-semibold group-hover:underline group-hover:underline-offset-4"
        :class="artwork === 'icon' ? 'text-sm' : 'text-base'"
      >
        {{ name }}
      </span>
    </span>
  </RouterLink>
</template>
