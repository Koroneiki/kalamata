import { expect, test } from 'bun:test'

import type { AppDepot, EligibleAppDepot } from '../src/types/rpc.ts'
import {
  depotBadges,
  filterDepots,
  summarizeDepots,
} from '../src/utils/depots.ts'

function depot(
  depotId: number,
  overrides: Partial<EligibleAppDepot> = {},
): EligibleAppDepot {
  return {
    depotId,
    ownerAppId: 10,
    ownerAppName: null,
    group: 'Base Game',
    platform: null,
    language: null,
    manifestId: '100',
    sizeBytes: '1024',
    downloadBytes: '512',
    eligible: true,
    manifestStatus: 'ready',
    keyStatus: 'ready',
    installStatus: 'not-installed',
    selectable: true,
    ...overrides,
    mountIndex: overrides.mountIndex ?? depotId,
  }
}

test('summarizes selected depots against every depot in scope', () => {
  const depots = [depot(1), depot(2, { sizeBytes: '2048' }), depot(3)]

  expect(summarizeDepots(depots, new Set([1, 2]))).toEqual({
    selected: 2,
    total: 3,
    sizeBytes: '3072',
    missing: false,
  })
})

test('does not understate unknown sizes and summarizes non-ready resources', () => {
  const depots = [
    depot(1, { sizeBytes: null }),
    depot(2, { manifestStatus: 'outdated', selectable: false }),
  ]

  expect(summarizeDepots(depots, new Set([1]))).toEqual({
    selected: 1,
    total: 2,
    sizeBytes: null,
    missing: true,
  })
})

test('omits ready resources while preserving precise problem and install badges', () => {
  expect(
    depotBadges(
      depot(1, {
        platform: 'windows, linux',
        language: 'english',
        manifestStatus: 'invalid',
        keyStatus: 'missing',
        installStatus: 'outdated',
      }),
    ).map(({ label }) => label),
  ).toEqual([
    'windows',
    'linux',
    'english',
    'Manifest invalid',
    'Key missing',
    'Update available',
  ])
})

test('redistributables expose restrictions without resource badges', () => {
  const redistributable: AppDepot = {
    depotId: 228981,
    mountIndex: 0,
    ownerAppId: 10,
    ownerAppName: null,
    group: 'Steamworks Common Redistributables',
    platform: 'windows',
    language: null,
    manifestId: '100',
    sizeBytes: '1024',
    downloadBytes: '512',
    eligible: false,
    manifestStatus: null,
    keyStatus: null,
    installStatus: null,
    selectable: false,
  }

  expect(depotBadges(redistributable)).toEqual([
    { label: 'windows', variant: 'outline' },
  ])
})

test('filters restricted and redistributable depots using settings', () => {
  const depots = [
    depot(1),
    depot(2, { platform: 'windows' }),
    depot(3, { platform: 'macos' }),
    depot(4, { platform: 'windows, linux' }),
    {
      ...depot(228981, { platform: 'linux' }),
      group: 'Steamworks Common Redistributables',
      eligible: false,
      manifestStatus: null,
      keyStatus: null,
      installStatus: null,
      selectable: false,
    } as AppDepot,
  ]

  expect(
    filterDepots(depots, true, ['linux']).map(({ depotId }) => depotId),
  ).toEqual([1, 4])
  expect(
    filterDepots(depots, false, ['windows', 'linux']).map(
      ({ depotId }) => depotId,
    ),
  ).toEqual([1, 2, 4, 228981])
})
