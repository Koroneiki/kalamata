import { expect, test } from 'bun:test'
import { matchAvailableUpdateDepots } from '../src/utils/available-updates.ts'
import type {
  AppDetails,
  AvailableUpdateCandidate,
  EligibleAppDepot,
} from '../src/types/rpc.ts'

test('accepts only the unchanged installed, eligible, unpinned public target', () => {
  const candidate = makeCandidate()
  const details = makeDetails()

  expect(matchAvailableUpdateDepots(details, candidate)).toEqual([depot()])

  for (const change of [
    { installedDepotIds: [] },
    { depot: { pinned: true } },
    { depot: { installStatus: 'current' as const } },
    { depot: { installedManifestId: '3' } },
    { depot: { ownerAppId: 20 } },
    { depot: { manifestId: '3' } },
  ]) {
    const changed = makeDetails()
    if (change.installedDepotIds)
      changed.installedDepotIds = change.installedDepotIds
    if (change.depot) Object.assign(changed.depots[0]!, change.depot)
    expect(matchAvailableUpdateDepots(changed, candidate)).toBeNull()
  }

  const newlyOutdated = makeDetails()
  newlyOutdated.installedDepotIds.push(11)
  newlyOutdated.depots.push(
    depot({ depotId: 11, installedManifestId: '4', manifestId: '5' }),
  )
  expect(matchAvailableUpdateDepots(newlyOutdated, candidate)).toBeNull()
})

function makeCandidate(): AvailableUpdateCandidate {
  return {
    app: summary(),
    installedDepotIds: [10],
    outdatedDepots: [
      {
        depotId: 10,
        ownerAppId: 1,
        installedManifestId: '1',
        targetManifestId: '2',
        sizeBytes: '10',
        downloadBytes: '5',
      },
    ],
    totalDownloadBytes: '5',
  }
}

function makeDetails(): AppDetails {
  return {
    ...summary(),
    inLibrary: true,
    installPath: '/game',
    installedDepotIds: [10],
    depots: [depot()],
  }
}

function depot(overrides: Partial<EligibleAppDepot> = {}): EligibleAppDepot {
  return {
    depotId: 10,
    mountIndex: 0,
    ownerAppId: 1,
    ownerAppName: null,
    group: 'Base Game',
    platform: null,
    language: null,
    manifestId: '2',
    installedManifestId: '1',
    pinned: false,
    sizeBytes: '10',
    downloadBytes: '5',
    eligible: true,
    manifestStatus: 'ready',
    keyStatus: 'present',
    installStatus: 'outdated',
    selectable: true,
    ...overrides,
  }
}

function summary() {
  return {
    appId: 1,
    name: 'Example',
    developers: [],
    publishers: [],
    releaseDate: null,
    iconUrls: [],
    artworkUrl: null,
  }
}
