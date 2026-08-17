import { expect, test } from 'bun:test'
import { AvailableUpdateScan } from '../src/composables/available-update-scan.ts'
import type { AvailableUpdateResult } from '../src/types/rpc.ts'

test('scans sequentially, coalesces work, continues after errors, and drops removed apps', async () => {
  const calls: number[] = []
  const committed = new Map<number, AvailableUpdateResult>()
  const responses = new Map<number, () => Promise<AvailableUpdateResult>>()
  let active = 0
  let maximumActive = 0
  const check = async (appId: number) => {
    calls.push(appId)
    active += 1
    maximumActive = Math.max(maximumActive, active)
    try {
      const response = responses.get(appId)
      if (!response) throw new Error(`Missing response for ${appId}`)
      return await response()
    } finally {
      active -= 1
    }
  }
  const scan = new AvailableUpdateScan({
    getLibrary: () =>
      Promise.resolve([
        {
          appId: 1,
          installPath: '/one',
          hasInstalledDepots: true,
          createdAt: 1,
        },
        {
          appId: 2,
          installPath: '/two',
          hasInstalledDepots: true,
          createdAt: 2,
        },
        {
          appId: 3,
          installPath: null,
          hasInstalledDepots: false,
          createdAt: 3,
        },
      ]),
    check,
    checkBatch: async (appIds) => {
      const results: AvailableUpdateResult[] = []
      for (const appId of appIds) results.push(await check(appId))
      return results
    },
    commit: (appId, result) => committed.set(appId, result),
    clear: (appId) => void committed.delete(appId),
    remove: (appId) => void committed.delete(appId),
    scanError: () => {},
    progress: () => {},
  })

  responses.set(1, () => Promise.resolve(available(1)))
  responses.set(2, () => Promise.resolve(error(2)))
  const firstScan = scan.refreshAll()
  expect(scan.refreshAll()).toBe(firstScan)
  await firstScan

  expect(calls).toEqual([1, 2])
  expect(maximumActive).toBe(1)
  expect(committed.get(1)?.status).toBe('available')
  expect(committed.get(2)?.status).toBe('error')

  responses.set(2, () => Promise.resolve(current(2)))
  await scan.retry([2])
  expect(committed.get(2)?.status).toBe('current')

  responses.set(1, () => Promise.resolve(current(1)))
  await scan.refreshApp(1)
  expect(committed.get(1)?.status).toBe('current')

  let resolveCheck: (result: AvailableUpdateResult) => void = () => {}
  responses.set(
    1,
    () =>
      new Promise((resolve) => {
        resolveCheck = resolve
      }),
  )
  const refresh = scan.refreshApp(1)
  const joined = scan.refreshApp(1)
  await Promise.resolve()
  expect(calls.filter((appId) => appId === 1)).toHaveLength(3)
  scan.removeApp(1)
  resolveCheck(available(1))
  await Promise.all([refresh, joined])
  expect(committed.has(1)).toBe(false)
})

test('runs a fresh targeted check after joining older in-flight work', async () => {
  const committed: AvailableUpdateResult[] = []
  let calls = 0
  let resolveOldCheck: (result: AvailableUpdateResult) => void = () => {}
  const scan = new AvailableUpdateScan({
    getLibrary: () =>
      Promise.resolve([
        {
          appId: 1,
          installPath: '/one',
          hasInstalledDepots: true,
          createdAt: 1,
        },
      ]),
    check: () => {
      calls += 1
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveOldCheck = resolve
        })
      }
      return Promise.resolve(current(1))
    },
    checkBatch: () => Promise.resolve([current(1)]),
    commit: (_appId, result) => committed.push(result),
    clear: () => {},
    remove: () => {},
    scanError: () => {},
    progress: () => {},
  })

  await scan.refreshAll()
  const oldRefresh = scan.refreshApp(1)
  await Promise.resolve()
  const mutationRefresh = scan.refreshApp(1)
  resolveOldCheck(available(1))
  await Promise.all([oldRefresh, mutationRefresh])

  expect(calls).toBe(2)
  expect(committed.at(-1)?.status).toBe('current')
})

test('clears stale results while checking and reports library failures', async () => {
  const events: string[] = []
  let failLibrary = false
  let resolveCheck: (result: AvailableUpdateResult) => void = () => {}
  const scan = new AvailableUpdateScan({
    getLibrary: () =>
      failLibrary
        ? Promise.reject(new Error('database unavailable'))
        : Promise.resolve([
            {
              appId: 1,
              installPath: '/one',
              hasInstalledDepots: true,
              createdAt: 1,
            },
          ]),
    check: () =>
      new Promise((resolve) => {
        resolveCheck = resolve
      }),
    checkBatch: () => Promise.resolve([available(1)]),
    commit: () => events.push('commit'),
    clear: () => events.push('clear'),
    remove: () => {},
    scanError: (message) => events.push(message ?? 'ready'),
    progress: () => {},
  })

  await scan.refreshAll()
  events.length = 0
  const refresh = scan.refreshApp(1)
  await Promise.resolve()
  expect(events).toEqual(['clear'])
  resolveCheck(current(1))
  await refresh
  expect(events).toEqual(['clear', 'commit'])

  events.length = 0
  failLibrary = true
  await expect(scan.refreshAll()).resolves.toBeUndefined()
  expect(events).toEqual([
    'clear',
    'ready',
    'Could not load the library to check for updates.',
  ])
})

function current(appId: number): AvailableUpdateResult {
  return { status: 'current', appId, checkedAt: 1 }
}

function error(appId: number): AvailableUpdateResult {
  return { status: 'error', appId, message: 'Unavailable', checkedAt: 1 }
}

function available(appId: number): AvailableUpdateResult {
  return {
    status: 'available',
    checkedAt: 1,
    candidate: {
      app: {
        appId,
        name: `App ${appId}`,
        developers: [],
        publishers: [],
        releaseDate: null,
        iconUrls: [],
        artworkUrl: null,
      },
      installedDepotIds: [10],
      outdatedDepots: [
        {
          depotId: 10,
          ownerAppId: appId,
          installedManifestId: '1',
          targetManifestId: '2',
          sizeBytes: '10',
          downloadBytes: '5',
        },
      ],
      totalDownloadBytes: '5',
    },
  }
}
