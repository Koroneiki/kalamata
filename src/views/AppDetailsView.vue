<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { Download, FolderOpen, ImageOff, Lock } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { selectInstallDirectory } from '@/api/install-directory'
import DownloadDepotsDialog from '@/components/forms/DownloadDepotsDialog.vue'
import DepotAccordion from '@/components/shared/DepotAccordion.vue'
import DownloadQueuePanel from '@/components/shared/DownloadQueuePanel.vue'
import { appQueryKeys } from '@/composables/queries'
import { getAppDetails } from '@/api/apps'
import { useDownloadQueueStore } from '@/stores/download-queue'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const route = useRoute()
const queue = useDownloadQueueStore()
const appId = computed(() => Number(route.params.appId))
const validAppId = computed(
  () =>
    Number.isInteger(appId.value) &&
    appId.value > 0 &&
    appId.value <= 0xffffffff,
)

const { data, error, isPending, refetch } = useQuery(() => ({
  key: appQueryKeys.details(appId.value),
  query: () => getAppDetails(appId.value),
  enabled: validAppId.value,
}))

const selectedPath = ref('')
const pathError = ref('')
const artworkFailed = ref(false)
const iconIndex = ref(0)
const choosingPath = ref(false)
const dialogOpen = ref(false)
const queuePanel = ref<{ focusHeading: () => void } | null>(null)
const loadedAppId = ref<number | null>(null)

watch(
  () => data.value,
  (app) => {
    if (app) {
      const appChanged = loadedAppId.value !== app.appId
      loadedAppId.value = app.appId
      if (appChanged) {
        selectedPath.value = app.installPath ?? ''
        pathError.value = ''
      } else if (app.installPath) {
        selectedPath.value = app.installPath
      }
    }
  },
)

watch(
  () => data.value?.artworkUrl,
  () => {
    artworkFailed.value = false
  },
)

watch(
  () => data.value?.iconUrls,
  () => {
    iconIndex.value = 0
  },
)

const iconUrl = computed(() => data.value?.iconUrls?.[iconIndex.value] ?? null)

const releaseDate = computed(() => {
  if (!data.value?.releaseDate) return 'Unavailable'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(data.value.releaseDate)
})

const readyDepotCount = computed(
  () => data.value?.depots.filter((depot) => depot.selectable).length ?? 0,
)
const queueForApp = computed(() => {
  const state = queue.state
  return state.status !== 'idle' && state.appId === appId.value ? state : null
})
const anotherQueueRunning = computed(
  () => queue.state.status === 'running' && queue.state.appId !== appId.value,
)
const canOpenDownload = computed(
  () => readyDepotCount.value > 0 && queue.state.status !== 'running',
)

watch(
  queueForApp,
  (state) => {
    if (state) selectedPath.value = state.installPath
  },
  { immediate: true },
)

async function chooseDirectory() {
  choosingPath.value = true
  pathError.value = ''
  try {
    const path = await selectInstallDirectory(selectedPath.value || undefined)
    if (path) selectedPath.value = path
  } catch (error) {
    pathError.value = error instanceof Error ? error.message : String(error)
  } finally {
    choosingPath.value = false
  }
}

function openDownload() {
  dialogOpen.value = true
}

function handleIconError() {
  iconIndex.value += 1
}

