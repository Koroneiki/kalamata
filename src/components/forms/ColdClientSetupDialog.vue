<script setup lang="ts">
import { useMutation } from '@pinia/colada'
import { computed, ref, watch } from 'vue'

import {
  configureColdClient,
  inspectColdClientSetup,
  regenerateColdClientConfiguration,
} from '@/api/cold-client'
import ColdClientArchitectureSelect from '@/components/forms/ColdClientArchitectureSelect.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import type {
  ColdClientSetupDraft,
  ColdClientSetupMode,
  ColdClientSetupRequest,
  ColdClientSetupWarning,
} from '@/types/cold-client'

const props = defineProps<{
  open: boolean
  appId: number
  appName: string
  installPath: string
  mode: ColdClientSetupMode
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  error: [message: string]
}>()

const draft = ref<ColdClientSetupDraft | null>(null)
const loading = ref(false)
const error = ref('')
const selectedExecutable = ref('')
const selectedSteamApi = ref('')
const selectedLaunchSource = ref('')
const launchArguments = ref('')
let requestSequence = 0
const configureMutation = useMutation({
  mutation: (request: ColdClientSetupRequest) =>
    props.mode === 'regenerate'
      ? regenerateColdClientConfiguration(request)
      : configureColdClient(request),
})
const regenerating = computed(() => props.mode === 'regenerate')

const targetPath = computed(
  () => `${props.installPath.replace(/[\\/]+$/u, '')}\\_ColdClient`,
)
const canReview = computed(
  () =>
    Boolean(selectedExecutable.value) &&
    Boolean(draft.value) &&
    (draft.value!.steamApiCandidates.length === 0 ||
      Boolean(selectedSteamApi.value)),
)
const reviewedArchitecture = computed(() =>
  selectedSteamApi.value.toLowerCase().endsWith('steam_api.dll')
    ? 'x86'
    : 'x64',
)
const steamApiArchitecture = (path: string): 'x86' | 'x64' =>
  path.toLowerCase().endsWith('steam_api.dll') ? 'x86' : 'x64'
const executableOptions = computed(() =>
  (draft.value?.executableCandidates ?? []).map((value) => ({
    value,
    architecture: draft.value?.executableArchitectures[value] ?? null,
  })),
)
const steamApiOptions = computed(() =>
  (draft.value?.steamApiCandidates ?? []).map((value) => ({
    value,
    architecture: steamApiArchitecture(value),
  })),
)
const visibleWarnings = computed(() => {
  if (!draft.value) return []
  const selectedLaunch = draft.value.launchOptions.find(
    ({ key }) => key === selectedLaunchSource.value,
  )
  const warnings = draft.value.warnings.filter((warning) => {
    if (
      warning === 'multiple-shipping-executables' ||
      warning === 'executable-choice-required'
    ) {
      return !selectedExecutable.value
    }
    if (warning === 'steam-api-choice-required') {
      return !selectedSteamApi.value
    }
    if (warning === 'launch-executable-mismatch') return false
    return true
  })
  if (
    selectedLaunch &&
    selectedLaunch.executable.toLowerCase() !==
      selectedExecutable.value.toLowerCase()
  ) {
    warnings.push('launch-executable-mismatch')
  }
  return warnings
})

const warningText = {
  'multiple-shipping-executables':
    'Several Shipping executables were found. Choose the game executable.',
  'executable-choice-required':
    'The game executable could not be selected automatically.',
  'steam-api-choice-required':
    'Several Steam API DLLs were found. Choose the DLL used by this game.',
  'x64-assumed-without-steam-api':
    'No Steam API DLL was found. The x64 loader will be used without interface generation.',
  'launch-executable-mismatch':
    'The Steam launch entry supplying these arguments targets a different executable.',
  'existing-cold-client-will-be-replaced':
    'The existing _ColdClient directory and all of its contents will be removed only after the replacement validates.',
} satisfies Record<ColdClientSetupWarning, string>

watch(
  () => [props.open, props.mode, props.appId] as const,
  ([open]) => {
    const request = ++requestSequence
    if (!open) {
      draft.value = null
      loading.value = false
      return
    }
    loading.value = true
    error.value = ''
    void inspectColdClientSetup(props.appId, props.mode)
      .then((result) => {
        if (request !== requestSequence) return
        draft.value = result
        selectedExecutable.value = result.selectedExecutableRelativePath ?? ''
        selectedSteamApi.value = result.selectedSteamApiRelativePath ?? ''
        selectedLaunchSource.value = result.launchArgumentSource ?? ''
        launchArguments.value = result.launchArguments
      })
      .catch((reason) => {
        if (request === requestSequence) {
          error.value =
            reason instanceof Error ? reason.message : String(reason)
        }
      })
      .finally(() => {
        if (request === requestSequence) loading.value = false
      })
  },
  { immediate: true },
)

