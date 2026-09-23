import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestAcquisitionService } from '../src/backend/depot/manifests/manifest-acquisition-service.ts'
import { BackgroundDownloadCoordinator } from '../src/backend/downloads/background-download-coordinator.ts'
import type { SteamContentUser } from '../src/backend/steam/types.ts'
import { KalamataDatabase } from '../src/db/database.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

const MANIFESTS = [
  { appId: 2379780, depotId: 2379781, manifestId: '3512319404653808464' },
  { appId: 593280, depotId: 593281, manifestId: '7871757316108895128' },
] as const
const hasManifestFixtures = (
  await Promise.all(
    MANIFESTS.map(({ depotId, manifestId }) =>
      Bun.file(
        join(import.meta.dir, 'fixtures', `${depotId}_${manifestId}.manifest`),
      ).exists(),
    ),
  )
).every(Boolean)
const fixtureTest = test.skipIf(!hasManifestFixtures)
const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip') as {
  new (): {
    addFile(name: string, contents: Buffer): void
    toBuffer(): Buffer
  }
}
const SETTINGS = {
  automaticManifestAcquisition: true,
  hubcapApiKey: 'secret',
  hideRedistributables: true,
  hideUnknownDepots: true,
  hideUnusedDepots: true,
  hideUnavailableDepots: true,
  platforms: ['macos'] as const,
}

let root: string | undefined
let database: KalamataDatabase | undefined

