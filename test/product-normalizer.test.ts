import { afterEach, expect, test } from 'bun:test'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type SteamUser from 'steam-user'
import {
  extractPublicDepots,
  normalizeAppDetails,
  normalizeAppSummary,
} from '../src/backend/apps/product-normalizer.ts'
import type {
  ProductInfo,
  ProductInfoResult,
} from '../src/backend/steam/types.ts'
import { KalamataDatabase } from '../src/db/database.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

const DEPOT_ID = 2379781
const MANIFEST_ID = '3512319404653808464'
const KEY = '16261e41d3e864018778d4a1d81658521a67d9ffb8543ea7e3e21f0685721af1'
const MANIFEST_FIXTURE_PATH = join(
  import.meta.dir,
  'fixtures',
  `${DEPOT_ID}_${MANIFEST_ID}.manifest`,
)
let root: string | undefined
let database: KalamataDatabase | undefined

afterEach(async () => {
  database?.close()
  if (root) await removeTemporaryDirectory(root)
  database = undefined
  root = undefined
})

async function setup(): Promise<KalamataDatabase> {
  root = await mkdtemp(join(tmpdir(), 'kalamata-product-'))
  database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  return database
}

test('normalizes identity, restrictions, and large decimal metadata', async () => {
  const db = await setup()
  const product = makeProduct()
  const details = await normalizeAppDetails(products(product), db)

  expect(normalizeAppSummary(product)).toMatchObject({
    appId: 10,
    name: 'Example',
    developers: ['Developer'],
    publishers: ['Publisher'],
    releaseDate: 1_700_000_000_000,
    iconUrls: [
      'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/10/client-icon-hash.ico',
      'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/10/icon-hash.jpg',
    ],
    artworkUrl:
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg',
  })
  expect(details.depots).toEqual([
    expect.objectContaining({
      depotId: DEPOT_ID,
      ownerAppId: 10,
      group: 'Base Game',
      platform: 'windows, linux',
      language: null,
      manifestId: MANIFEST_ID,
      sizeBytes: '900719925474099312345',
      downloadBytes: '800719925474099312345',
      manifestStatus: 'missing',
      keyStatus: 'missing',
      selectable: false,
    }),
  ])
})

test('handles malformed app metadata and ignores non-depot keys', async () => {
  const db = await setup()
  const product = {
    ...makeProduct(),
    appinfo: {
      common: { steam_release_date: 'bad' },
      depots: { branches: {}, '0': {}, abc: {}, '20': { manifests: {} } },
    },
  } as unknown as ProductInfo
  const details = await normalizeAppDetails(products(product), db)
  expect(details).toMatchObject({
    name: 'App 10',
    publishers: [],
    releaseDate: null,
    iconUrls: [],
    artworkUrl: null,
  })
  expect(details.depots).toHaveLength(1)
  expect(details.depots[0]).toMatchObject({ depotId: 20, manifestId: null })
})

