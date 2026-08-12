import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestAcquisitionService } from '../src/backend/depot/manifests/manifest-acquisition-service.ts'
import type { SteamContentUser } from '../src/backend/steam/types.ts'
import { KalamataDatabase } from '../src/db/database.ts'

const MANIFESTS = [
  { appId: 2379780, depotId: 2379781, manifestId: '3512319404653808464' },
  { appId: 593280, depotId: 593281, manifestId: '7871757316108895128' },
] as const

let root: string | undefined
let database: KalamataDatabase | undefined

afterEach(async () => {
  database?.close()
  database = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('ManifestAcquisitionService', () => {
  test('rejects a valid managed manifest before network access', async () => {
    const request = MANIFESTS[0]
    const db = await openDatabase()
    const path = db.addManifest(request.depotId, request.manifestId)
    await writeFile(join(root!, path), await fixtureContents(request))
    const getClient = mock(async () => {
      throw new Error('should not connect')
    })
    const fetcher = mock(async () => {
      throw new Error('should not fetch')
    })
    const service = new ManifestAcquisitionService({ getClient }, db, fetcher)

    await expect(service.acquire(request)).rejects.toThrow(
      'Manifest is already managed',
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(getClient).not.toHaveBeenCalled()
  })

  test('replaces an invalid managed manifest', async () => {
    const request = MANIFESTS[0]
    const fixture = await fixtureContents(request)
    const db = await openDatabase()
    const path = db.addManifest(request.depotId, request.manifestId)
    await writeFile(join(root!, path), 'invalid')
    const service = createService(db, mockFetcher(), async () => fixture)

    await expect(service.acquire(request)).resolves.toEqual({
      depotId: request.depotId,
      manifestId: request.manifestId,
      relativePath: path,
    })
    expect((await readFile(join(root!, path))).toString('hex')).toBe(
      fixture.toString('hex'),
    )
    expect(db.getManifestRows(request.depotId)).toEqual([
      {
        depotId: request.depotId,
        manifestId: request.manifestId,
        relativePath: path,
      },
    ])
  })

  test('rejects a malformed request code before connecting to Steam', async () => {
    const getClient = mock(async () => {
      throw new Error('should not connect')
    })
    const service = new ManifestAcquisitionService(
      { getClient },
      await openDatabase(),
      mock(async () => new Response('<html>blocked</html>')),
    )

    await expect(service.acquire(MANIFESTS[0])).rejects.toThrow(
      'invalid response',
    )
    expect(getClient).not.toHaveBeenCalled()
  })

  test('rejects a manifest whose embedded IDs differ from the request', async () => {
    const fixture = await fixtureContents(MANIFESTS[0])
    const db = await openDatabase()
    const service = createService(db, mockFetcher(), async () => fixture)

    await expect(
      service.acquire({ ...MANIFESTS[0], depotId: 593281 }),
    ).rejects.toThrow(
      `Manifest belongs to depot ${MANIFESTS[0].depotId}, expected 593281`,
    )
    expect(await readdir(join(root!, 'manifest-files'))).toEqual([])
    expect(db.getManifestRows(MANIFESTS[0].depotId)).toEqual([])
  })

  test('publishes a validated manifest under its embedded IDs and syncs it', async () => {
    const request = MANIFESTS[0]
    const fixture = await fixtureContents(request)
    const db = await openDatabase()
    const service = createService(db, mockFetcher(), async () => fixture)

    await expect(service.acquire(request)).resolves.toEqual({
      depotId: request.depotId,
      manifestId: request.manifestId,
      relativePath: `manifest-files/${request.depotId}_${request.manifestId}.manifest`,
    })
    expect(db.getManifestRows(request.depotId)).toEqual([
      {
        depotId: request.depotId,
        manifestId: request.manifestId,
        relativePath: `manifest-files/${request.depotId}_${request.manifestId}.manifest`,
      },
    ])
    expect(
      (
        await readFile(
          join(
            root!,
            'manifest-files',
            `${request.depotId}_${request.manifestId}.manifest`,
          ),
        )
      ).toString('hex'),
    ).toBe(fixture.toString('hex'))
  })

  test('acquires independent manifests in parallel', async () => {
    const fixtures = new Map<string, Buffer>(
      await Promise.all(
        MANIFESTS.map(
          async (request) =>
            [request.manifestId, await fixtureContents(request)] as const,
        ),
      ),
    )
    const db = await openDatabase()
    const service = createService(db, mockFetcher(), async (data) =>
      fixtures.get(data.toString())!,
    )

    await Promise.all(MANIFESTS.map((request) => service.acquire(request)))

    for (const request of MANIFESTS) {
      expect(db.getManifestRows(request.depotId)).toHaveLength(1)
      expect(
        await Bun.file(
          join(
            root!,
            'manifest-files',
            `${request.depotId}_${request.manifestId}.manifest`,
          ),
        ).exists(),
      ).toBe(true)
    }
  })
})

function createService(
  db: KalamataDatabase,
  fetcher: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
  decompress: (data: Buffer) => Promise<Buffer>,
): ManifestAcquisitionService {
  const client = {
    getContentServers: async () => ({
      servers: [
        {
          Host: 'cdn.example.test',
          vhost: 'content.example.test',
          https_support: 'mandatory',
          weightedload: 1,
        },
      ],
    }),
  } as unknown as SteamContentUser
  return new ManifestAcquisitionService(
    { getClient: async () => client },
    db,
    fetcher,
    decompress,
  )
}

function mockFetcher(): (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith('http://gmrc.wudrm.com/manifest/')) {
      return new Response('10907614392502571426')
    }
    const manifestId = /\/manifest\/(\d+)\/5\//u.exec(url)?.[1]
    if (!manifestId) return new Response(null, { status: 404 })
    return new Response(manifestId)
  })
}

async function fixtureContents(request: {
  depotId: number
  manifestId: string
}): Promise<Buffer> {
  return readFile(
    join(
      import.meta.dir,
      'fixtures',
      `${request.depotId}_${request.manifestId}.manifest`,
    ),
  )
}

async function openDatabase(): Promise<KalamataDatabase> {
  root = await mkdtemp(join(tmpdir(), 'manifest-acquisition-'))
  database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  return database
}
