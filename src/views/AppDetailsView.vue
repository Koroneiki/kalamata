<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { getAppDetails } from '@/api/apps'

const route = useRoute()
const appId = computed(() => Number(route.params.appId))
const validAppId = computed(
  () =>
    Number.isInteger(appId.value) &&
    appId.value > 0 &&
    appId.value <= 0xffffffff,
)

const { data, error, isPending } = useQuery(() => ({
  key: ['app', appId.value],
  query: () => getAppDetails(appId.value),
  enabled: validAppId.value,
}))
</script>

<template>
  <main class="mx-auto min-h-screen max-w-2xl p-6 sm:p-12">
    <RouterLink class="text-sm text-muted-foreground hover:text-foreground" to="/">
      Back to search
    </RouterLink>

    <p v-if="!validAppId" class="mt-8 text-destructive">Invalid App ID.</p>
    <p v-else-if="isPending" class="mt-8 text-muted-foreground">Loading...</p>
    <p v-else-if="error" class="mt-8 text-destructive">
      {{ error.message }}
    </p>
    <section v-else-if="data" class="mt-8 rounded-lg border bg-card p-6">
      <p class="text-sm text-muted-foreground">App {{ data.appId }}</p>
      <h1 class="mt-1 text-3xl font-semibold">{{ data.name }}</h1>
      <dl class="mt-8 grid gap-5 sm:grid-cols-2">
        <div>
          <dt class="text-sm text-muted-foreground">Developer</dt>
          <dd class="mt-1">{{ data.developers.join(', ') || 'Unknown' }}</dd>
        </div>
        <div>
          <dt class="text-sm text-muted-foreground">Publisher</dt>
          <dd class="mt-1">{{ data.publishers.join(', ') || 'Unknown' }}</dd>
        </div>
      </dl>
    </section>
  </main>
</template>