test.skipIf(!(await Bun.file(MANIFEST_FIXTURE_PATH).exists()))(
  'derives ready, invalid, outdated, and installed readiness independently',
  async () => {
    const db = await setup()
    const relativePath = db.addManifest(DEPOT_ID, MANIFEST_ID)
    await copyFile(MANIFEST_FIXTURE_PATH, join(root!, relativePath))

    let depot = (await normalizeAppDetails(products(makeProduct()), db))
      .depots[0]!
    expect(depot).toMatchObject({
      manifestStatus: 'ready',
      keyStatus: 'missing',
      selectable: false,
    })

    db.setDepotKey(DEPOT_ID, KEY)
    db.addLibraryEntry(10)
    const selectedDetails = await normalizeAppDetails(
      products(makeProduct()),
      db,
    )
    expect(selectedDetails).toMatchObject({
      inLibrary: true,
      installPath: null,
      installedDepotIds: [],
    })
    depot = selectedDetails.depots[0]!
    expect(depot).toMatchObject({
      manifestStatus: 'ready',
      keyStatus: 'present',
      installStatus: 'not-installed',
      selectable: true,
    })

    db.recordInstalledDepot(10, root!, DEPOT_ID, MANIFEST_ID)
    depot = (await normalizeAppDetails(products(makeProduct()), db)).depots[0]!
    expect(depot).toMatchObject({ installStatus: 'current', selectable: false })

    const getDepotKey = db.getDepotKey.bind(db)
    db.getDepotKey = (depotId) =>
      depotId === DEPOT_ID ? 'bad' : getDepotKey(depotId)
    depot = (await normalizeAppDetails(products(makeProduct()), db)).depots[0]!
    expect(depot.keyStatus).toBe('invalid')

    db.sqlite
      .query('UPDATE manifest_files SET relative_path = ?')
      .run('manifest-files/1_2.manifest')
    depot = (await normalizeAppDetails(products(makeProduct()), db)).depots[0]!
    expect(depot.manifestStatus).toBe('invalid')

    const outdatedProduct = makeProduct('9999999999999999999')
    depot = (await normalizeAppDetails(products(outdatedProduct), db))
      .depots[0]!
    expect(depot).toMatchObject({
      manifestStatus: 'outdated',
      installStatus: 'outdated',
    })

    db.setDepotPinned(10, DEPOT_ID, true)
    depot = (await normalizeAppDetails(products(outdatedProduct), db))
      .depots[0]!
    expect(depot).toMatchObject({
      installedManifestId: MANIFEST_ID,
      pinned: true,
      installStatus: 'current',
    })
  },
)

test('exposes installed depot IDs in mount order independent of metadata', async () => {
  const db = await setup()
  db.addLibraryEntry(10)
  db.addManifest(999, '123')
  db.addManifest(DEPOT_ID, MANIFEST_ID)
  db.recordInstalledDepot(10, root!, 999, '123')
  db.recordInstalledDepot(10, root!, DEPOT_ID, MANIFEST_ID)

  const details = await normalizeAppDetails(products(makeProduct()), db)

  expect(details.installedDepotIds).toEqual([999, DEPOT_ID])
})

test('exposes installed depots hidden from current Steam metadata', async () => {
  const db = await setup()
  db.addLibraryEntry(10)
  db.addManifest(999, '123')
  db.recordInstalledDepot(10, root!, 999, '123')

  const details = await normalizeAppDetails(products(makeProduct()), db)

  expect(details.installedDepotIds).toEqual([999])
  expect(details.depots).toContainEqual(
    expect.objectContaining({
      depotId: 999,
      manifestId: '123',
      installStatus: 'current',
      manifestStatus: 'invalid',
      selectable: false,
    }),
  )
})

test('collects base then direct DLC depots with first-owner precedence', () => {
  const base = makeProductWithDepots(10, {
    '200': depotMetadata('1'),
    '100': depotMetadata('2'),
    bad: depotMetadata('3'),
  })
  const dlc = makeProductWithDepots(20, {
    '100': depotMetadata('4'),
    '300': depotMetadata('5'),
  })

  expect(extractPublicDepots(products(base, [dlc]))).toEqual([
    expect.objectContaining({
      depotId: 100,
      ownerAppId: 10,
      group: 'Base Game',
      manifestId: '2',
      mountIndex: 0,
    }),
    expect.objectContaining({
      depotId: 200,
      ownerAppId: 10,
      group: 'Base Game',
      mountIndex: 1,
    }),
    expect.objectContaining({
      depotId: 300,
      ownerAppId: 20,
      group: 'DLC',
      mountIndex: 2,
    }),
  ])
})

test('classifies DLC from dlcappid or a containing DLC product', () => {
  const base = makeProductWithDepots(323320, {
    '353590': { ...depotMetadata('1'), dlcappid: '353590' },
  })
  const dlc = makeProductWithDepots(353590, {
    '300': depotMetadata('2'),
  })

  expect(extractPublicDepots(products(base, [dlc]))).toEqual([
    expect.objectContaining({
      depotId: 353590,
      ownerAppId: 353590,
      ownerAppName: 'App 353590',
      group: 'DLC',
    }),
    expect.objectContaining({
      depotId: 300,
      ownerAppId: 353590,
      ownerAppName: 'App 353590',
      group: 'DLC',
    }),
  ])
})