function confirmSetup() {
  if (!draft.value || !canReview.value) return
  const operation = configureMutation.mutateAsync({
    appId: props.appId,
    executableRelativePath: selectedExecutable.value,
    steamApiRelativePath: selectedSteamApi.value || null,
    loaderArchitecture: reviewedArchitecture.value,
    launchArguments: launchArguments.value,
    launchArgumentSource: selectedLaunchSource.value || null,
    gbeAssetId: draft.value.gbe.assetId,
    gseAssetId: draft.value.gse.assetId,
  })
  emit('update:open', false)
  void operation.catch((reason) =>
    emit('error', reason instanceof Error ? reason.message : String(reason)),
  )
}

function selectLaunchSource(event: Event) {
  if (!(event.target instanceof HTMLSelectElement)) return
  const key = event.target.value
  selectedLaunchSource.value = key
  const option = draft.value?.launchOptions.find((item) => item.key === key)
  if (option) launchArguments.value = option.arguments
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle class="text-primary">
          {{ regenerating ? 'Regenerate' : 'Set up' }} {{ appName }}
        </DialogTitle>
        <DialogDescription>
          Review the game files and launch settings.
          {{
            regenerating
              ? 'The current configuration is selected where it is still available.'
              : 'Nothing changes until setup is confirmed.'
          }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="space-y-3" aria-label="Inspecting game files">
        <Skeleton v-for="index in 6" :key="index" class="h-12 w-full" />
      </div>

      <p v-else-if="error" class="text-destructive text-sm" role="alert">
        {{ error }}
      </p>

      <div v-else-if="draft" class="space-y-5">
        <dl class="bg-muted grid gap-2 rounded-lg p-3 text-sm sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-muted-foreground text-xs">App ID</dt>
            <dd class="font-mono tabular-nums">{{ draft.appId }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-muted-foreground text-xs">Target directory</dt>
            <dd class="truncate font-mono text-xs" :title="targetPath">
              {{ targetPath }}
            </dd>
          </div>
        </dl>

        <div class="space-y-2">
          <Label for="cold-client-executable">Game executable</Label>
          <ColdClientArchitectureSelect
            id="cold-client-executable"
            v-model="selectedExecutable"
            placeholder="Choose an executable"
            :options="executableOptions"
          />
          <p class="text-muted-foreground text-xs">
            Detection: {{ draft.executableDetectionSource }}
          </p>
        </div>

        <div class="space-y-2">
          <Label for="cold-client-steam-api">Steam API DLL</Label>
          <ColdClientArchitectureSelect
            v-if="draft.steamApiCandidates.length"
            id="cold-client-steam-api"
            v-model="selectedSteamApi"
            placeholder="Choose a Steam API DLL"
            :options="steamApiOptions"
          />
          <p v-else class="bg-muted rounded-md p-3 text-sm">
            No Steam API DLL found. x64 is assumed.
          </p>
          <p class="text-muted-foreground text-xs">
            Loader: {{ reviewedArchitecture.toUpperCase() }}
          </p>
        </div>

        <div class="space-y-2">
          <Label for="cold-client-launch-source">Launch argument source</Label>
          <select
            id="cold-client-launch-source"
            :value="selectedLaunchSource"
            class="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            @change="selectLaunchSource"
          >
            <option value="">Custom or no arguments</option>
            <option
              v-for="option in draft.launchOptions"
              :key="option.key"
              :value="option.key"
            >
              {{ option.key }} · {{ option.description ?? option.executable }}
            </option>
          </select>
          <p
            v-if="selectedLaunchSource"
            class="text-muted-foreground font-mono text-xs"
          >
            {{
              draft.launchOptions.find(
                (option) => option.key === selectedLaunchSource,
              )?.executable
            }}
          </p>
          <Input
            id="cold-client-launch-arguments"
            v-model="launchArguments"
            aria-label="Launch arguments"
            placeholder="No launch arguments"
          />
        </div>

        <div v-if="visibleWarnings.length" class="space-y-2" aria-live="polite">
          <p
            v-for="warning in visibleWarnings"
            :key="warning"
            class="border-border bg-muted rounded-md border p-3 text-sm"
          >
            {{ warningText[warning] }}
          </p>
        </div>

        <div class="border-border space-y-2 border-t pt-4 text-sm">
          <p>Uses GBE {{ draft.gbe.tag }} and GSE Tools {{ draft.gse.tag }}.</p>
          <p>
            Official <code>extra_dlls</code> will be injected into the game
            process. The original Steam API DLL is not modified.
          </p>
          <p v-if="regenerating">
            Regeneration replaces <code>steam_settings</code> and updates the
            loader configuration. Other managed core files and custom files are
            preserved.
          </p>
          <p class="text-muted-foreground">
            Review only. No files have changed.
          </p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">
          Close
        </Button>
        <Button
          :disabled="!canReview || configureMutation.isLoading.value"
          @click="confirmSetup"
        >
          {{
            configureMutation.isLoading.value
              ? regenerating
                ? 'Starting regeneration...'
                : 'Starting setup...'
              : regenerating
                ? 'Confirm regeneration'
                : 'Confirm setup'
          }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
