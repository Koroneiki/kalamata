import { expect, test } from 'bun:test'
import { reactive, ref } from 'vue'

import {
  mergeOperationProgress,
  remainingOperationVisibility,
} from '../src/composables/use-app-operation-display.ts'
import { useCustomManifest } from '../src/composables/use-custom-manifest.ts'
import type {
  ActiveOperationState,
  EligibleAppDepot,
} from '../src/types/rpc.ts'

function operation(
  counters: Partial<
    Pick<
      ActiveOperationState,
      | 'installedBytesCompleted'
      | 'installedBytesTotal'
      | 'reusedLocalBytes'
      | 'networkBytes'
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

test('completed operation remains visible for three seconds in total', () => {
  expect(remainingOperationVisibility(1_000, 1_500)).toBe(2_500)
})

test('completed operation remains visible for at least one second', () => {
  expect(remainingOperationVisibility(1_000, 5_000)).toBe(1_000)
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
  const acquisitions: string[] = []
  const pins: boolean[] = []
  let invalidations = 0
  const manifest = useCustomManifest({
    appId: ref(440),
    selectedDepotIds,
    acquiringManifests: reactive(new Set<string>()),
    updateSelectedDepots: async (depotIds) => {
      selectedDepotIds.value = depotIds
    },
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
  expect(harness.manifest.customManifestTargets.get(441)).toBe('200')
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