test('classifies unresolved DLC owners as Unknown', async () => {
  const db = await setup()
  const base = makeProductWithDepots(2531310, {
    '2537700': { ...depotMetadata('1'), dlcappid: '2537700' },
  })
  const details = await normalizeAppDetails(products(base), db)

  expect(details.depots).toEqual([
    expect.objectContaining({
      depotId: 2537700,
      ownerAppId: 2537700,
      ownerAppName: 'Unknown App 2537700',
      group: 'Unknown',
      eligible: false,
      selectable: false,
    }),
  ])
})

test('classifies unresolved DLC owners without public content as Unknown', () => {
  const base = makeProductWithDepots(2050650, {
    '2109302': { dlcappid: '2109302' },
  })

  expect(extractPublicDepots(products(base))).toEqual([
    expect.objectContaining({
      depotId: 2109302,
      ownerAppId: 2109302,
      ownerAppName: 'Unknown App 2109302',
      group: 'Unknown',
    }),
  ])
})

test('classifies listed DLCs as DLC when product information is incomplete', () => {
  const base = makeProductWithDepots(883710, {
    '920569': { ...depotMetadata('1'), dlcappid: '920569' },
    '920570': { ...depotMetadata('2'), dlcappid: '920570' },
  })

  expect(
    extractPublicDepots(
      products(base, [], null, new Map(), [920569, 920570]),
    ).map(({ depotId, ownerAppName, group }) => [depotId, ownerAppName, group]),
  ).toEqual([
    [920569, null, 'DLC'],
    [920570, null, 'DLC'],
  ])
})

test('classifies every Steamworks range boundary before ownership', () => {
  const steamworks = [
    228981, 228990, 229000, 229007, 229010, 229012, 229020, 229030, 229033,
  ]
  const adjacent = [
    228980, 228991, 228999, 229008, 229009, 229013, 229019, 229021, 229029,
    229034,
  ]
  const entries = Object.fromEntries(
    [...steamworks, ...adjacent].map((id) => [id, depotMetadata('1')]),
  )
  const depots = extractPublicDepots(
    products(makeProductWithDepots(10, entries)),
  )
  const groups = new Map(depots.map((depot) => [depot.depotId, depot.group]))

  for (const depotId of steamworks)
    expect(groups.get(depotId)).toBe('Steamworks Common Redistributables')
  for (const depotId of adjacent) expect(groups.get(depotId)).toBe('Base Game')
})

test('applies Steamworks then owner then Unused classification precedence', () => {
  const base = makeProductWithDepots(10, {
    '228981': {},
    '400': { config: { language: 'english' }, manifests: { public: {} } },
    '401': depotMetadata('1'),
  })
  const dlc = makeProductWithDepots(20, {
    '500': {},
    '501': depotMetadata('2'),
  })

  expect(
    extractPublicDepots(products(base, [dlc])).map(
      ({ depotId, group }) => [depotId, group] as const,
    ),
  ).toEqual([
    [400, 'Unused'],
    [401, 'Base Game'],
    [228981, 'Steamworks Common Redistributables'],
    [500, 'Unused'],
    [501, 'DLC'],
  ])
})

test('classifies depots without public content as Unused', () => {
  const fields = {
    '600': { config: { oslist: 'bad' }, manifests: { public: {} } },
    '601': { manifests: { public: { gid: 'bad' } } },
    '602': { manifests: { public: { size: 'bad' } } },
    '603': { manifests: { public: { download: 'bad' } } },
    '604': { config: { language: 'english' }, manifests: { public: {} } },
    '605': { config: { oslist: '' }, manifests: { public: {} } },
  }
  const depots = extractPublicDepots(
    products(makeProductWithDepots(10, fields)),
  )
  const groups = new Map(depots.map((depot) => [depot.depotId, depot.group]))

  for (const depotId of [601, 602, 603])
    expect(groups.get(depotId)).toBe('Base Game')
  expect(groups.get(600)).toBe('Unused')
  expect(groups.get(604)).toBe('Unused')
  expect(groups.get(605)).toBe('Unused')
})