afterEach(async () => {
  database?.close()
  database = undefined
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

describe('ManifestAcquisitionService', () => {
  fixtureTest(
    'returns a valid managed manifest before network access',
    async () => {
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

      await expect(service.acquire(request)).resolves.toEqual({
        manifest: {
          depotId: request.depotId,
          manifestId: request.manifestId,
          relativePath: path,
        },
      })
      expect(fetcher).not.toHaveBeenCalled()
      expect(getClient).not.toHaveBeenCalled()
    },
  )

  fixtureTest('replaces an invalid managed manifest', async () => {
    const request = MANIFESTS[0]
    const fixture = await fixtureContents(request)
    const db = await openDatabase()
    const path = db.addManifest(request.depotId, request.manifestId)
    await writeFile(join(root!, path), 'invalid')
    const service = createService(db, mockFetcher(), async () => fixture)

    await expect(service.acquire(request)).resolves.toEqual({
      manifest: {
        depotId: request.depotId,
        manifestId: request.manifestId,
        relativePath: path,
      },
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

  test('reports a missing Hubcap key when request-code lookup fails', async () => {
    const getClient = mock(async () => {
      throw new Error('should not connect')
    })
    const service = new ManifestAcquisitionService(
      { getClient },
      await openDatabase(),
      mock(async () => new Response('<html>blocked</html>')),
    )

    await expect(service.acquire(MANIFESTS[0])).resolves.toEqual({
      manifest: null,
      hubcap: { status: 'missing-key' },
    })
    expect(getClient).not.toHaveBeenCalled()
  })

  test('requests codes from ManifestDeX with the required client identity', async () => {
    const fetcher = mock(async () => new Response('invalid'))
    const service = new ManifestAcquisitionService(
      {
        getClient: async () => {
          throw new Error('should not connect')
        },
      },
      await openDatabase(),
      fetcher,
    )

    await expect(service.acquire(MANIFESTS[0])).resolves.toMatchObject({
      manifest: null,
      hubcap: { status: 'missing-key' },
    })
    expect(fetcher).toHaveBeenCalledWith(
      `https://manifest.manifestdex.com/${MANIFESTS[0].manifestId}`,
      expect.objectContaining({
        headers: { 'User-Agent': 'ManifestDeX/1.0' },
      }),
    )
  })

  fixtureTest(
    'checks contents before quota and downloads an advertised manifest ZIP',
    async () => {
      const request = MANIFESTS[0]
      const fixture = await fixtureContents(request)
      const archive = new AdmZip()
      archive.addFile(
        `${request.depotId}_${request.manifestId}.manifest`,
        fixture,
      )
      const calls: string[] = []
      let statsCalls = 0
      const db = await openDatabase()
      db.updateSettings({ ...SETTINGS, platforms: [...SETTINGS.platforms] })
      const fetcher = mock(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          calls.push(url)
          if (url.startsWith('https://manifest.manifestdex.com/')) {
            return new Response(null, { status: 503 })
          }
          expect(new Headers(init?.headers).get('Authorization')).toBe(
            'Bearer secret',
          )
          if (url.endsWith('/contents')) {
            return manifestContents(request)
          }
          if (url.endsWith('/user/stats')) {
            statsCalls++
            return hubcapUsage(statsCalls === 1 ? 89 : 90)
          }
          if (url.endsWith(`/api/v1/manifest/${request.appId}`)) {
            return new Response(Uint8Array.from(archive.toBuffer()).buffer)
          }
          throw new Error(`Unexpected request: ${url}`)
        },
      )
      const service = createService(db, fetcher, async () => {
        throw new Error('Steam decompression must not run')
      })

      await expect(service.acquire(request)).resolves.toEqual({
        manifest: {
          depotId: request.depotId,
          manifestId: request.manifestId,
          relativePath: `manifest-files/${request.depotId}_${request.manifestId}.manifest`,
        },
        hubcap: {
          status: 'fetched',
          usage: {
            dailyUsage: 90,
            dailyLimit: 100,
            remaining: 10,
            canMakeRequests: true,
          },
        },
      })
      expect(calls.map((url) => new URL(url).pathname)).toEqual([
        `/${request.manifestId}`,
        `/api/v1/manifest/${request.appId}/contents`,
        '/api/v1/user/stats',
        `/api/v1/manifest/${request.appId}`,
        '/api/v1/user/stats',
      ])
    },
  )

  test('requires approval before a low-quota Hubcap manifest request', async () => {
    const request = MANIFESTS[0]
    const db = await openDatabase()
    db.updateSettings({ ...SETTINGS, platforms: [...SETTINGS.platforms] })
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://manifest.manifestdex.com/')) {
        return new Response(null, { status: 403 })
      }
      if (url.endsWith('/contents')) return manifestContents(request)
      if (url.endsWith('/user/stats')) return hubcapUsage(90)
      throw new Error('Paid Hubcap request must not run without approval')
    })
    const service = createService(db, fetcher, async () => Buffer.alloc(0))

    await expect(service.acquire(request)).resolves.toEqual({
      manifest: null,
      hubcap: {
        status: 'approval-required',
        usage: {
          dailyUsage: 90,
          dailyLimit: 100,
          remaining: 10,
          canMakeRequests: true,
        },
      },
    })
    expect(
      fetcher.mock.calls.some(
        ([input]) =>
          String(input).endsWith(`/api/v1/manifest/${request.appId}`) &&
          !String(input).endsWith('/contents'),
      ),
    ).toBe(false)
  })

  test('does not spend quota when Hubcap lacks the requested manifest', async () => {
    const request = MANIFESTS[0]
    const db = await openDatabase()
    db.updateSettings({ ...SETTINGS, platforms: [...SETTINGS.platforms] })
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://manifest.manifestdex.com/')) {
        return new Response('blocked')
      }
      if (url.endsWith('/contents')) {
        return manifestContents({ ...request, manifestId: '1' })
      }
      throw new Error('Quota and ZIP endpoints must not be requested')
    })
    const service = createService(db, fetcher, async () => Buffer.alloc(0))

    await expect(service.acquire(request)).rejects.toThrow(
      'Manifest request code lookup failed',
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  fixtureTest(
    'rejects a manifest whose embedded IDs differ from the request',
    async () => {
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
    },
  )

  fixtureTest(
    'publishes a validated manifest under its embedded IDs and syncs it',
    async () => {
      const request = MANIFESTS[0]
      const fixture = await fixtureContents(request)
      const db = await openDatabase()
      const service = createService(db, mockFetcher(), async () => fixture)

      await expect(service.acquire(request)).resolves.toEqual({
        manifest: {
          depotId: request.depotId,
          manifestId: request.manifestId,
          relativePath: `manifest-files/${request.depotId}_${request.manifestId}.manifest`,
        },
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
    },
  )

  fixtureTest(
    'cancels a streamed manifest before publication and cleans its workspace',
    async () => {
      const request = MANIFESTS[0]
      const db = await openDatabase()
      let transferStarted!: () => void
      const started = new Promise<void>((resolve) => {
        transferStarted = resolve
      })
      const receivedSignal: { value: AbortSignal | null } = { value: null }
      const fetcher = mock(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).startsWith('https://manifest.manifestdex.com/'))
            return new Response('12345')
          receivedSignal.value = init?.signal ?? null
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]))
                transferStarted()
              },
            }),
          )
        },
      )
      const service = createService(db, fetcher, async () =>
        fixtureContents(request),
      )
      const coordinator = new BackgroundDownloadCoordinator(root!, () => {})
      await coordinator.initialize()
      try {
        const operation = coordinator.enqueue({
          key: `manifest:${request.depotId}:${request.manifestId}`,
          kind: 'manifest',
          title: 'Manifest',
          run: (context) => service.acquireWithContext(request, context),
        })
        await started
        await coordinator.shutdown()
        await expect(operation).rejects.toThrow()
        expect(receivedSignal.value?.aborted).toBe(true)
        expect(db.getManifestRows(request.depotId)).toEqual([])
        expect(await readdir(join(root!, 'manifest-files'))).toEqual([])
        await expect(
          readdir(join(root!, 'background-downloads')),
        ).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await coordinator.shutdown()
      }
    },
  )

  fixtureTest('acquires independent manifests in parallel', async () => {
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

  test('shares one acquisition for duplicate concurrent requests', async () => {
    const fetcher = mock(async () => new Response('invalid'))
    const service = new ManifestAcquisitionService(
      {
        getClient: async () => {
          throw new Error('should not connect')
        },
      },
      await openDatabase(),
      fetcher,
    )

    const requests = [
      service.acquire(MANIFESTS[0]),
      service.acquire(MANIFESTS[0]),
    ]

    await Promise.all(
      requests.map((request) =>
        expect(request).resolves.toMatchObject({
          manifest: null,
          hubcap: { status: 'missing-key' },
        }),
      ),
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('serializes request-code lookups for independent manifests', async () => {
    let activeLookups = 0
    let maximumActiveLookups = 0
    const fetcher = mock(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://manifest.manifestdex.com/')) {
        activeLookups += 1
        maximumActiveLookups = Math.max(maximumActiveLookups, activeLookups)
        await Bun.sleep(10)
        activeLookups -= 1
        return new Response('invalid')
      }
      throw new Error('should not reach Steam CDN')
    })
    const service = new ManifestAcquisitionService(
      {
        getClient: async () => {
          throw new Error('should not connect')
        },
      },
      await openDatabase(),
      fetcher,
    )

    await Promise.allSettled(
      MANIFESTS.map((request) => service.acquire(request)),
    )

    expect(maximumActiveLookups).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(MANIFESTS.length)
  })

  test('cancels pending acquisition during shutdown', async () => {
    const service = new ManifestAcquisitionService(
      {
        getClient: async () => {
          throw new Error('should not connect')
        },
      },
      await openDatabase(),
      () => new Promise(() => {}),
    )
    const acquisition = service.acquire(MANIFESTS[0])

    await service.shutdown()

    await expect(acquisition).rejects.toThrow('cancelled')
    await expect(service.acquire(MANIFESTS[0])).rejects.toThrow('shutting down')
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

function manifestContents(request: {
  appId: number
  depotId: number
  manifestId: string
}) {
  return Response.json({
    app_id: String(request.appId),
    branch: 'public',
    zip_exists: true,
    manifest_count: 1,
    manifests: [
      {
        depot_id: String(request.depotId),
        manifest_id: request.manifestId,
        filename: `${request.depotId}_${request.manifestId}.manifest`,
      },
    ],
    file_size: 51234,
    last_modified: '2026-09-10T17:20:00',
  })
}

function hubcapUsage(dailyUsage: number) {
  return Response.json({
    daily_usage: dailyUsage,
    daily_limit: 100,
    can_make_requests: dailyUsage < 100,
  })
}

function mockFetcher(): (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith('https://manifest.manifestdex.com/')) {
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
