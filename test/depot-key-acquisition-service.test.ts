import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DepotKeyAcquisitionService } from '../src/backend/depot/keys/depot-key-acquisition-service.ts'
import { KalamataDatabase } from '../src/db/database.ts'

const LUA_KEY = 'a'.repeat(64)
const JSON_KEY = 'b'.repeat(64)

let root: string | undefined
let database: KalamataDatabase | undefined

afterEach(async () => {
  database?.close()
  database = undefined
  if (root) await rm(root, { recursive: true, force: true })
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
