import { expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, ref } from 'vue'

import {
  mergeOperationProgress,
  remainingOperationVisibility,
} from '../src/composables/use-app-operation-display.ts'
import { useCustomManifest } from '../src/composables/use-custom-manifest.ts'
import {
  normalizeDepotDraftEdit,
  useDepotOperationDraftStore,
} from '../src/stores/depot-operation-drafts.ts'
import {
  acceptedIntentAppIds,
  isAppInDownloads,
  resolveAcceptedDesiredDepotIds,
} from '../src/utils/depot-operation.ts'
import { operationLabel } from '../src/utils/operation.ts'
import type {
  ActiveOperationState,
  EligibleAppDepot,
  OperationState,
  PendingDownload,
} from '../src/types/rpc.ts'

function operation(
  counters: Partial<
    Pick<
      ActiveOperationState,
      | 'installedBytesCompleted'
      | 'installedBytesTotal'
      | 'reusedLocalBytes'
      | 'networkBytes'
      | 'estimatedDownloadBytes'
    >
  >,
): ActiveOperationState {
  return {
    status: 'active',
    kind: 'download',
    phase: 'downloading',
    appId: 440,
    installPath: '/games/440',
    desiredDepotIds: [441],
    installedBytesCompleted: '0',
    installedBytesTotal: '0',
    reusedLocalBytes: '0',
    networkBytes: '0',
    estimatedDownloadBytes: null,
    ...counters,
  }
}

test('operation progress remains monotonic across replanning', () => {
  const displayed = operation({
    installedBytesCompleted: '100',
    installedBytesTotal: '500',
    reusedLocalBytes: '75',
    networkBytes: '80',
  })
  const replanned = operation({
    installedBytesCompleted: '0',
    installedBytesTotal: '600',
    reusedLocalBytes: '20',
    networkBytes: '90',
  })

  expect(mergeOperationProgress(replanned, displayed)).toMatchObject({
    installedBytesCompleted: '100',
    installedBytesTotal: '600',
    reusedLocalBytes: '75',
    networkBytes: '90',
  })
})

test('resuming preserves displayed counters while accepting the active state', () => {
  const paused = {
    ...operation({
      installedBytesCompleted: '100',
      installedBytesTotal: '500',
      reusedLocalBytes: '75',
      networkBytes: '80',
    }),
    status: 'paused' as const,
  }
  const resumed = operation({
    installedBytesCompleted: '0',
    installedBytesTotal: '0',
    reusedLocalBytes: '0',
    networkBytes: '0',
  })

  expect(mergeOperationProgress(resumed, paused)).toMatchObject({
    status: 'active',
    installedBytesCompleted: '100',
    installedBytesTotal: '500',
    reusedLocalBytes: '75',
    networkBytes: '80',
  })
})

test('download estimates can decrease after local reuse is verified', () => {
  const displayed = operation({
    networkBytes: '90',
    estimatedDownloadBytes: '500',
  })
  const refined = operation({
    networkBytes: '100',
    estimatedDownloadBytes: '300',
  })

  expect(mergeOperationProgress(refined, displayed)).toMatchObject({
    networkBytes: '100',
    estimatedDownloadBytes: '300',
  })
  expect(
    mergeOperationProgress(
      operation({ estimatedDownloadBytes: null }),
      displayed,
    ).estimatedDownloadBytes,
  ).toBe('500')
})

test('operation labels distinguish install, update, uninstall, and verify', () => {
  expect(operationLabel('download', [1])).toBe('Install')
  expect(operationLabel('reconcile', [1])).toBe('Update')
  expect(operationLabel('reconcile', [])).toBe('Uninstall')
  expect(operationLabel('repair', [])).toBe('Verify')
})

test('completed operation remains visible for three seconds in total', () => {
  expect(remainingOperationVisibility(1_000, 1_500)).toBe(2_500)
})

test('completed operation remains visible for at least one second', () => {
  expect(remainingOperationVisibility(1_000, 5_000)).toBe(1_000)
})

