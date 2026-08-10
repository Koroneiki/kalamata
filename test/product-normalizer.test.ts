import { afterEach, expect, test } from 'bun:test'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type SteamUser from 'steam-user'
import {
  extractPublicDepots,
  normalizeAppDetails,
  normalizeAppSummary,
} from '../src/backend/steam/product-normalizer.ts'
import type {
  ProductInfo,
  ProductInfoResult,
} from '../src/backend/steam/types.ts'
import { KalamataDatabase } from '../src/db/database.ts'

const DEPOT_ID = 2379781
const MANIFEST_ID = '3512319404653808464'
const KEY = '16261e41d3e864018778d4a1d81658521a67d9ffb8543ea7e3e21f0685721af1'
let root: string | undefined
let database: KalamataDatabase | undefined

afterEach(async () => {
  database?.close()
  if (root) await rm(root, { recursive: true, force: true })
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

test('derives ready, invalid, outdated, and installed readiness independently', async () => {
  const db = await setup()
  const relativePath = db.addManifest(DEPOT_ID, MANIFEST_ID)
  await copyFile(
    join(import.meta.dir, 'fixtures', `${DEPOT_ID}_${MANIFEST_ID}.manifest`),
    join(root!, relativePath),
  )

  let depot = (await normalizeAppDetails(products(makeProduct()), db))
    .depots[0]!
  expect(depot).toMatchObject({
    manifestStatus: 'ready',
    keyStatus: 'missing',
    selectable: false,
  })

  db.setDepotKey(DEPOT_ID, KEY)
  depot = (await normalizeAppDetails(products(makeProduct()), db)).depots[0]!
  expect(depot).toMatchObject({
    manifestStatus: 'ready',
    keyStatus: 'ready',
    installStatus: 'not-installed',
    selectable: true,
  })

  db.recordInstalledDepot(10, root!, DEPOT_ID, MANIFEST_ID)
  depot = (await normalizeAppDetails(products(makeProduct()), db)).depots[0]!
  expect(depot).toMatchObject({ installStatus: 'current', selectable: false })

  db.sqlite.query('UPDATE depot_keys SET decryption_key = ?').run('bad')
  depot = (await normalizeAppDetails(products(makeProduct()), db)).depots[0]!
  expect(depot.keyStatus).toBe('invalid')

  db.sqlite
    .query('UPDATE manifest_files SET relative_path = ?')
    .run('manifest-files/1_2.manifest')
  depot = (await normalizeAppDetails(products(makeProduct()), db)).depots[0]!
  expect(depot.manifestStatus).toBe('invalid')

  const outdatedProduct = makeProduct('9999999999999999999')
  depot = (await normalizeAppDetails(products(outdatedProduct), db)).depots[0]!
  expect(depot).toMatchObject({
    manifestStatus: 'outdated',
    installStatus: 'outdated',
  })
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
    }),
    expect.objectContaining({
      depotId: 200,
      ownerAppId: 10,
      group: 'Base Game',
    }),
    expect.objectContaining({
      depotId: 300,
      ownerAppId: 20,
      group: 'DLC',
    }),
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

test('applies Steamworks then Unused then owner classification precedence', () => {
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
    [500, 'Unused'],
    [501, 'DLC'],
    [228981, 'Steamworks Common Redistributables'],
  ])
})

test('requires all four raw fields to be empty for Unused', () => {
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

  for (const depotId of [600, 601, 602, 603])
    expect(groups.get(depotId)).toBe('Base Game')
  expect(groups.get(604)).toBe('Unused')
  expect(groups.get(605)).toBe('Unused')
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
): ProductInfoResult {
  return { baseProduct, dlcProducts }
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