test('filters ordinary base depots using the public package grant set', () => {
  const indianaJones = makeProductWithDepots(2677660, {
    '2677661': depotMetadata('1'),
    '2677662': depotMetadata('2'),
    '2677663': depotMetadata('3'),
  })
  const residentEvil = makeProductWithDepots(883710, {
    '883711': depotMetadata('1'),
    '883712': depotMetadata('2'),
    '883713': depotMetadata('3'),
    '883714': depotMetadata('4'),
  })

  expect(
    extractPublicDepots(
      products(indianaJones, [], new Set([2677661, 2677662])),
    ).map(({ depotId, group }) => [depotId, group]),
  ).toEqual([
    [2677661, 'Base Game'],
    [2677662, 'Base Game'],
    [2677663, 'Unavailable'],
  ])
  expect(
    extractPublicDepots(
      products(residentEvil, [], new Set([883711, 883713])),
    ).map(({ depotId, group }) => [depotId, group]),
  ).toEqual([
    [883711, 'Base Game'],
    [883712, 'Unavailable'],
    [883713, 'Base Game'],
    [883714, 'Unavailable'],
  ])
  expect(
    extractPublicDepots(
      products(residentEvil, [], new Set([883712, 883714])),
    ).map(({ depotId, group }) => [depotId, group]),
  ).toEqual([
    [883711, 'Unavailable'],
    [883712, 'Base Game'],
    [883713, 'Unavailable'],
    [883714, 'Base Game'],
  ])
})

test('does not apply base package grants to special or DLC depots', () => {
  const base = makeProductWithDepots(10, {
    '100': { ...depotMetadata('1'), dlcappid: '20' },
    '101': { ...depotMetadata('2'), depotfromapp: '30' },
    '102': { ...depotMetadata('3'), sharedinstall: '1' },
    '228981': depotMetadata('4'),
  })
  const dlc = makeProductWithDepots(20, { '200': depotMetadata('5') })

  expect(
    extractPublicDepots(products(base, [dlc], new Set())).map(
      ({ depotId, group }) => [depotId, group],
    ),
  ).toEqual([
    [100, 'DLC'],
    [101, 'Base Game'],
    [102, 'Base Game'],
    [228981, 'Steamworks Common Redistributables'],
    [200, 'DLC'],
  ])
})

test('filters additional DLC depots using DLC package grants', () => {
  const base = makeProductWithDepots(2050650, {
    '2050655': { ...depotMetadata('1'), dlcappid: '2109300' },
    '2109300': { ...depotMetadata('2'), dlcappid: '2109300' },
  })
  const dlc = makeProductWithDepots(2109300, {})

  expect(
    extractPublicDepots(
      products(base, [dlc], null, new Map([[2109300, new Set([2109300])]])),
    ).map(({ depotId, group }) => [depotId, group]),
  ).toEqual([
    [2050655, 'Unavailable'],
    [2109300, 'DLC'],
  ])
  expect(
    extractPublicDepots(
      products(
        base,
        [dlc],
        null,
        new Map([[2109300, new Set([2109300, 2050655])]]),
      ),
    ).map(({ depotId, group }) => [depotId, group]),
  ).toEqual([
    [2050655, 'DLC'],
    [2109300, 'DLC'],
  ])
})

test('keeps an installed additional DLC depot eligible after package changes', async () => {
  const db = await setup()
  db.addLibraryEntry(2050650)
  db.addManifest(2050655, '1')
  db.recordInstalledDepot(2050650, root!, 2050655, '1')
  const base = makeProductWithDepots(2050650, {
    '2050655': { ...depotMetadata('1'), dlcappid: '2109300' },
    '2109300': { ...depotMetadata('2'), dlcappid: '2109300' },
  })
  const dlc = makeProductWithDepots(2109300, {})

  const details = await normalizeAppDetails(
    products(base, [dlc], null, new Map([[2109300, new Set([2109300])]])),
    db,
  )

  expect(
    details.depots.find(({ depotId }) => depotId === 2050655),
  ).toMatchObject({
    group: 'DLC',
    eligible: true,
    installStatus: 'current',
  })
})