test('depot operation drafts retain order and clear targets on deselection', () => {
  setActivePinia(createPinia())
  const drafts = useDepotOperationDraftStore()

  drafts.editDepotIds(440, [442, 441])
  drafts.setManifestTarget(440, [442, 441], {
    depotId: 441,
    manifestId: '200',
  })
  drafts.editDepotIds(440, [442])

  expect(drafts.get(440)).toEqual({ depotIds: [442], manifestTargets: [] })
})

test('depot operation drafts are scoped to one Pinia session', () => {
  setActivePinia(createPinia())
  useDepotOperationDraftStore().editDepotIds(440, [441])

  setActivePinia(createPinia())

  expect(useDepotOperationDraftStore().get(440)).toBeNull()
})

test('draft pruning keeps retained depots and removes stale targets', () => {
  setActivePinia(createPinia())
  const drafts = useDepotOperationDraftStore()
  drafts.editDepotIds(440, [441, 442])
  drafts.setManifestTarget(440, [441], {
    depotId: 442,
    manifestId: '200',
  })

  drafts.prune(440, new Set([441]))

  expect(drafts.get(440)).toEqual({ depotIds: [441], manifestTargets: [] })
})

test('partial edits retain hidden installs and full uninstall clears them', () => {
  const eligible = new Set([441, 442])

  expect(normalizeDepotDraftEdit([900, 442], eligible)).toEqual([900, 442])
  expect(normalizeDepotDraftEdit([900], eligible)).toEqual([])
})

test('accepted queue and repair intent identify only matching drafts to clear', () => {
  setActivePinia(createPinia())
  const drafts = useDepotOperationDraftStore()
  drafts.editDepotIds(440, [441])
  drafts.editDepotIds(441, [442])
  const accepted = acceptedIntentAppIds({
    operation: { status: 'idle' },
    pending: [
      {
        id: 'queued',
        appId: 440,
        kind: 'reconcile',
        installPath: '/games/440',
        desiredDepotIds: [441],
        createdAt: 1,
      },
    ],
    repairRequiredAppIds: [],
  })
  for (const appId of accepted) drafts.clear(appId)

  expect(drafts.get(440)).toBeNull()
  expect(drafts.get(441)).toEqual({ depotIds: [442], manifestTargets: [] })
})

test('pending non-repair intent overrides active operation intent', () => {
  const pending: PendingDownload[] = [
    {
      id: 'queued',
      appId: 440,
      kind: 'reconcile',
      installPath: '/games/440',
      desiredDepotIds: [442, 441],
      createdAt: 1,
    },
  ]

  expect(resolveAcceptedDesiredDepotIds(operation({}), pending, 440)).toEqual([
    442, 441,
  ])
})

test('active paused and resumable non-repair states expose accepted intent', () => {
  const active = operation({})
  const states: OperationState[] = [
    active,
    { ...active, status: 'paused' },
    {
      ...active,
      status: 'resumable',
      error: { kind: 'steam', message: 'offline' },
    },
  ]
  for (const state of states)
    expect(resolveAcceptedDesiredDepotIds(state, [], 440)).toEqual([441])
})

test('repair and terminal states do not expose desired depot intent', () => {
  const terminalStates: OperationState[] = [
    { ...operation({}), kind: 'repair' },
    {
      status: 'completed',
      kind: 'reconcile',
      appId: 440,
      installPath: '/games/440',
      desiredDepotIds: [442],
      installedBytes: '1',
      reusedLocalBytes: '0',
      networkBytes: '1',
      estimatedDownloadBytes: '1',
    },
    {
      status: 'cancelled',
      kind: 'reconcile',
      appId: 440,
      installPath: '/games/440',
      desiredDepotIds: [442],
      error: { kind: 'cancellation', message: 'cancelled' },
    },
    {
      status: 'failed',
      kind: 'reconcile',
      appId: 440,
      installPath: '/games/440',
      desiredDepotIds: [442],
      error: { kind: 'planning', message: 'failed' },
    },
    {
      status: 'repair-required',
      appId: 440,
      installPath: '/games/440',
      error: { kind: 'recovery', message: 'repair' },
    },
  ]

  for (const state of terminalStates)
    expect(resolveAcceptedDesiredDepotIds(state, [], 440)).toBeNull()
  expect(
    resolveAcceptedDesiredDepotIds(
      { status: 'idle' },
      [
        {
          id: 'repair',
          appId: 440,
          kind: 'repair',
          installPath: '/games/440',
          desiredDepotIds: [],
          createdAt: 1,
        },
      ],
      440,
    ),
  ).toBeNull()
})

