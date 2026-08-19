import { expect, test } from 'bun:test'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { createPinia, setActivePinia } from 'pinia'
import { createApp } from 'vue'

import {
  invalidateResourceAcquisitions,
  resourceAcquisitionQueryKey,
  resourceAcquisitionQueryKeys,
  runCachedAcquisition,
} from '../src/composables/resource-acquisition-cache.ts'

function createQueryCache() {
  const app = createApp({})
  const pinia = createPinia()
  app.use(pinia)
  app.use(PiniaColada)
  setActivePinia(pinia)
  return useQueryCache()
}

test('reuses automatic acquisition results until invalidated', async () => {
  const queryCache = createQueryCache()
  const key = resourceAcquisitionQueryKeys.depotKey(440, 441)
  let calls = 0
  const acquire = async () => ++calls

  expect((await runCachedAcquisition(queryCache, key, acquire)).fetched).toBe(
    true,
  )
  expect((await runCachedAcquisition(queryCache, key, acquire)).fetched).toBe(
    false,
  )
  expect(calls).toBe(1)

  await acquire()
  expect(calls).toBe(2)

  await queryCache.invalidateQueries(
    { key: resourceAcquisitionQueryKey },
    false,
  )
  expect((await runCachedAcquisition(queryCache, key, acquire)).fetched).toBe(
    true,
  )
  expect(calls).toBe(3)
})

test('defers invalidation until an acquisition settles', async () => {
  const queryCache = createQueryCache()
  const key = resourceAcquisitionQueryKeys.manifest(441, '1234')
  let finishAcquisition!: () => void
  let calls = 0
  const acquire = () => {
    calls++
    return new Promise<number>((resolve) => {
      finishAcquisition = () => resolve(calls)
    })
  }

  const pending = runCachedAcquisition(queryCache, key, acquire)
  invalidateResourceAcquisitions(queryCache)
  finishAcquisition()

  expect((await pending).data).toBe(1)
  await Promise.resolve()
  expect(queryCache.get(key)?.stale).toBe(true)

  const next = runCachedAcquisition(queryCache, key, acquire)
  finishAcquisition()
  expect((await next).fetched).toBe(true)
  expect(calls).toBe(2)
})
