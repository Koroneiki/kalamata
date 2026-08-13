import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractPublicDepots } from '../src/backend/apps/product-normalizer.ts'
import { DepotKeyAcquisitionService } from '../src/backend/depot/keys/depot-key-acquisition-service.ts'
import { parseManifest } from '../src/backend/depot/manifests/manifest-codec.ts'
import { ManifestAcquisitionService } from '../src/backend/depot/manifests/manifest-acquisition-service.ts'
import { DIRECTORY } from '../src/backend/depot/manifests/manifest-utils.ts'
import { ProductInfoService } from '../src/backend/steam/product-info-service.ts'
import { SteamSession } from '../src/backend/steam/steam-session.ts'
import { KalamataDatabase } from '../src/db/database.ts'
import { depotKeyFromHex } from '../src/db/validation.ts'
import { downloadManifestFile } from './helpers/download-manifest-file.integration.ts'

const APP_ID = 2379780
const DEPOT_ID = 2379781

test.skipIf(process.env.BALATRO_LIVE_INTEGRATION !== '1')(
  'acquires current Balatro resources and verifies a live file download',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'balatro-live-'))
    const database = await KalamataDatabase.open(
      root,
      join(import.meta.dir, '..', 'src', 'db', 'migrations'),
    )
    const session = new SteamSession()
    const keys = new DepotKeyAcquisitionService(database)
    const manifests = new ManifestAcquisitionService(session, database)

    try {
      const product = await new ProductInfoService(
        session,
      ).getProductInfoWithDlc(APP_ID)
      const depot = extractPublicDepots(product).find(
        (candidate) => candidate.depotId === DEPOT_ID,
      )
      expect(depot?.manifestId).toMatch(/^\d+$/u)
      if (!depot?.manifestId)
        throw new Error('Balatro depot has no current public manifest')
      const manifestId = depot.manifestId

      const acquiredKeys = await keys.acquire({
        appId: APP_ID,
        depotIds: [DEPOT_ID],
      })
      expect(acquiredKeys).toEqual({
        acquiredDepotIds: [DEPOT_ID],
        missingDepotIds: [],
      })
      const depotKey = depotKeyFromHex(database.getDepotKey(DEPOT_ID) ?? '')
      const acquiredManifest = await manifests.acquire({
        appId: depot.ownerAppId,
        depotId: DEPOT_ID,
        manifestId,
      })
      expect(acquiredManifest.manifestId).toBe(manifestId)

      const manifest = parseManifest(
        await readFile(join(database.dataRoot, acquiredManifest.relativePath)),
        depotKey,
      )
      const file = manifest.files
        .filter(
          (candidate) =>
            !(candidate.flags & DIRECTORY) && candidate.chunks.length > 0,
        )
        .toSorted(
          (left, right) => compressedSize(left) - compressedSize(right),
        )[0]
      if (!file) throw new Error('Live manifest has no downloadable files')

      const metrics = await downloadManifestFile(
        depot.ownerAppId,
        DEPOT_ID,
        depotKey,
        file,
      )
      expect(metrics.networkBytes).toBeGreaterThan(0)
      expect(metrics.size).toBe(Number(file.size))
      expect(metrics.sha1).toBe(file.sha_content.toLowerCase())
    } finally {
      await Promise.allSettled([manifests.shutdown(), keys.shutdown()])
      session.dispose()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  300_000,
)

function compressedSize(file: {
  chunks: { sha: string; cb_compressed: number }[]
}) {
  return [...Map.groupBy(file.chunks, (chunk) => chunk.sha).values()].reduce(
    (total, chunks) => total + chunks[0]!.cb_compressed,
    0,
  )
}
