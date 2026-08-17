import { expect, test } from 'bun:test'
import type SteamUser from 'steam-user'
import { AvailableUpdateService } from '../src/backend/apps/available-update-service.ts'
import type { InstallRow } from '../src/db/database.ts'
import type { ProductInfoResult } from '../src/backend/steam/types.ts'

const APP_ID = 10

test('collapses eligible outdated installs and preserves the installed baseline', async () => {
  const service = createService(
    [
      install(101, '1'),
      install(102, '2'),
      install(103, '3', true),
      install(999, '9'),
    ],
    products(
      {
        101: depot('11', '100', '40'),
        102: depot('22', '200', '60', { dlcappid: '20' }),
        103: depot('33', '300', '80'),
        104: depot('44', '400', '90'),
        105: { manifests: { public: { size: '500', download: '100' } } },
      },
      {},
      true,
    ),
  )

  expect(await service.check(APP_ID)).toEqual({
    status: 'available',
    candidate: {
      app: {
        appId: APP_ID,
        name: 'Example',
        developers: [],
        publishers: [],
        releaseDate: null,
        iconUrls: [],
        artworkUrl: null,
      },
      installedDepotIds: [101, 102, 103, 999],
      outdatedDepots: [
        {
          depotId: 101,
          ownerAppId: APP_ID,
          installedManifestId: '1',
          targetManifestId: '11',
          sizeBytes: '100',
          downloadBytes: '40',
        },
        {
          depotId: 102,
          ownerAppId: 20,
          installedManifestId: '2',
          targetManifestId: '22',
          sizeBytes: '200',
          downloadBytes: '60',
        },
      ],
      totalDownloadBytes: '100',
    },
    checkedAt: 123,
  })
})

test('returns current for unchanged, pinned, unavailable, and uninstalled depots', async () => {
  const service = createService(
    [install(101, '11'), install(102, '2', true), install(105, '5')],
    products({
      101: depot('11'),
      102: depot('22'),
      103: depot('33'),
      105: { manifests: { public: {} } },
      228981: depot('44'),
    }),
  )

  expect(await service.check(APP_ID)).toEqual({
    status: 'current',
    appId: APP_ID,
    checkedAt: 123,
  })
})

test('returns an unknown total when any outdated depot lacks a download size', async () => {
  const service = createService(
    [install(101, '1'), install(102, '2')],
    products({
      101: depot('11', '100', '40'),
      102: depot('22', '200', null),
    }),
  )

  const result = await service.check(APP_ID)
  expect(result.status).toBe('available')
  if (result.status === 'available') {
    expect(result.candidate.totalDownloadBytes).toBeNull()
  }
})

test('uses direct DLC product ownership', async () => {
  const service = createService(
    [install(201, '1')],
    products({}, { 201: depot('2') }),
  )

  const result = await service.check(APP_ID)
  expect(result.status).toBe('available')
  if (result.status === 'available') {
    expect(result.candidate.outdatedDepots[0]?.ownerAppId).toBe(20)
  }
})

test('checks an installed depot even when it is absent from public packages', async () => {
  const service = createService(
    [install(101, '1')],
    products({ 101: depot('2') }, {}, false, new Set()),
  )

  const result = await service.check(APP_ID)

  expect(result.status).toBe('available')
  if (result.status === 'available') {
    expect(result.candidate.outdatedDepots).toEqual([
      expect.objectContaining({ depotId: 101, targetManifestId: '2' }),
    ])
  }
})

test('sanitizes product metadata failures', async () => {
  const service = new AvailableUpdateService(
    {
      getProductInfoWithDlc: () =>
        Promise.reject(new Error('Steam token secret')),
      getProductInfoWithDlcBatch: () =>
        Promise.reject(new Error('Steam token secret')),
    },
    { getInstalls: () => [install(101, '1')] },
    () => 123,
  )

  expect(await service.check(APP_ID)).toEqual({
    status: 'error',
    appId: APP_ID,
    message: 'Could not check this app for updates.',
    checkedAt: 123,
  })
})

function createService(installs: InstallRow[], productInfo: ProductInfoResult) {
  return new AvailableUpdateService(
    {
      getProductInfoWithDlc: () => Promise.resolve(productInfo),
      getProductInfoWithDlcBatch: (appIds) =>
        Promise.resolve(new Map(appIds.map((appId) => [appId, productInfo]))),
    },
    { getInstalls: () => installs },
    () => 123,
  )
}

function install(
  depotId: number,
  installedManifestId: string,
  pinned = false,
): InstallRow {
  return {
    depotId,
    installedManifestId,
    pinned,
    mountIndex: depotId,
    ownerAppId: APP_ID,
  }
}

function products(
  baseDepots: Record<number, unknown>,
  dlcDepots: Record<number, unknown> = {},
  includeDlc = Object.keys(dlcDepots).length > 0,
  eligibleBaseDepotIds: ReadonlySet<number> | null = null,
): ProductInfoResult {
  return {
    baseProduct: product(APP_ID, 'Example', baseDepots),
    dlcProducts: includeDlc ? [product(20, 'Expansion', dlcDepots)] : [],
    eligibleBaseDepotIds,
    eligibleDlcDepotIds: new Map(),
  }
}

function product(appId: number, name: string, depots: Record<number, unknown>) {
  return {
    appId,
    changenumber: 1,
    missingToken: false,
    appinfo: {
      common: { name },
      depots,
    } as unknown as SteamUser.AppInfoContent,
  }
}

function depot(
  manifestId: string,
  size = '10',
  download: string | null = '9',
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    manifests: { public: { gid: manifestId, size, download } },
  }
}
