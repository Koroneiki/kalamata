import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DepotKeyAcquisitionService as BaseDepotKeyAcquisitionService } from '../src/backend/depot/keys/depot-key-acquisition-service.ts'
import { BackgroundDownloadCoordinator } from '../src/backend/downloads/background-download-coordinator.ts'
import { KalamataDatabase } from '../src/db/database.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

// Source-precedence tests supply a successful probe; verification itself is tested below.
class DepotKeyAcquisitionService extends BaseDepotKeyAcquisitionService {
  constructor(
    db: KalamataDatabase,
    fetcher: NonNullable<
      ConstructorParameters<typeof BaseDepotKeyAcquisitionService>[1]
    >,
    coordinator?: BackgroundDownloadCoordinator,
  ) {
    super(db, fetcher, coordinator, async () => true)
  }
}

const LUA_KEY = 'a'.repeat(64)
const JSON_KEY = 'b'.repeat(64)
const HUBCAP_KEY = 'c'.repeat(64)
const require = createRequire(import.meta.url)
// SAFETY: adm-zip exports the archive constructor used by the ZIP fixture.
const AdmZip = require('adm-zip') as new () => {
  addFile(name: string, contents: Buffer): void
  toBuffer(): Buffer
}
function hubcapZip(lua: string): Response {
  const zip = new AdmZip()
  zip.addFile('100.lua', Buffer.from(lua))
  return new Response(Uint8Array.from(zip.toBuffer()).buffer)
}
const SETTINGS = {
  automaticManifestAcquisition: true,
  hubcapApiKey: '',
  hideRedistributables: true,
  hideUnknownDepots: true,
  hideUnusedDepots: true,
  hideUnavailableDepots: true,
  platforms: ['macos'] as const,
}

function hubcapDepotIds(...depotIds: number[]) {
  return Response.json({
    status: 'success',
    total_depot_ids: depotIds.length,
    pending_count: 0,
    existing_count: depotIds.length,
    pending_depot_ids: [],
    existing_depot_ids: depotIds.map(String),
    depot_ids: depotIds.map(String),
    timestamp: '2026-08-19T12:00:00Z',
  })
}

let root: string | undefined
let database: KalamataDatabase | undefined

