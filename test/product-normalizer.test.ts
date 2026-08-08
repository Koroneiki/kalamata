import { afterEach, expect, test } from 'bun:test'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type SteamUser from 'steam-user'
import {
  normalizeAppDetails,
  normalizeAppSummary,
} from '../src/backend/steam/product-normalizer.ts'
import type { ProductInfo } from '../src/backend/steam/types.ts'
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
  const details = await normalizeAppDetails(product, db)

  expect(normalizeAppSummary(product)).toMatchObject({
    appId: 10,
    name: 'Example',
    developers: ['Developer'],
    releaseDate: 1_700_000_000_000,
  })
  expect(details.depots).toEqual([
    expect.objectContaining({
      depotId: DEPOT_ID,
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
  const details = await normalizeAppDetails(product, db)
  expect(details).toMatchObject({
    name: 'App 10',
    releaseDate: null,
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

  let depot = (await normalizeAppDetails(makeProduct(), db)).depots[0]!
  expect(depot).toMatchObject({
    manifestStatus: 'ready',
    keyStatus: 'missing',
    selectable: false,
  })

  db.setDepotKey(DEPOT_ID, KEY)
  depot = (await normalizeAppDetails(makeProduct(), db)).depots[0]!
  expect(depot).toMatchObject({
    manifestStatus: 'ready',
    keyStatus: 'ready',
    installStatus: 'not-installed',
    selectable: true,
  })

  db.recordInstalledDepot(10, root!, DEPOT_ID, MANIFEST_ID)
  depot = (await normalizeAppDetails(makeProduct(), db)).depots[0]!
  expect(depot).toMatchObject({ installStatus: 'current', selectable: false })

  db.sqlite.query('UPDATE depot_keys SET decryption_key = ?').run('bad')
  depot = (await normalizeAppDetails(makeProduct(), db)).depots[0]!
  expect(depot.keyStatus).toBe('invalid')

  db.sqlite
    .query('UPDATE manifest_files SET relative_path = ?')
    .run('manifest-files/1_2.manifest')
  depot = (await normalizeAppDetails(makeProduct(), db)).depots[0]!
  expect(depot.manifestStatus).toBe('invalid')

  const outdatedProduct = makeProduct('9999999999999999999')
  depot = (await normalizeAppDetails(outdatedProduct, db)).depots[0]!
  expect(depot).toMatchObject({
    manifestStatus: 'outdated',
    installStatus: 'outdated',
  })
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
        associations: { '0': { type: 'developer', name: 'Developer' } },
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
