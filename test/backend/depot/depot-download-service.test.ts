import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { DepotDownloadService } from '../../../src/backend/depot/depot-download-service.ts'
import type { SteamSession } from '../../../src/backend/steam/steam-session.ts'

const depotId = 2379781
const manifestId = '3512319404653808464'
const manifestPath = join(
  import.meta.dir,
  '..',
  '..',
  'fixtures',
  `${depotId}_${manifestId}.manifest`,
)
const depotKey = Buffer.from(
  '16261e41d3e864018778d4a1d81658521a67d9ffb8543ea7e3e21f0685721af1',
  'hex',
)

test.skipIf(!(await Bun.file(manifestPath).exists()))(
  'loads duplicate manifest resources once while preserving occurrence owners',
  async () => {
    const service = new DepotDownloadService({} as SteamSession)
    const loaded = await service.loadApplicationDepots([
      { depotId, manifestId, manifestPath, depotKey, ownerAppId: 10 },
      { depotId, manifestId, manifestPath, depotKey, ownerAppId: 20 },
    ])

    expect(loaded.map(({ ownerAppId }) => ownerAppId)).toEqual([10, 20])
    expect(loaded[0]!.manifest).toBe(loaded[1]!.manifest)
  },
)
