import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compareApplicationManifests,
  previewApplicationOperation,
} from '../../../src/backend/operations/application-preview.ts'
import { DownloadQueueCoordinator } from '../../../src/backend/operations/download-queue.ts'
import { depot } from '../depot/install/transaction/transaction-fixtures.ts'
import type { ApplicationDepotInput } from '../../../src/backend/depot/depot-download-service.ts'
import {
  APP_ID,
  DEPOTS,
  products,
  queueTest,
  setupDownloadQueue,
} from './download-queue-fixtures.ts'

let directory: string | undefined

function input(depotId: number, manifestId: string): ApplicationDepotInput {
  return {
    depotId,
    ownerAppId: 100,
    manifestId,
    manifestPath: '/unused',
    depotKey: Buffer.alloc(32),
  }
}

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

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
  expect(preview.estimatedDownloadBytes).toBe('7')
  expect(preview.networkPayloadUpperBoundBytes).toBe('7')
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

test('subtracts reusable installed chunks from the download estimate', async () => {
  directory = await mkdtemp(join(tmpdir(), 'application-preview-'))
  await writeFile(join(directory, 'old.bin'), 'shared')
  const installed = [depot(1, 'old', { 'old.bin': 'shared' })]
  const desired = [
    depot(1, 'new', { 'renamed.bin': 'shared', 'added.bin': 'new' }),
  ]

  const preview = await previewApplicationOperation(
    100,
    {
      installedDepots: [input(1, 'old')],
      desiredDepots: [input(1, 'new')],
      desiredDepotIds: [1],
    },
    { loadApplicationDepots: async () => [...installed, ...desired] },
    directory,
  )

  expect(preview.networkPayloadUpperBoundBytes).toBe('9')
  expect(preview.estimatedDownloadBytes).toBe('3')
})

test('reuses a complete target file from a first-install directory', async () => {
  directory = await mkdtemp(join(tmpdir(), 'application-preview-'))
  await writeFile(join(directory, 'game.bin'), 'target')
  const desired = [depot(1, 'new', { 'game.bin': 'target' })]

  const preview = await previewApplicationOperation(
    100,
    {
      installedDepots: [],
      desiredDepots: [input(1, 'new')],
      desiredDepotIds: [1],
    },
    { loadApplicationDepots: async () => desired },
    directory,
  )

  expect(preview.networkPayloadUpperBoundBytes).toBe('6')
  expect(preview.estimatedDownloadBytes).toBe('0')
})

queueTest(
  'coordinator preview does not reserve a path or persist selection',
  async () => {
    const fixture = await setupDownloadQueue()
    let previewPath: string | undefined
    try {
      const queue = new DownloadQueueCoordinator(
        {
          getProductInfoWithDlc: async () => products(),
          reconcileApplication: async () => {
            throw new Error('execution must not start during preview')
          },
          previewApplicationOperation: async (
            _appId,
            plan,
            outputDirectory,
          ) => {
            previewPath = outputDirectory
            return {
              depots: plan.desiredDepots.map(({ depotId }) => ({
                depotId,
                action: 'install' as const,
              })),
              counts: {
                install: plan.desiredDepots.length,
                remove: 0,
                update: 0,
              },
              logicalSizeDeltaBytes: '0',
              estimatedDownloadBytes: '0',
              networkPayloadUpperBoundBytes: '0',
              stagingLogicalUpperBoundBytes: '0',
            }
          },
        },
        fixture.database,
      )

      const preview = await queue.previewApplicationOperation({
        appId: APP_ID,
        desiredDepotIds: [DEPOTS[0].depotId],
        installPath: fixture.installPath,
      })

      expect(preview.depots).toEqual([
        { depotId: DEPOTS[0].depotId, action: 'install' },
      ])
      expect(previewPath).toBe(fixture.installPath)
      expect(fixture.database.getLibraryEntry(APP_ID)?.installPath).toBeNull()
      expect(fixture.database.getSelectedDepotIds(APP_ID)).toEqual([])
      expect(queue.getOperationState()).toEqual({ status: 'idle' })
    } finally {
      await fixture.cleanup()
    }
  },
)