test('keeps installed base depots eligible when package grants change', async () => {
  const db = await setup()
  db.addLibraryEntry(10)
  db.addManifest(DEPOT_ID, MANIFEST_ID)
  db.recordInstalledDepot(10, root!, DEPOT_ID, MANIFEST_ID)

  const details = await normalizeAppDetails(
    products(makeProduct(), [], new Set()),
    db,
  )

  expect(details.depots[0]).toMatchObject({
    depotId: DEPOT_ID,
    group: 'Base Game',
    eligible: true,
    installStatus: 'current',
  })
})

test('keeps ineligible groups visible without resource or install readiness', async () => {
  const db = await setup()
  const keyLookups: number[] = []
  const manifestLookups: number[] = []
  const originalGetDepotKey = db.getDepotKey.bind(db)
  const originalGetManifestRows = db.getManifestRows.bind(db)
  db.getDepotKey = (depotId) => {
    keyLookups.push(depotId)
    return originalGetDepotKey(depotId)
  }
  db.getManifestRows = (depotId) => {
    manifestLookups.push(depotId)
    return originalGetManifestRows(depotId)
  }
  const base = makeProductWithDepots(10, {
    [DEPOT_ID]: depotMetadata(MANIFEST_ID),
    '228981': depotMetadata('2'),
    '700': {},
  })

  const details = await normalizeAppDetails(products(base), db)

  expect(details.depots.map(({ group }) => group)).toEqual([
    'Unused',
    'Steamworks Common Redistributables',
    'Base Game',
  ])
  expect(details.depots.filter((depot) => !depot.eligible)).toEqual([
    expect.objectContaining({
      depotId: 700,
      manifestStatus: null,
      keyStatus: null,
      installStatus: null,
      selectable: false,
    }),
    expect.objectContaining({
      depotId: 228981,
      manifestStatus: null,
      keyStatus: null,
      installStatus: null,
      selectable: false,
    }),
  ])
  expect(keyLookups).toEqual([DEPOT_ID])
  expect(manifestLookups).toEqual([DEPOT_ID])
})

function makeProduct(manifestId = MANIFEST_ID): ProductInfo {
  return {
    appId: 10,
    changenumber: 1,
    missingToken: false,
    appinfo: {
      common: {
        name: 'Example',
        steam_release_date: '1700000000',
        header_image: { english: 'header.jpg' },
        clienticon: 'client-icon-hash',
        icon: 'icon-hash',
        associations: {
          '0': { type: 'developer', name: 'Developer' },
          '1': { type: 'publisher', name: 'Publisher' },
        },
      },
      depots: {
        branches: {},
        [DEPOT_ID]: {
          config: { oslist: 'windows, linux', language: '' },
          manifests: {
            public: {
              gid: manifestId,
              size: '900719925474099312345',
              download: '800719925474099312345',
            },
          },
        },
      },
    } as unknown as SteamUser.AppInfoContent,
  }
}

function products(
  baseProduct: ProductInfo,
  dlcProducts: ProductInfo[] = [],
  eligibleBaseDepotIds: ReadonlySet<number> | null = null,
  eligibleDlcDepotIds: ReadonlyMap<number, ReadonlySet<number>> = new Map(),
  listedDlcAppIds: number[] = dlcProducts.map(({ appId }) => appId),
): ProductInfoResult {
  return {
    baseProduct,
    listedDlcAppIds,
    dlcProducts,
    eligibleBaseDepotIds,
    eligibleDlcDepotIds,
  }
}

function makeProductWithDepots(
  appId: number,
  depots: Record<string, unknown>,
): ProductInfo {
  return {
    appId,
    changenumber: 1,
    missingToken: false,
    appinfo: {
      common: { name: `App ${appId}` },
      depots,
    } as unknown as SteamUser.AppInfoContent,
  }
}

function depotMetadata(manifestId: string) {
  return {
    config: { oslist: 'windows' },
    manifests: {
      public: { gid: manifestId, size: '10', download: '9' },
    },
  }
}