async function focusDownloadQueue() {
  await nextTick()
  queuePanel.value?.focusHeading()
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
    <p v-if="!validAppId" class="text-destructive mt-8" role="alert">
      Invalid App ID.
    </p>

    <div
      v-else-if="isPending"
      class="mt-6 space-y-6"
      aria-label="Loading app details"
    >
      <div
        class="grid gap-6 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-start lg:grid-cols-[minmax(0,1fr)_18rem]"
      >
        <div class="min-w-0">
          <div class="flex items-start gap-4">
            <Skeleton class="size-9 shrink-0 rounded-lg sm:size-10" />
            <Skeleton class="mt-1 h-9 w-3/5" />
          </div>
          <div
            class="mt-6 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-3"
          >
            <Skeleton v-for="index in 8" :key="index" class="h-4 w-full" />
          </div>
        </div>
        <Skeleton class="aspect-[46/21] w-full rounded-lg" />
      </div>
      <Skeleton class="h-28 w-full rounded-lg" />
      <Skeleton class="h-12 w-full rounded-lg" />
    </div>

    <div v-else-if="error" class="bg-muted mt-8 rounded-lg p-4" role="alert">
      <p class="font-medium">App details could not be loaded</p>
      <p class="text-muted-foreground mt-1 text-sm">{{ error.message }}</p>
      <Button
        class="mt-3"
        size="sm"
        variant="outline"
        type="button"
        @click="refetch()"
        >Retry</Button
      >
    </div>

    <template v-else-if="data">
      <header
        class="mt-6 grid gap-6 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-start lg:grid-cols-[minmax(0,1fr)_18rem]"
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
                :alt="`${data.name} icon`"
                @error="handleIconError"
              />
              <ImageOff
                v-else
                class="text-muted-foreground size-5"
                aria-hidden="true"
              />
              <span v-if="!iconUrl" class="sr-only">Icon unavailable</span>
            </div>
            <h1
              class="min-w-0 text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              {{ data.name }}
            </h1>
          </div>
          <dl
            class="mt-6 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm"
          >
            <div class="contents">
              <dt class="text-muted-foreground">App ID</dt>
              <dd class="font-mono tabular-nums">{{ data.appId }}</dd>
            </div>
            <div class="contents">
              <dt class="text-muted-foreground">Developer</dt>
              <dd class="min-w-0 break-words">
                {{ data.developers.join(', ') || 'Unavailable' }}
              </dd>
            </div>
            <div class="contents">
              <dt class="text-muted-foreground">Publisher</dt>
              <dd class="min-w-0 break-words">
                {{ data.publishers.join(', ') || 'Unavailable' }}
              </dd>
            </div>
            <div class="contents">
              <dt class="text-muted-foreground">Release Date</dt>
              <dd>{{ releaseDate }}</dd>
            </div>
          </dl>
        </div>

        <div class="bg-muted aspect-[46/21] overflow-hidden rounded-lg">
          <img
            v-if="data.artworkUrl && !artworkFailed"
            class="size-full object-cover"
            :src="data.artworkUrl"
            :alt="`${data.name} artwork`"
            @error="artworkFailed = true"
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
      </header>

      <Tabs default-value="info" class="mt-8">
        <TabsList>
          <TabsTrigger value="info">Install</TabsTrigger>
          <TabsTrigger value="depots">Depots</TabsTrigger>
        </TabsList>

        <TabsContent value="info" class="mt-6">
          <section
            class="border-border grid gap-4 border-y py-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start"
          >
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <Lock
                  v-if="data.installPath"
                  class="text-muted-foreground size-4"
                  aria-hidden="true"
                />
                <FolderOpen
                  v-else
                  class="text-muted-foreground size-4"
                  aria-hidden="true"
                />
                <h2 class="text-base font-medium">Install directory</h2>
                <span
                  v-if="data.installPath"
                  class="text-muted-foreground text-xs"
                  >Locked</span
                >
              </div>
              <div
                class="mt-2 flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center"
              >
                <span
                  v-if="selectedPath"
                  class="min-w-0 flex-1 truncate font-mono text-xs"
                  :aria-label="`Install path: ${selectedPath}`"
                >
                  {{ selectedPath }}
                </span>
                <span
                  v-else
                  class="text-muted-foreground min-w-0 flex-1 text-sm"
                  >No directory selected</span
                >
                <Button
                  v-if="!data.installPath"
                  type="button"
                  size="sm"
                  variant="outline"
                  :disabled="choosingPath || queue.state.status === 'running'"
                  @click="chooseDirectory"
                >
                  {{
                    choosingPath
                      ? 'Choosing…'
                      : selectedPath
                        ? 'Change'
                        : 'Choose directory'
                  }}
                </Button>
              </div>
              <p
                v-if="pathError"
                class="text-destructive mt-2 text-sm"
                role="alert"
              >
                {{ pathError }}
              </p>
            </div>

            <div class="space-y-2 lg:text-right">
              <Button
                class="w-full lg:w-auto"
                type="button"
                :disabled="!canOpenDownload"
                @click="openDownload"
              >
                <Download aria-hidden="true" />
                Download depots
              </Button>
              <p
                v-if="queueForApp?.status === 'running'"
                class="text-muted-foreground text-sm"
              >
                Download in progress.
              </p>
              <p
                v-else-if="anotherQueueRunning"
                class="text-muted-foreground text-sm"
              >
                Another app is currently downloading.
              </p>
              <p
                v-else-if="readyDepotCount === 0"
                class="text-muted-foreground text-sm"
              >
                No depots are ready to download.
              </p>
              <p
                v-else-if="!selectedPath"
                class="text-muted-foreground text-sm"
              >
                Choose an install directory to continue.
              </p>
              <p v-else class="text-muted-foreground text-sm">
                {{ readyDepotCount }} ready
                {{ readyDepotCount === 1 ? 'depot' : 'depots' }}
              </p>
            </div>
          </section>

          <DownloadQueuePanel
            v-if="queueForApp"
            ref="queuePanel"
            class="mt-5"
            :state="queueForApp"
          />
        </TabsContent>

        <TabsContent value="depots" class="mt-6">
          <DepotAccordion :depots="data.depots" />
        </TabsContent>
      </Tabs>

      <DownloadDepotsDialog
        v-model:open="dialogOpen"
        :app="data"
        :initial-path="selectedPath"
        @download-started="focusDownloadQueue"
      />
    </template>
  </div>
</template>
