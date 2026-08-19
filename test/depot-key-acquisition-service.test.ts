import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DepotKeyAcquisitionService } from '../src/backend/depot/keys/depot-key-acquisition-service.ts'
import { KalamataDatabase } from '../src/db/database.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

const LUA_KEY = 'a'.repeat(64)
const JSON_KEY = 'b'.repeat(64)
const HUBCAP_KEY = 'c'.repeat(64)
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
  test('prefers Lua and resolves remaining requested depots from the shared cache', async () => {
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/100/100.lua')) {
        return new Response(`addappid(10, 0, "${LUA_KEY}")`)
      }
      return new Response(
        JSON.stringify({ 10: JSON_KEY, 11: JSON_KEY, 12: JSON_KEY }),
      )
    })
    const db = await openDatabase()
    const service = new DepotKeyAcquisitionService(db, fetcher)

    await expect(
      service.acquire({ appId: 100, depotIds: [10, 11] }),
    ).resolves.toEqual({
      acquiredDepotIds: [10, 11],
      missingDepotIds: [],
    })
    expect(db.getDepotKey(10)).toBe(LUA_KEY)
    expect(db.getDepotKey(11)).toBe(JSON_KEY)
    expect(db.getDepotKey(12)).toBeNull()
    expect(
      JSON.parse(
        await readFile(join(root!, 'depot-keys', 'depotkeys.json'), 'utf8'),
      ),
    ).toEqual({ 10: JSON_KEY, 11: JSON_KEY, 12: JSON_KEY })
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
        return new Response(
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

  test('proceeds at eleven remaining and reuses successful Hubcap Lua', async () => {
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
      return new Response(
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
      hubcap: { status: 'fetched', acquiredDepotIds: [11] },
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
      new Response(
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
      new Response(
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
      return new Response(
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
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('does not publish malformed cache contents', async () => {
    const service = new DepotKeyAcquisitionService(
      await openDatabase(),
      mock(async () => new Response('not json')),
    )

    await expect(service.initializeCache()).rejects.toThrow()
    expect(
      await Bun.file(join(root!, 'depot-keys', 'depotkeys.json')).exists(),
    ).toBe(false)
  })

  test('conditionally refreshes an existing shared cache', async () => {
    const fetcher = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        if (headers.get('If-None-Match') === 'v1') {
          return new Response(JSON.stringify({ 10: LUA_KEY }), {
            headers: { etag: 'v2' },
          })
        }
        return new Response(JSON.stringify({ 10: JSON_KEY }), {
          headers: { etag: 'v1' },
        })
      },
    )
    const db = await openDatabase()

    await new DepotKeyAcquisitionService(db, fetcher).initializeCache()
    await new DepotKeyAcquisitionService(db, fetcher).initializeCache()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse(
        await readFile(join(root!, 'depot-keys', 'depotkeys.json'), 'utf8'),
      ),
    ).toEqual({ 10: LUA_KEY })
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