test('failed current operations remain part of Downloads', () => {
  const failed: OperationState = {
    status: 'failed',
    kind: 'reconcile',
    appId: 440,
    installPath: '/games/440',
    desiredDepotIds: [442],
    error: { kind: 'planning', message: 'failed' },
  }

  expect(isAppInDownloads(failed, [], [], 440)).toBe(true)
  expect(isAppInDownloads(failed, [], [], 441)).toBe(false)
})

function depot(overrides: Partial<EligibleAppDepot> = {}): EligibleAppDepot {
  return {
    depotId: 441,
    mountIndex: 441,
    ownerAppId: 440,
    ownerAppName: null,
    group: 'Base Game',
    platform: null,
    language: null,
    manifestId: '100',
    sizeBytes: '1024',
    downloadBytes: '512',
    eligible: true,
    manifestStatus: 'ready',
    keyStatus: 'present',
    installStatus: 'not-installed',
    selectable: true,
    ...overrides,
  }
}

function customManifestHarness() {
  const selectedDepotIds = ref<number[]>([])
  const customManifestTargets = reactive(new Map<number, string>())
  const acquisitions: string[] = []
  const pins: boolean[] = []
  let invalidations = 0
  const manifest = useCustomManifest({
    appId: ref(440),
    customManifestTargets,
    acquiringManifests: reactive(new Set<string>()),
    setCustomManifestTarget: (depotId, manifestId) => {
      customManifestTargets.set(depotId, manifestId)
      if (!selectedDepotIds.value.includes(depotId))
        selectedDepotIds.value.push(depotId)
    },
    removeCustomManifestTarget: (depotId) =>
      customManifestTargets.delete(depotId),
    acquireDepotKeys: async () => [],
    acquireManifest: async (_appId, _depotId, manifestId) => {
      acquisitions.push(manifestId)
    },
    setDepotPinned: async (_appId, _depotId, pinned) => {
      pins.push(pinned)
    },
    invalidateDetails: async () => {
      invalidations += 1
    },
  })
  return {
    manifest,
    selectedDepotIds,
    acquisitions,
    pins,
    invalidations: () => invalidations,
  }
}

test('custom manifest workflow acquires and selects a download target', async () => {
  const harness = customManifestHarness()
  harness.manifest.editCustomManifest(depot())

  await harness.manifest.setCustomManifest('200')

  expect(harness.acquisitions).toEqual(['200'])
  expect(harness.manifest.customManifestTargets.value.get(441)).toBe('200')
  expect(harness.selectedDepotIds.value).toEqual([441])
  expect(harness.manifest.customManifestDialogOpen.value).toBe(false)
})

test('custom manifest workflow pins and unpins the installed manifest', async () => {
  const harness = customManifestHarness()
  harness.manifest.editCustomManifest(
    depot({ installedManifestId: '100', installStatus: 'current' }),
  )

  await harness.manifest.setCustomManifest('100')
  harness.manifest.editCustomManifest(
    depot({
      installedManifestId: '100',
      installStatus: 'current',
      pinned: true,
    }),
  )
  await harness.manifest.removeCustomManifest()

  expect(harness.pins).toEqual([true, false])
  expect(harness.invalidations()).toBe(2)
  expect(harness.manifest.customManifestDialogOpen.value).toBe(false)
})
