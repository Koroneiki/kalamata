import { expect, mock, test } from 'bun:test'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import type { BackgroundDownloadsSnapshot } from '../src/types/background-downloads.ts'

test('a newer Bun push wins over an older initial RPC, including after store recreation', async () => {
  const active: BackgroundDownloadsSnapshot = {
    jobs: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        key: 'manifest:1:2',
        kind: 'manifest',
        title: 'Manifest',
        appId: 1,
        depotId: 1,
        status: 'active',
        phase: 'downloading',
        source: 'Steam CDN',
        transferredBytes: 30,
        totalBytes: 100,
        error: null,
      },
    ],
  }
  let sequence = 0
  let latest: BackgroundDownloadsSnapshot | undefined
  const listeners = new Set<(snapshot: BackgroundDownloadsSnapshot) => void>()
  let resolveSnapshot!: (snapshot: BackgroundDownloadsSnapshot) => void
  let snapshot = new Promise<BackgroundDownloadsSnapshot>((resolve) => {
    resolveSnapshot = resolve
  })
  mock.module('../src/api/transport.ts', () => ({
    request: async () => null,
    getBackgroundDownloadsMessageSequence: () => sequence,
    subscribeToBackgroundDownloads: (
      listener: (value: BackgroundDownloadsSnapshot) => void,
    ) => {
      listeners.add(listener)
      if (latest) listener(latest)
      return () => listeners.delete(listener)
    },
  }))
  mock.module('../src/api/background-downloads.ts', () => ({
    getBackgroundDownloads: () => snapshot,
    prioritizeBackgroundDownload: async () => true,
    cancelBackgroundDownload: async () => true,
    retryBackgroundDownload: async () => '',
    dismissBackgroundDownload: async () => true,
  }))
  // The backend test project deliberately does not compile the browser transport.
  const storeModule: string = '../src/stores/background-downloads.ts'
  const { useBackgroundDownloadsStore } = await import(storeModule)
  const app = createApp({})
  const pinia = createPinia()
  app.use(pinia)
  app.use(PiniaColada)
  const store = useBackgroundDownloadsStore(pinia)
  const initializing = store.initialize()
  latest = active
  sequence++
  for (const listener of listeners) listener(active)
  resolveSnapshot({ jobs: [] })
  await initializing
  expect(store.jobs).toEqual(active.jobs)
  store.$dispose()
  expect(listeners.size).toBe(0)

  snapshot = Promise.resolve(active)
  const restored = useBackgroundDownloadsStore(pinia)
  await restored.initialize()
  expect(restored.jobs).toEqual(active.jobs)
  const cache = useQueryCache(pinia)
  const coldClientDependenciesQueryKey = ['cold-client-dependencies'] as const
  const dependencyStatus = cache.ensure({
    key: coldClientDependenciesQueryKey,
    query: async () => 'old status',
    staleTime: Infinity,
  })
  cache.setQueryData(coldClientDependenciesQueryKey, 'old status')
  expect(dependencyStatus.stale).toBe(false)
  const installed: BackgroundDownloadsSnapshot = {
    jobs: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        key: 'dependency:7zip',
        kind: 'dependency',
        title: 'Dependency 7zip',
        appId: null,
        depotId: null,
        status: 'completed',
        phase: 'completed',
        source: null,
        transferredBytes: 0,
        totalBytes: null,
        error: null,
      },
    ],
  }
  for (const listener of listeners) listener(installed)
  expect(dependencyStatus.stale).toBe(true)
  restored.$dispose()
})
