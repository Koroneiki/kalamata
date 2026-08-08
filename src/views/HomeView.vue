<script setup lang="ts">
import { Library, Search } from '@lucide/vue'
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import LibraryAppCard from '@/components/shared/LibraryAppCard.vue'
import { useLibraryQuery } from '@/composables/queries'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

const router = useRouter()
const appId = ref('')
const searchError = ref('')
const {
  data: library,
  error: libraryError,
  isPending,
  refetch,
} = useLibraryQuery()

function search() {
  const value = Number(appId.value)
  if (!/^\d+$/.test(appId.value) || value <= 0 || value > 0xffffffff) {
    searchError.value = 'Enter an App ID from 1 to 4294967295.'
    return
  }

  searchError.value = ''
  void router.push({ name: 'app-details', params: { appId: value } })
}
</script>

<template>
  <main
    class="mx-auto min-h-screen w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12"
  >
    <header class="border-border border-b pb-6">
      <h1 class="text-2xl font-semibold tracking-tight">Kalamata</h1>
      <p class="text-muted-foreground mt-1 max-w-xl text-sm">
        Look up a public Steam app or return to content installed on this
        machine.
      </p>

      <form class="mt-6" novalidate @submit.prevent="search">
        <Label for="app-id">Steam App ID</Label>
        <div class="mt-2 flex gap-2">
          <Input
            id="app-id"
            v-model.trim="appId"
            class="min-w-0 flex-1 tabular-nums"
            inputmode="numeric"
            autocomplete="off"
            placeholder="For example, 440"
            :aria-invalid="Boolean(searchError)"
            :aria-describedby="searchError ? 'search-error' : undefined"
            autofocus
          />
          <Button type="submit">
            <Search aria-hidden="true" />
            Search
          </Button>
        </div>
        <p
          v-if="searchError"
          id="search-error"
          class="text-destructive mt-2 text-sm"
          role="alert"
        >
          {{ searchError }}
        </p>
      </form>
    </header>

    <section class="pt-6" aria-labelledby="library-title">
      <div class="flex items-center justify-between gap-4">
        <div>
          <h2 id="library-title" class="text-lg font-semibold">Library</h2>
          <p class="text-muted-foreground mt-0.5 text-xs">
            Installed content managed by Kalamata
          </p>
        </div>
        <span v-if="library" class="text-muted-foreground text-xs tabular-nums">
          {{ library.length }} {{ library.length === 1 ? 'app' : 'apps' }}
        </span>
      </div>

      <div
        v-if="isPending"
        class="divide-border mt-4 divide-y"
        aria-label="Loading library"
      >
        <div
          v-for="index in 3"
          :key="index"
          class="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-4 py-4"
        >
          <Skeleton class="aspect-[46/21] w-full rounded-md" />
          <div class="space-y-2 py-0.5">
            <Skeleton class="h-4 w-2/5" />
            <Skeleton class="h-3 w-3/5" />
            <Skeleton class="h-3 w-full" />
          </div>
        </div>
      </div>

      <div
        v-else-if="libraryError"
        class="bg-muted mt-4 rounded-lg p-4"
        role="alert"
      >
        <p class="font-medium">Library could not be loaded</p>
        <p class="text-muted-foreground mt-1 text-sm">
          {{ libraryError.message }}
        </p>
        <Button
          class="mt-3"
          size="sm"
          variant="outline"
          type="button"
          @click="refetch()"
          >Retry</Button
        >
      </div>

      <div v-else-if="library?.length" class="mt-3">
        <LibraryAppCard
          v-for="entry in library"
          :key="entry.appId"
          :entry="entry"
        />
      </div>

      <div v-else class="mt-8 grid justify-items-center py-8 text-center">
        <div
          class="bg-muted text-muted-foreground grid size-10 place-items-center rounded-full"
        >
          <Library class="size-4" aria-hidden="true" />
        </div>
        <h3 class="mt-3 font-medium">No installed apps</h3>
        <p class="text-muted-foreground mt-1 max-w-sm text-sm">
          Search by Steam App ID to inspect available depots and begin an
          installation.
        </p>
      </div>
    </section>
  </main>
</template>