afterEach(async () => {
  database?.close()
  database = undefined
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

describe('DepotKeyAcquisitionService', () => {
  test('keeps depot keys in the database when library entries are removed', async () => {
    const db = await openDatabase()
    db.addLibraryEntry(100)
    db.addLibraryEntry(101)
    db.setDepotKey(10, LUA_KEY)
    db.setDepotKey(11, JSON_KEY)
    for (const [appId, depotId] of [
      [100, 10],
      [101, 10],
      [100, 11],
    ]) {
      db.sqlite
        .query(
          'INSERT INTO library_depot_installs (app_id, depot_id, installed_manifest_id, mount_index, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(appId, depotId, '1', depotId, Date.now())
    }
    db.removeLibraryEntry(100)
    expect(db.getDepotKey(10)).toBe(LUA_KEY)
    expect(db.getDepotKey(11)).toBe(JSON_KEY)
    db.removeLibraryEntry(101)
    expect(db.getDepotKey(10)).toBe(LUA_KEY)
  })
  test('tries Lua after an invalid 993 key without exporting it to JSON', async () => {
    const db = await openDatabase()
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('api.993499094.xyz'))
        return Response.json({ 10: JSON_KEY })
      if (url.includes('/sojogamesdatabase1/100/100.lua'))
        return new Response(
          `addappid(10, 0, "${LUA_KEY}")\naddappid(11, 0, "${LUA_KEY}")`,
        )
      return new Response(null, { status: 404 })
    })
    const verify = mock(
      async (_app: number, _depot: number, key: Buffer) =>
        key.toString('hex') === LUA_KEY,
    )
    const service = new BaseDepotKeyAcquisitionService(
      db,
      fetcher,
      undefined,
      verify,
    )

    expect(await service.acquire({ appId: 100, depotIds: [10] })).toMatchObject(
      { acquiredDepotIds: [10] },
    )
    expect(verify.mock.calls.map(([, , key]) => key.toString('hex'))).toEqual([
      JSON_KEY,
      LUA_KEY,
    ])
    expect(db.getDepotKey(10)).toBe(LUA_KEY)
    expect(
      JSON.parse(
        await readFile(join(root!, 'depot-keys', '993499094.json'), 'utf8'),
      ),
    ).toEqual({ 10: JSON_KEY })
  })

  test('uses the second repository only when the first has no matching key', async () => {
    const db = await openDatabase()
    const visited: string[] = []
    const service = new DepotKeyAcquisitionService(db, async (input) => {
      const url = String(input)
      visited.push(url)
      if (url.endsWith('/depotkeys.json')) return Response.json({})
      if (url.includes('/sojogames2/100/100.lua'))
        return new Response(`addappid(10, 1, "${LUA_KEY}")`)
      return new Response(null, { status: 404 })
    })
    expect(await service.acquire({ appId: 100, depotIds: [10] })).toMatchObject(
      { acquiredDepotIds: [10] },
    )
    expect(
      visited
        .filter((url) => url.endsWith('/100/100.lua'))
        .map((url) => new URL(url).pathname),
    ).toEqual([
      '/dvahana2424-web/sojogamesdatabase1/100/100.lua',
      '/hammerwebsite12/sojogames2/100/100.lua',
    ])
  })
  test('publishes only verified candidates and falls back to the next source', async () => {
    const db = await openDatabase()
    const verify = mock(
      async (_appId: number, _depotId: number, key: Buffer) =>
        key.toString('hex') === JSON_KEY,
    )
    const fetcher = mock(async (input: string | URL | Request) =>
      String(input).endsWith('/100/100.lua')
        ? new Response(`addappid(10, 0, "${LUA_KEY}")`)
        : Response.json({ 10: JSON_KEY }),
    )
    const service = new BaseDepotKeyAcquisitionService(
      db,
      fetcher,
      undefined,
      verify,
    )

    expect(await service.acquire({ appId: 100, depotIds: [10] })).toEqual({
      acquiredDepotIds: [10],
      missingDepotIds: [],
    })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(db.getDepotKey(10)).toBe(JSON_KEY)
  })

  test('does not store a key when its probe cannot succeed', async () => {
    const db = await openDatabase()
    const service = new BaseDepotKeyAcquisitionService(
      db,
      async (input) =>
        String(input).endsWith('/100/100.lua')
          ? new Response(`addappid(10, 0, "${LUA_KEY}")`)
          : Response.json({ 10: JSON_KEY }),
      undefined,
      async () => false,
    )

    expect(await service.acquire({ appId: 100, depotIds: [10] })).toMatchObject(
      {
        acquiredDepotIds: [],
        missingDepotIds: [10],
      },
    )
    expect(db.getDepotKey(10)).toBeNull()
  })

  test('cancels a shared Lua source without publishing keys', async () => {
    const db = await openDatabase()
    const coordinator = new BackgroundDownloadCoordinator(root!, () => {})
    await coordinator.initialize()
    let started!: () => void
    const requested = new Promise<void>((resolve) => {
      started = resolve
    })
    let sourceAborted = false
    const fetcher = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        started()
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              sourceAborted = true
              reject(init.signal!.reason)
            },
            { once: true },
          )
        })
      },
    )
    const service = new DepotKeyAcquisitionService(db, fetcher, coordinator)
    try {
      const operation = coordinator.enqueue({
        key: 'depot-keys:100:10',
        kind: 'depot-keys',
        title: 'Depot keys',
        run: (context) =>
          service.acquireWithContext({ appId: 100, depotIds: [10] }, context),
      })
      await requested
      await coordinator.shutdown()
      await expect(operation).rejects.toThrow()
      expect(sourceAborted).toBe(true)
      expect(db.getDepotKey(10)).toBeNull()
    } finally {
      await service.shutdown()
      await coordinator.shutdown()
    }
  })

  test('prefers 993 keys and resolves remaining requested depots from Lua', async () => {
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua')) {
        return new Response(
          `addappid(10, 0, "${LUA_KEY}")\naddappid(11, 0, "${LUA_KEY}")`,
        )
      }
      return new Response(JSON.stringify({ 10: JSON_KEY, 12: JSON_KEY }))
    })
    const db = await openDatabase()
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10, 11] }),
    ).resolves.toEqual({
      acquiredDepotIds: [10, 11],
      missingDepotIds: [],
    })
    expect(db.getDepotKey(10)).toBe(JSON_KEY)
    expect(db.getDepotKey(11)).toBe(LUA_KEY)
    expect(db.getDepotKey(12)).toBeNull()
    expect(
      JSON.parse(
        await readFile(join(root!, 'depot-keys', '993499094.json'), 'utf8'),
      ),
    ).toEqual({ 10: JSON_KEY, 12: JSON_KEY })
  })

  test('uses valid requested cache keys without rejecting malformed entries', async () => {
    const fetcher = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith('/100/100.lua'))
        return new Response(null, { status: 404 })
      return new Response(
        JSON.stringify({ 10: JSON_KEY.toUpperCase(), 11: 'invalid' }),
      )
    })
    const service = new DepotKeyAcquisitionService(
      await openDatabase(),
      fetcher,
    )

    await expect(
      service.acquire({ appId: 100, depotIds: [10, 11] }),
    ).resolves.toEqual({
      acquiredDepotIds: [10],
      missingDepotIds: [11],
      hubcap: { status: 'missing-key' },
    })
  })

  test('retries a transiently unavailable Lua source', async () => {
    let attempts = 0
    const fetcher = mock(async (input: string | URL | Request) => {
      if (String(input).includes('/sojogames2/'))
        return new Response(null, { status: 404 })
      if (String(input).endsWith('/100/100.lua')) {
        attempts++
        return attempts === 1
          ? new Response(null, { status: 503 })
          : new Response(`addappid(10, 0, "${LUA_KEY}")`)
      }
      return new Response('{}')
    })
    const service = new DepotKeyAcquisitionService(
      await openDatabase(),
      fetcher,
    )

    await expect(
      service.acquire({ appId: 100, depotIds: [10] }),
    ).resolves.toEqual({
      acquiredDepotIds: [],
      missingDepotIds: [10],
      hubcap: { status: 'missing-key' },
    })
    await expect(
      service.acquire({ appId: 100, depotIds: [10] }),
    ).resolves.toEqual({ acquiredDepotIds: [10], missingDepotIds: [] })
  })

  test('preserves existing keys without network access', async () => {
    const db = await openDatabase()
    db.setDepotKey(10, LUA_KEY)
    const fetcher = mock(async () => {
      throw new Error('should not fetch')
    })
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10] }),
    ).resolves.toEqual({
      acquiredDepotIds: [10],
      missingDepotIds: [],
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('requires approval at ten remaining and refreshes usage after one approved request', async () => {
    const db = await openDatabase()
    db.updateSettings({
      ...SETTINGS,
      platforms: [...SETTINGS.platforms],
      hubcapApiKey: 'secret',
    })
    let statsCalls = 0
    const fetcher = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/100/100.lua'))
          return new Response(null, { status: 404 })
        if (url.endsWith('/depotkeys.json')) return new Response('{}')
        if (url.endsWith('/api/v1/depot-keys')) return hubcapDepotIds(10)
        if (url.endsWith('/user/stats')) {
          statsCalls++
          return Response.json({
            daily_usage: statsCalls === 1 ? 90 : statsCalls === 2 ? 90 : 91,
            daily_limit: 100,
            can_make_requests: true,
          })
        }
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer secret',
        )
        return hubcapZip(
          `addappid(10, 0, "${HUBCAP_KEY}")\naddappid(99, 0, "${LUA_KEY}")`,
        )
      },
    )
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10] }),
    ).resolves.toEqual({
      acquiredDepotIds: [],
      missingDepotIds: [10],
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
      fetcher.mock.calls.some(([input]) =>
        String(input).includes('/api/v1/lua/'),
      ),
    ).toBe(false)

    const approved = await service.acquire({
      appId: 100,
      depotIds: [10],
      approveLowQuotaHubcap: true,
    })
    expect(approved.hubcap).toEqual({
      status: 'fetched',
      usage: {
        dailyUsage: 91,
        dailyLimit: 100,
        remaining: 9,
        canMakeRequests: true,
      },
      acquiredDepotIds: [10],
    })
    expect(db.getDepotKey(10)).toBe(HUBCAP_KEY)
    expect(db.getDepotKey(99)).toBeNull()
    expect(statsCalls).toBe(3)
  })

  test('proceeds at eleven remaining and reuses the Hubcap ZIP for a second key', async () => {
    const db = await openDatabase()
    db.updateSettings({
      ...SETTINGS,
      platforms: [...SETTINGS.platforms],
      hubcapApiKey: 'secret',
    })
    let hubcapLuaCalls = 0
    let statsCalls = 0
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua'))
        return new Response(null, { status: 404 })
      if (url.endsWith('/depotkeys.json')) return new Response('{}')
      if (url.endsWith('/api/v1/depot-keys')) return hubcapDepotIds(10, 11)
      if (url.endsWith('/user/stats')) {
        statsCalls++
        return Response.json({
          daily_usage: statsCalls === 1 ? 89 : 90,
          daily_limit: 100,
          can_make_requests: true,
        })
      }
      hubcapLuaCalls++
      return hubcapZip(
        `addappid(10, 0, "${HUBCAP_KEY}")\naddappid(11, 0, "${LUA_KEY}")`,
      )
    })
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10] }),
    ).resolves.toMatchObject({
      acquiredDepotIds: [10],
      hubcap: { status: 'fetched', acquiredDepotIds: [10] },
    })
    await expect(
      service.acquire({ appId: 100, depotIds: [11] }),
    ).resolves.toMatchObject({
      acquiredDepotIds: [11],
      missingDepotIds: [],
    })
    expect(hubcapLuaCalls).toBe(1)
    expect(statsCalls).toBe(2)
  })

  test('does not download Lua when Hubcap rejects the saved key', async () => {
    const db = await openDatabase()
    db.updateSettings({
      ...SETTINGS,
      platforms: [...SETTINGS.platforms],
      hubcapApiKey: 'bad',
    })
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua'))
        return new Response(null, { status: 404 })
      if (url.endsWith('/depotkeys.json')) return new Response('{}')
      if (url.endsWith('/api/v1/depot-keys'))
        return new Response(null, { status: 401 })
      throw new Error('Hubcap Lua must not be requested')
    })
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10] }),
    ).resolves.toEqual({
      acquiredDepotIds: [],
      missingDepotIds: [10],
      hubcap: { status: 'invalid-key' },
    })
  })

  test('skips Hubcap Lua when usage is unavailable or disallowed', async () => {
    const db = await openDatabase()
    db.updateSettings({
      ...SETTINGS,
      platforms: [...SETTINGS.platforms],
      hubcapApiKey: 'secret',
    })
    let malformed = true
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua') || url.endsWith('/101/101.lua'))
        return new Response(null, { status: 404 })
      if (url.endsWith('/depotkeys.json')) return new Response('{}')
      if (url.endsWith('/api/v1/depot-keys')) return hubcapDepotIds(10, 11)
      if (url.endsWith('/user/stats')) {
        if (malformed) return Response.json({ unexpected: true })
        return Response.json({
          daily_usage: 1,
          daily_limit: 100,
          can_make_requests: false,
        })
      }
      throw new Error('Hubcap Lua must not be requested')
    })
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10] }),
    ).resolves.toMatchObject({ hubcap: { status: 'stats-unavailable' } })
    malformed = false
    await expect(
      service.acquire({ appId: 101, depotIds: [11] }),
    ).resolves.toMatchObject({ hubcap: { status: 'quota-exhausted' } })
  })

  test('shares one concurrent Hubcap Lua request for an app', async () => {
    const db = await openDatabase()
    db.updateSettings({
      ...SETTINGS,
      platforms: [...SETTINGS.platforms],
      hubcapApiKey: 'secret',
    })
    let resolveLua!: (response: Response) => void
    const luaResponse = new Promise<Response>((resolve) => {
      resolveLua = resolve
    })
    let markLuaStarted!: () => void
    const luaStarted = new Promise<void>((resolve) => {
      markLuaStarted = resolve
    })
    let hubcapLuaCalls = 0
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua'))
        return new Response(null, { status: 404 })
      if (url.endsWith('/depotkeys.json')) return new Response('{}')
      if (url.endsWith('/api/v1/depot-keys')) return hubcapDepotIds(10, 11)
      if (url.endsWith('/user/stats'))
        return Response.json({
          daily_usage: 1,
          daily_limit: 100,
          can_make_requests: true,
        })
      hubcapLuaCalls++
      markLuaStarted()
      return luaResponse
    })
    const service = new DepotKeyAcquisitionService(db, fetcher)

    const first = service.acquire({ appId: 100, depotIds: [10] })
    const second = service.acquire({ appId: 100, depotIds: [11] })
    await luaStarted
    expect(hubcapLuaCalls).toBe(1)
    resolveLua(
      hubcapZip(
        `addappid(10, 0, "${HUBCAP_KEY}")\naddappid(11, 0, "${LUA_KEY}")`,
      ),
    )

    await expect(first).resolves.toMatchObject({ acquiredDepotIds: [10] })
    await expect(second).resolves.toMatchObject({ acquiredDepotIds: [11] })
  })

  test('shares a low-quota request that starts during another stats check', async () => {
    const db = await openDatabase()
    db.updateSettings({
      ...SETTINGS,
      platforms: [...SETTINGS.platforms],
      hubcapApiKey: 'secret',
    })
    const statsResolvers: Array<(response: Response) => void> = []
    let firstStatsStarted!: () => void
    const firstStats = new Promise<void>((resolve) => {
      firstStatsStarted = resolve
    })
    let secondStatsStarted!: () => void
    const secondStats = new Promise<void>((resolve) => {
      secondStatsStarted = resolve
    })
    let resolveLua!: (response: Response) => void
    const luaResponse = new Promise<Response>((resolve) => {
      resolveLua = resolve
    })
    let markLuaStarted!: () => void
    const luaStarted = new Promise<void>((resolve) => {
      markLuaStarted = resolve
    })
    let statsCalls = 0
    let hubcapLuaCalls = 0
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua'))
        return new Response(null, { status: 404 })
      if (url.endsWith('/depotkeys.json')) return new Response('{}')
      if (url.endsWith('/api/v1/depot-keys')) return hubcapDepotIds(10, 11)
      if (url.endsWith('/user/stats')) {
        statsCalls++
        if (statsCalls > 2)
          return Response.json({
            daily_usage: 91,
            daily_limit: 100,
            can_make_requests: true,
          })
        const response = new Promise<Response>((resolve) => {
          statsResolvers.push(resolve)
        })
        if (statsCalls === 1) firstStatsStarted()
        if (statsCalls === 2) secondStatsStarted()
        return response
      }
      hubcapLuaCalls++
      markLuaStarted()
      return luaResponse
    })
    const service = new DepotKeyAcquisitionService(db, fetcher)

    const approved = service.acquire({
      appId: 100,
      depotIds: [10],
      approveLowQuotaHubcap: true,
    })
    await firstStats
    const concurrent = service.acquire({ appId: 100, depotIds: [11] })
    await secondStats
    statsResolvers[0]!(
      Response.json({
        daily_usage: 90,
        daily_limit: 100,
        can_make_requests: true,
      }),
    )
    await luaStarted
    statsResolvers[1]!(
      Response.json({
        daily_usage: 90,
        daily_limit: 100,
        can_make_requests: true,
      }),
    )
    resolveLua(
      hubcapZip(
        `addappid(10, 0, "${HUBCAP_KEY}")\naddappid(11, 0, "${LUA_KEY}")`,
      ),
    )

    await expect(approved).resolves.toMatchObject({ acquiredDepotIds: [10] })
    await expect(concurrent).resolves.toMatchObject({
      acquiredDepotIds: [11],
      hubcap: { status: 'fetched' },
    })
    expect(hubcapLuaCalls).toBe(1)
  })

  test('skips Hubcap usage and Lua when no missing depot is available', async () => {
    const db = await openDatabase()
    db.updateSettings({
      ...SETTINGS,
      platforms: [...SETTINGS.platforms],
      hubcapApiKey: 'secret',
    })
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua'))
        return new Response(null, { status: 404 })
      if (url.endsWith('/depotkeys.json')) return new Response('{}')
      if (url.endsWith('/api/v1/depot-keys')) return hubcapDepotIds(99)
      throw new Error('Hubcap usage and Lua must not be requested')
    })
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10, 11] }),
    ).resolves.toEqual({
      acquiredDepotIds: [],
      missingDepotIds: [10, 11],
    })
  })

  test('parses Hubcap Lua only for missing depots listed as available', async () => {
    const db = await openDatabase()
    db.updateSettings({
      ...SETTINGS,
      platforms: [...SETTINGS.platforms],
      hubcapApiKey: 'secret',
    })
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua'))
        return new Response(null, { status: 404 })
      if (url.endsWith('/depotkeys.json')) return new Response('{}')
      if (url.endsWith('/api/v1/depot-keys')) return hubcapDepotIds(10)
      if (url.endsWith('/user/stats'))
        return Response.json({
          daily_usage: 1,
          daily_limit: 100,
          can_make_requests: true,
        })
      return hubcapZip(
        `addappid(10, 0, "${HUBCAP_KEY}")\naddappid(11, 0, "${LUA_KEY}")`,
      )
    })
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10, 11] }),
    ).resolves.toMatchObject({
      acquiredDepotIds: [10],
      missingDepotIds: [11],
      hubcap: { status: 'fetched', acquiredDepotIds: [10] },
    })
    expect(db.getDepotKey(10)).toBe(HUBCAP_KEY)
    expect(db.getDepotKey(11)).toBeNull()
  })

  test('shares the background cache download with acquisition', async () => {
    let resolveCache!: (response: Response) => void
    const cacheResponse = new Promise<Response>((resolve) => {
      resolveCache = resolve
    })
    const fetcher = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith('/100/100.lua'))
        return new Response(null, { status: 404 })
      return cacheResponse
    })
    const service = new DepotKeyAcquisitionService(
      await openDatabase(),
      fetcher,
    )

    const initialization = service.initializeCache()
    const acquisition = service.acquire({ appId: 100, depotIds: [10] })
    resolveCache(new Response(JSON.stringify({ 10: JSON_KEY })))

    await initialization
    await expect(acquisition).resolves.toEqual({
      acquiredDepotIds: [10],
      missingDepotIds: [],
    })
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).endsWith('/depotkeys.json'),
      ),
    ).toBe(true)
  })

  test('cancels a job waiting for the independently started key cache', async () => {
    const db = await openDatabase()
    let resolveCache!: (response: Response) => void
    const cacheResponse = new Promise<Response>((resolve) => {
      resolveCache = resolve
    })
    const service = new DepotKeyAcquisitionService(
      db,
      async () => cacheResponse,
    )
    const initialization = service.initializeCache()
    const coordinator = new BackgroundDownloadCoordinator(root!, () => {})
    await coordinator.initialize()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const operation = coordinator.enqueue({
      key: 'depot-keys:100:10',
      kind: 'depot-keys',
      title: 'Depot keys',
      run: (context) => {
        markStarted()
        return service.acquireWithContext(
          { appId: 100, depotIds: [10] },
          context,
        )
      },
    })
    try {
      await started
      await coordinator.shutdown()
      await expect(operation).rejects.toThrow()
      expect(db.getDepotKey(10)).toBeNull()
    } finally {
      resolveCache(Response.json({ 10: JSON_KEY }))
      await initialization
      await coordinator.shutdown()
      await service.shutdown()
    }
  })

  test('does not publish malformed cache contents', async () => {
    const service = new DepotKeyAcquisitionService(
      await openDatabase(),
      mock(async () => new Response('not json')),
    )

    await expect(service.initializeCache()).rejects.toThrow()
    expect(
      await Bun.file(join(root!, 'depot-keys', '993499094.json')).exists(),
    ).toBe(false)
  })

  test('repairs a malformed local snapshot from a fresh download', async () => {
    const db = await openDatabase()
    const directory = join(root!, 'depot-keys')
    await mkdir(directory)
    await writeFile(join(directory, '993499094.json'), 'not json')
    const service = new DepotKeyAcquisitionService(db, async () =>
      Response.json({ 10: JSON_KEY }),
    )

    expect(await service.acquire({ appId: 100, depotIds: [10] })).toMatchObject(
      {
        acquiredDepotIds: [10],
        missingDepotIds: [],
      },
    )
    expect(db.getDepotKey(10)).toBe(JSON_KEY)
    expect(
      JSON.parse(await readFile(join(directory, '993499094.json'), 'utf8')),
    ).toEqual({
      10: JSON_KEY,
    })
  })

  test('conditionally refreshes an existing shared cache', async () => {
    let calls = 0
    const fetcher = mock(async (_input: string | URL | Request) => {
      if (++calls === 2) {
        return new Response(JSON.stringify({ 11: LUA_KEY }), {
          headers: { etag: 'v2' },
        })
      }
      return new Response(JSON.stringify({ 10: JSON_KEY }), {
        headers: { etag: 'v1' },
      })
    })
    const db = await openDatabase()

    await new DepotKeyAcquisitionService(db, fetcher).initializeCache()
    await new DepotKeyAcquisitionService(db, fetcher).initializeCache()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse(
        await readFile(join(root!, 'depot-keys', '993499094.json'), 'utf8'),
      ),
    ).toEqual({ 11: LUA_KEY })
  })

  test('keeps an existing 993 snapshot if a refresh contains no valid keys', async () => {
    const db = await openDatabase()
    await new DepotKeyAcquisitionService(db, async () =>
      Response.json({ 10: JSON_KEY }),
    ).initializeCache()

    await new DepotKeyAcquisitionService(db, async () =>
      Response.json({ error: 'unavailable' }),
    ).initializeCache()

    expect(
      JSON.parse(
        await readFile(join(root!, 'depot-keys', '993499094.json'), 'utf8'),
      ),
    ).toEqual({ 10: JSON_KEY })
  })

  test('retains an existing shared cache when refresh fails', async () => {
    const db = await openDatabase()
    await new DepotKeyAcquisitionService(
      db,
      mock(
        async () =>
          new Response(JSON.stringify({ 10: JSON_KEY }), {
            headers: { etag: 'v1' },
          }),
      ),
    ).initializeCache()
    const service = new DepotKeyAcquisitionService(
      db,
      mock(async () => {
        throw new Error('offline')
      }),
    )

    await expect(service.initializeCache()).resolves.toBeUndefined()
    await expect(
      service.acquire({ appId: 100, depotIds: [10] }),
    ).resolves.toEqual({ acquiredDepotIds: [10], missingDepotIds: [] })
  })
})

async function openDatabase(): Promise<KalamataDatabase> {
  root = await mkdtemp(join(tmpdir(), 'depot-key-acquisition-'))
  database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  return database
}
