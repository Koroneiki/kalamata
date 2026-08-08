<script setup lang="ts">
import { CalendarDays, ChevronRight, ImageOff } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { useAppSummaryQuery } from '@/composables/queries'
import type { LibraryEntry } from '@/types/rpc'

import InstallPathValue from './InstallPathValue.vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

const props = defineProps<{ entry: LibraryEntry }>()

const { data, error, isPending, refetch } = useAppSummaryQuery(
  computed(() => props.entry.appId),
)
const artworkFailed = ref(false)

watch(
  () => data.value?.artworkUrl,
  () => {
    artworkFailed.value = false
  },
)

const releaseDate = computed(() => {
  if (!data.value?.releaseDate) return 'Release date unavailable'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(data.value.releaseDate)
})
</script>

<template>
  <article class="group border-border border-b last:border-b-0">
    <div
      v-if="isPending"
      class="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-4 py-4"
    >
      <Skeleton class="aspect-[46/21] w-full rounded-md" />
      <div class="min-w-0 space-y-2 py-0.5">
        <Skeleton class="h-4 w-2/5" />
        <Skeleton class="h-3 w-3/5" />
        <Skeleton class="h-3 w-full" />
      </div>
    </div>

    <div v-else-if="error" class="flex min-w-0 items-center gap-3 py-4">
      <div
        class="bg-muted text-muted-foreground grid size-12 shrink-0 place-items-center rounded-md"
      >
        <ImageOff class="size-4" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1">
        <RouterLink
          class="focus-visible:ring-ring font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:outline-none"
          :to="{ name: 'app-details', params: { appId: entry.appId } }"
        >
          App {{ entry.appId }}
        </RouterLink>
        <p class="text-muted-foreground mt-0.5 text-xs">
          Steam metadata could not be loaded.
        </p>
      </div>
      <Button size="sm" variant="outline" type="button" @click="refetch()"
        >Retry</Button
      >
    </div>

    <RouterLink
      v-else-if="data"
      class="focus-visible:ring-ring grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-4 rounded-md py-4 outline-none focus-visible:ring-2"
      :to="{ name: 'app-details', params: { appId: entry.appId } }"
      :aria-label="`Open ${data.name}, App ${data.appId}`"
    >
      <div class="bg-muted aspect-[46/21] overflow-hidden rounded-md">
        <img
          v-if="data.artworkUrl && !artworkFailed"
          class="size-full object-cover"
          :src="data.artworkUrl"
          :alt="`${data.name} artwork`"
          @error="artworkFailed = true"
        />
        <div
          v-else
          class="text-muted-foreground grid size-full place-items-center"
        >
          <ImageOff class="size-4" aria-hidden="true" />
        </div>
      </div>
      <div class="min-w-0">
        <div class="flex min-w-0 items-baseline gap-2">
          <h3
            class="truncate font-medium group-hover:underline group-hover:underline-offset-4"
          >
            {{ data.name }}
          </h3>
          <span class="text-muted-foreground shrink-0 text-xs tabular-nums"
            >App {{ data.appId }}</span
          >
        </div>
        <p class="text-muted-foreground mt-1 truncate text-xs">
          {{ data.developers.join(', ') || 'Developer unavailable' }}
        </p>
        <div class="text-muted-foreground mt-2 grid min-w-0 gap-1 text-xs">
          <span class="inline-flex min-w-0 items-center gap-1 truncate">
            <CalendarDays class="size-3.5" aria-hidden="true" />
            {{ releaseDate }}
          </span>
          <InstallPathValue :path="entry.installPath" :focusable="false" />
        </div>
      </div>
      <ChevronRight
        class="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </RouterLink>
  </article>
</template>
