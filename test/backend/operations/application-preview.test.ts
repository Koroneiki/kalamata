import { expect, test } from 'bun:test'

import { compareApplicationManifests } from '../../../src/backend/operations/application-preview.ts'
import { DownloadQueueCoordinator } from '../../../src/backend/operations/download-queue.ts'
import { depot } from '../depot/install/transaction/transaction-fixtures.ts'
import {
  APP_ID,
  DEPOTS,
  products,
  setupDownloadQueue,
} from './download-queue-fixtures.ts'

test('classifies install, remove, and update depots with a signed delta', () => {
  const preview = compareApplicationManifests(
    100,
    [depot(1, 'old', { 'old.bin': 'old' }), depot(2, 'same', { same: '12' })],
    [depot(2, 'new', { same: '1234' }), depot(3, 'new', { added: '123' })],
  )

  expect(preview.depots).toEqual([
    { depotId: 2, action: 'update' },
    { depotId: 3, action: 'install' },
    { depotId: 1, action: 'remove' },
  ])
  expect(preview.counts).toEqual({ install: 1, remove: 1, update: 1 })
  expect(preview.logicalSizeDeltaBytes).toBe('2')
})

test('uses final projection precedence for logical and staging sizes', () => {
  const preview = compareApplicationManifests(
    100,
    [depot(1, 'old', { shared: '123456' })],
    [depot(1, 'old', { shared: '123456' }), depot(2, 'new', { shared: '12' })],
  )

  expect(preview.logicalSizeDeltaBytes).toBe('-4')
  expect(preview.stagingLogicalUpperBoundBytes).toBe('2')
  expect(preview.networkPayloadUpperBoundBytes).toBe('2')
})

test('deduplicates identical chunks in network upper bounds', () => {
  const preview = compareApplicationManifests(
    100,
    [],
    [depot(1, 'new', { first: 'shared', second: 'shared' })],
  )

  expect(preview.stagingLogicalUpperBoundBytes).toBe('12')
  expect(preview.networkPayloadUpperBoundBytes).toBe('6')
})

test('uses the largest compressed size for duplicate chunk keys', () => {
  const first = depot(1, 'new', { first: 'shared' })
  const second = depot(2, 'new', { second: 'shared' })
  first.manifest.files[0]!.chunks[0]!.cb_compressed = 4
  second.manifest.files[0]!.chunks[0]!.cb_compressed = 9

  const preview = compareApplicationManifests(100, [], [first, second])

  expect(preview.networkPayloadUpperBoundBytes).toBe('9')
})

test('does not stage files whose winning manifest is unchanged', () => {
  const installed = [depot(1, 'same', { file: 'content' })]
  const preview = compareApplicationManifests(100, installed, installed)

  expect(preview.depots).toEqual([])
  expect(preview.logicalSizeDeltaBytes).toBe('0')
  expect(preview.stagingLogicalUpperBoundBytes).toBe('0')
  expect(preview.networkPayloadUpperBoundBytes).toBe('0')
})

test('coordinator preview does not reserve a path or persist selection', async () => {
  const fixture = await setupDownloadQueue()
  try {
    const queue = new DownloadQueueCoordinator(
      {
        getProductInfoWithDlc: async () => products(),
        reconcileApplication: async () => {
          throw new Error('execution must not start during preview')
        },
        previewApplicationOperation: async (_appId, plan) => ({
          depots: plan.desiredDepots.map(({ depotId }) => ({
            depotId,
            action: 'install' as const,
          })),
          counts: { install: plan.desiredDepots.length, remove: 0, update: 0 },
          logicalSizeDeltaBytes: '0',
          networkPayloadUpperBoundBytes: '0',
          stagingLogicalUpperBoundBytes: '0',
        }),
      },
      fixture.database,
    )

    const preview = await queue.previewApplicationOperation({
      appId: APP_ID,
      desiredDepotIds: [DEPOTS[0].depotId],
    })

    expect(preview.depots).toEqual([
      { depotId: DEPOTS[0].depotId, action: 'install' },
    ])
    expect(fixture.database.getLibraryEntry(APP_ID)?.installPath).toBeNull()
    expect(fixture.database.getSelectedDepotIds(APP_ID)).toEqual([])
    expect(queue.getOperationState()).toEqual({ status: 'idle' })
  } finally {
    await fixture.cleanup()
  }
})
