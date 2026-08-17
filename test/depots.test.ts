import { expect, test } from 'bun:test'

import type { AppDepot, EligibleAppDepot } from '../src/types/rpc.ts'
import {
  depotBadges,
  filterDepots,
  matchesDepotPlatform,
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
    keyStatus: 'present',
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
    filterDepots(depots, true, true, true, true, ['linux']).map(
      ({ depotId }) => depotId,
    ),
  ).toEqual([1, 4])
  expect(
    filterDepots(depots, false, true, true, true, ['windows', 'linux']).map(
      ({ depotId }) => depotId,
    ),
  ).toEqual([1, 2, 4, 228981])
})

test('matches depot platforms without selection or install preservation', () => {
  expect(matchesDepotPlatform(depot(1), ['linux'])).toBe(true)
  expect(
    matchesDepotPlatform(depot(2, { platform: 'windows, linux' }), ['linux']),
  ).toBe(true)
  expect(
    matchesDepotPlatform(depot(3, { platform: 'windows' }), ['linux']),
  ).toBe(false)
})

test('keeps selected and installed depots visible through every filter', () => {
  const depots = [
    depot(1, { platform: 'windows' }),
    depot(2, { platform: 'windows', installStatus: 'current' }),
    {
      ...depot(3, { platform: 'windows' }),
      group: 'Unavailable',
      eligible: false,
      manifestStatus: null,
      keyStatus: null,
      installStatus: null,
      selectable: false,
    } as AppDepot,
  ]

  expect(
    filterDepots(
      depots,
      true,
      true,
      true,
      true,
      ['linux'],
      new Set([1, 3]),
    ).map(({ depotId }) => depotId),
  ).toEqual([1, 2, 3])
})

test('shows unused depots when their filter is disabled', () => {
  const unused = {
    ...depot(1),
    group: 'Unused',
    eligible: false,
    manifestStatus: null,
    keyStatus: null,
    installStatus: null,
    selectable: false,
  } as AppDepot

  expect(filterDepots([unused], false, false, true, false, ['macos'])).toEqual(
    [],
  )
  expect(filterDepots([unused], false, false, false, false, ['macos'])).toEqual(
    [unused],
  )
})

test('filters ineligible depot groups independently', () => {
  const ineligible = (
    depotId: number,
    group: 'Unknown' | 'Unused' | 'Unavailable',
  ) =>
    ({
      ...depot(depotId),
      group,
      eligible: false,
      manifestStatus: null,
      keyStatus: null,
      installStatus: null,
      selectable: false,
    }) as AppDepot
  const unknown = ineligible(1, 'Unknown')
  const unused = ineligible(2, 'Unused')
  const unavailable = ineligible(3, 'Unavailable')

  expect(
    filterDepots([unknown, unused, unavailable], false, true, false, false, [
      'macos',
    ]),
  ).toEqual([unused, unavailable])
  expect(
    filterDepots([unknown, unused, unavailable], false, false, true, false, [
      'macos',
    ]),
  ).toEqual([unknown, unavailable])
  expect(
    filterDepots([unknown, unused, unavailable], false, false, false, true, [
      'macos',
    ]),
  ).toEqual([unknown, unused])
})
