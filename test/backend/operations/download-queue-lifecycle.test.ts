import { afterEach, expect, mock } from 'bun:test'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProductInfoResult } from '../../../src/backend/steam/types.ts'
import { getResumableApplicationTransaction } from '../../../src/backend/depot/install/transaction/recovery.ts'
import { DownloadQueueCoordinator } from '../../../src/backend/operations/download-queue.ts'
import {
  APP_ID,
  DEPOTS,
  type DownloadQueueFixture,
  deferred,
  install,
  products,
  queueTest as test,
  setupDownloadQueue,
  successfulReconciliation,
  waitForTerminal,
  writeQueueStagingJournal,
} from './download-queue-fixtures.ts'

let currentFixture: DownloadQueueFixture | undefined

afterEach(async () => {
  await currentFixture?.cleanup()
  currentFixture = undefined
})

async function setup(): Promise<DownloadQueueFixture> {
  currentFixture = await setupDownloadQueue()
  return currentFixture
}

async function waitForCompletedApp(
  queue: DownloadQueueCoordinator,
  appId: number,
): Promise<void> {
  while (true) {
    const state = queue.getOperationState()
    if (state.status === 'completed' && state.appId === appId) return
    await Bun.sleep(1)
  }
}

test('start returns active operation state before product planning completes', async () => {
  const fixture = await setup()
  const planningStarted = deferred<void>()
  const productInfo = deferred<ProductInfoResult>()
  const reconcileApplication = mock(successfulReconciliation)
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => {
        planningStarted.resolve()
        return productInfo.promise
      },
      reconcileApplication,
    },
    fixture.database,
  )

  const started = await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await planningStarted.promise

  expect(started.operation).toMatchObject({
    status: 'active',
    desiredDepotIds: [DEPOTS[0].depotId],
    phase: 'planning',
  })
  expect(queue.getOperationState()).toMatchObject({
    status: 'active',
    phase: 'planning',
  })
  expect(queue.isBusyForApp(APP_ID)).toBe(true)
  expect(reconcileApplication).not.toHaveBeenCalled()
  await expect(
    queue.start({
      appId: APP_ID,
      installPath: fixture.installPath,
      depotIds: [DEPOTS[0].depotId],
    }),
  ).rejects.toThrow('already in Downloads')

  productInfo.resolve(products())
  await waitForTerminal(queue)
})

test('queues another app and starts it after the current operation', async () => {
  const fixture = await setup()
  const productInfo = deferred<ProductInfoResult>()
  const secondAppId = 30
  const secondPath = join(fixture.root, 'second-install')
  await mkdir(secondPath)
  fixture.database.addLibraryEntry(secondAppId)
  fixture.database.reserveInstallPath(secondAppId, secondPath)
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => productInfo.promise,
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  const queued = await queue.queueDepotUpdate({
    appId: secondAppId,
    desiredDepotIds: [],
  })

  expect(queued.pending).toHaveLength(1)
  expect(queued.pending[0]).toMatchObject({
    appId: secondAppId,
    kind: 'reconcile',
  })
  productInfo.resolve(products())
  await waitForCompletedApp(queue, secondAppId)
  expect(queue.getOperationState()).toMatchObject({
    status: 'completed',
    appId: secondAppId,
  })
  expect(queue.getDownloadQueue().pending).toEqual([])
})

test('cancellation aborts precommit work and yields cancelled typed state', async () => {
  const fixture = await setup()
  const planningStarted = deferred<void>()
  const productInfo = deferred<ProductInfoResult>()
  const reconcileApplication = mock(successfulReconciliation)
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => {
        planningStarted.resolve()
        return productInfo.promise
      },
      reconcileApplication,
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await planningStarted.promise
  expect(await queue.cancel()).toEqual({ accepted: true })
  productInfo.resolve(products())
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toMatchObject({
    status: 'cancelled',
    kind: 'download',
    desiredDepotIds: [DEPOTS[0].depotId],
    error: { kind: 'cancellation' },
  })
  expect(reconcileApplication).not.toHaveBeenCalled()
})

test('planning rejects pause but remains cancellable', async () => {
  const fixture = await setup()
  const planningStarted = deferred<void>()
  const productInfo = deferred<ProductInfoResult>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => {
        planningStarted.resolve()
        return productInfo.promise
      },
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await planningStarted.promise

  expect(await queue.pause()).toEqual({
    accepted: false,
    reason: 'invalid-phase',
  })
  expect(queue.getOperationState()).toMatchObject({
    status: 'active',
    phase: 'planning',
  })
  expect(await queue.cancel()).toEqual({ accepted: true })
  productInfo.resolve(products())
  await waitForTerminal(queue)
  expect(queue.getOperationState()).toMatchObject({ status: 'cancelled' })
})

test('cancellation is rejected after committing starts', async () => {
  const fixture = await setup()
  const committing = deferred<void>()
  const releaseCommit = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        options.onEvent?.({ type: 'phase', phase: 'committing' })
        committing.resolve()
        await releaseCommit.promise
        return successfulReconciliation(options)
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await committing.promise
  expect(await queue.cancel()).toEqual({
    accepted: false,
    reason: 'commit-in-progress',
  })

  releaseCommit.resolve()
  await waitForTerminal(queue)
  expect(queue.getOperationState()).toMatchObject({ status: 'completed' })
})

test('cancellation is rejected while metadata reconciliation is committing', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  const reconciling = deferred<void>()
  const finish = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        options.onEvent?.({ type: 'phase', phase: 'reconciling' })
        reconciling.resolve()
        await finish.promise
        return successfulReconciliation(options)
      },
    },
    fixture.database,
  )

  await queue.repairApplication({ appId: APP_ID })
  await reconciling.promise

  expect(await queue.cancel()).toEqual({
    accepted: false,
    reason: 'commit-in-progress',
  })
  finish.resolve()
  await waitForTerminal(queue)
})

test('releases the install path after a successful uninstall', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )

  await queue.queueDepotUpdate({ appId: APP_ID, desiredDepotIds: [] })
  await waitForTerminal(queue)

  expect(fixture.database.getInstalls(APP_ID)).toEqual([])
  expect(fixture.database.getLibraryEntry(APP_ID)?.installPath).toBeNull()
})

test('pause keeps the queue occupied and resume continues the operation', async () => {
  const fixture = await setup()
  const staging = deferred<void>()
  let calls = 0
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        calls++
        if (calls === 1) {
          await writeQueueStagingJournal(options)
          options.onEvent?.({ type: 'phase', phase: 'staging' })
          staging.resolve()
          await new Promise((_, reject) =>
            options.signal!.addEventListener(
              'abort',
              () => {
                void writeQueueStagingJournal(options, true).then(() =>
                  reject(options.signal!.reason),
                )
              },
              { once: true },
            ),
          )
        }
        return successfulReconciliation(options)
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await staging.promise
  expect(await queue.pause()).toEqual({ accepted: true })
  await waitForTerminal(queue)
  expect(queue.getOperationState().status).toBe('paused')
  expect(queue.resume()).toEqual({ accepted: true })
  await waitForTerminal(queue)
  expect(queue.getOperationState().status).toBe('completed')
  expect(calls).toBe(2)
})

test('priority pauses current work and starts the selected queued app', async () => {
  const fixture = await setup()
  const selectedAppId = 30
  const selectedPath = join(fixture.root, 'selected-install')
  await mkdir(selectedPath)
  fixture.database.addLibraryEntry(selectedAppId)
  fixture.database.reserveInstallPath(selectedAppId, selectedPath)
  const currentStaging = deferred<void>()
  const selectedStarted = deferred<void>()
  const finishSelected = deferred<void>()
  let currentCalls = 0
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        if (options.appId === APP_ID && currentCalls++ === 0) {
          await writeQueueStagingJournal(options)
          options.onEvent?.({ type: 'phase', phase: 'staging' })
          currentStaging.resolve()
          await new Promise((_, reject) =>
            options.signal!.addEventListener(
              'abort',
              () => {
                void writeQueueStagingJournal(options, true).then(() =>
                  reject(options.signal!.reason),
                )
              },
              { once: true },
            ),
          )
        }
        if (options.appId === selectedAppId) {
          selectedStarted.resolve()
          await finishSelected.promise
        }
        return successfulReconciliation(options)
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await currentStaging.promise
  const queued = await queue.queueDepotUpdate({
    appId: selectedAppId,
    desiredDepotIds: [],
  })
  await queue.prioritizeQueuedOperation(queued.pending[0]!.id)
  await selectedStarted.promise

  expect(queue.getOperationState()).toMatchObject({
    status: 'active',
    appId: selectedAppId,
  })
  expect(queue.getDownloadQueue().pending.map(({ appId }) => appId)).toEqual([
    APP_ID,
  ])
  expect(
    await getResumableApplicationTransaction(
      await realpath(fixture.installPath),
      APP_ID,
    ),
  ).not.toBeNull()

  finishSelected.resolve()
  await waitForCompletedApp(queue, APP_ID)
  expect(queue.getDownloadQueue().pending).toEqual([])
  expect(currentCalls).toBe(2)
})

test('priority waits when the current operation is committing', async () => {
  const fixture = await setup()
  const selectedAppId = 30
  const selectedPath = join(fixture.root, 'selected-install')
  await mkdir(selectedPath)
  fixture.database.addLibraryEntry(selectedAppId)
  fixture.database.reserveInstallPath(selectedAppId, selectedPath)
  const committing = deferred<void>()
  const finishCurrent = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        if (options.appId === APP_ID) {
          options.onEvent?.({ type: 'phase', phase: 'committing' })
          committing.resolve()
          await finishCurrent.promise
        }
        return successfulReconciliation(options)
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await committing.promise
  const queued = await queue.queueDepotUpdate({
    appId: selectedAppId,
    desiredDepotIds: [],
  })
  const prioritized = await queue.prioritizeQueuedOperation(
    queued.pending[0]!.id,
  )

  expect(prioritized.operation).toMatchObject({
    status: 'active',
    appId: APP_ID,
    phase: 'committing',
  })
  expect(prioritized.pending.map(({ appId }) => appId)).toEqual([selectedAppId])
  finishCurrent.resolve()
  await waitForCompletedApp(queue, selectedAppId)
})

test('priority rejects preparation failure and keeps the selected row', async () => {
  const fixture = await setup()
  const selectedAppId = 30
  const selectedPath = join(fixture.root, 'selected-install')
  const transactionPath = join(
    selectedPath,
    '.Kalamata',
    'transactions',
    'broken',
  )
  await mkdir(transactionPath, { recursive: true })
  await writeFile(join(transactionPath, 'journal.json'), '{broken')
  fixture.database.addLibraryEntry(selectedAppId)
  fixture.database.reserveInstallPath(selectedAppId, selectedPath)
  fixture.database.appendApplicationQueueItem({
    id: 'selected',
    appId: selectedAppId,
    kind: 'reconcile',
    installPath: selectedPath,
    depotIds: [],
    createdAt: 1,
  })
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )

  await expect(queue.prioritizeQueuedOperation('selected')).rejects.toThrow()

  expect(queue.getOperationState()).toEqual({ status: 'idle' })
  expect(queue.getDownloadQueue().pending.map(({ id }) => id)).toEqual([
    'selected',
  ])
})

test('malformed precommit work can be removed from the queue', async () => {
  const fixture = await setup()
  const transactionPath = join(
    fixture.installPath,
    '.Kalamata',
    'transactions',
    'broken',
  )
  await mkdir(transactionPath, { recursive: true })
  await writeFile(join(transactionPath, 'journal.json'), '{broken')
  fixture.database.appendApplicationQueueItem({
    id: 'malformed',
    appId: APP_ID,
    kind: 'reconcile',
    installPath: fixture.installPath,
    depotIds: [],
    createdAt: 1,
  })
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )

  const snapshot = await queue.removeQueuedOperation('malformed')

  expect(snapshot.pending).toEqual([])
  expect(fixture.database.getApplicationQueueItem('malformed')).toBeNull()
})

test('failed priority preparation does not restart completed work', async () => {
  const fixture = await setup()
  const selectedAppId = 30
  const selectedPath = join(fixture.root, 'selected-install')
  const transactionPath = join(
    selectedPath,
    '.Kalamata',
    'transactions',
    'broken',
  )
  await mkdir(transactionPath, { recursive: true })
  await writeFile(join(transactionPath, 'journal.json'), '{broken')
  fixture.database.addLibraryEntry(selectedAppId)
  fixture.database.reserveInstallPath(selectedAppId, selectedPath)
  fixture.database.appendApplicationQueueItem({
    id: 'selected',
    appId: selectedAppId,
    kind: 'reconcile',
    installPath: selectedPath,
    depotIds: [],
    createdAt: 1,
  })
  const staging = deferred<void>()
  let currentCalls = 0
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        if (options.appId === APP_ID) {
          currentCalls++
          options.onEvent?.({ type: 'phase', phase: 'staging' })
          staging.resolve()
          await new Promise<void>((resolve) =>
            options.signal!.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          )
        }
        return successfulReconciliation(options)
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await staging.promise
  await expect(queue.prioritizeQueuedOperation('selected')).rejects.toThrow()

  expect(queue.getOperationState()).toMatchObject({
    status: 'completed',
    appId: APP_ID,
  })
  expect(currentCalls).toBe(1)
  expect(queue.getDownloadQueue().pending.map(({ id }) => id)).toEqual([
    'selected',
  ])
})

test('completed work is not left queued when a priority pause fails', async () => {
  const fixture = await setup()
  const selectedAppId = 30
  const selectedPath = join(fixture.root, 'selected-install')
  await mkdir(selectedPath)
  fixture.database.addLibraryEntry(selectedAppId)
  fixture.database.reserveInstallPath(selectedAppId, selectedPath)
  const staging = deferred<void>()
  const finishSelected = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        if (options.appId === APP_ID) {
          options.onEvent?.({ type: 'phase', phase: 'staging' })
          staging.resolve()
          await new Promise<void>((resolve) =>
            options.signal!.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          )
        } else {
          await finishSelected.promise
        }
        return successfulReconciliation(options)
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await staging.promise
  const queued = await queue.queueDepotUpdate({
    appId: selectedAppId,
    desiredDepotIds: [],
  })
  await queue.prioritizeQueuedOperation(queued.pending[0]!.id)

  expect(queue.getOperationState()).toMatchObject({
    status: 'active',
    appId: selectedAppId,
  })
  expect(queue.getDownloadQueue().pending).toEqual([])
  finishSelected.resolve()
  await waitForCompletedApp(queue, selectedAppId)
})

test('cancel overrides a pending pause and discards resumable work', async () => {
  const fixture = await setup()
  const staging = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        await writeQueueStagingJournal(options)
        options.onEvent?.({ type: 'phase', phase: 'staging' })
        staging.resolve()
        await new Promise((_, reject) =>
          options.signal!.addEventListener(
            'abort',
            () => {
              void writeQueueStagingJournal(options, true).then(() =>
                reject(options.signal!.reason),
              )
            },
            { once: true },
          ),
        )
        throw new Error('unreachable')
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await staging.promise
  expect(await queue.pause()).toEqual({ accepted: true })
  await expect(queue.cancel()).resolves.toEqual({ accepted: true })
  await waitForTerminal(queue)

  expect(queue.getOperationState().status).toBe('cancelled')
  expect(
    await getResumableApplicationTransaction(fixture.installPath, APP_ID),
  ).toBeNull()
})

test('resume is rejected while paused cancellation is pending', async () => {
  const fixture = await setup()
  const staging = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        await writeQueueStagingJournal(options)
        options.onEvent?.({ type: 'phase', phase: 'staging' })
        staging.resolve()
        await new Promise((_, reject) =>
          options.signal!.addEventListener(
            'abort',
            () => {
              void writeQueueStagingJournal(options, true).then(() =>
                reject(options.signal!.reason),
              )
            },
            { once: true },
          ),
        )
        throw new Error('unreachable')
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await staging.promise
  expect(await queue.pause()).toEqual({ accepted: true })
  await waitForTerminal(queue)

  const cancellation = queue.cancel()
  expect(queue.resume()).toEqual({
    accepted: false,
    reason: 'no-resumable-operation',
  })
  await expect(cancellation).resolves.toEqual({ accepted: true })
  expect(queue.getOperationState().status).toBe('cancelled')
})

test('shutdown aborts and awaits precommit work and prevents new work', async () => {
  const fixture = await setup()
  const entered = deferred<void>()
  const aborted = deferred<void>()
  const releaseCleanup = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        await writeQueueStagingJournal(options)
        entered.resolve()
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener(
            'abort',
            () => {
              aborted.resolve()
              resolve()
            },
            { once: true },
          ),
        )
        await releaseCleanup.promise
        options.signal!.throwIfAborted()
        throw new Error('unreachable')
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await entered.promise
  let shutdownResolved = false
  const shutdown = queue.shutdown().then(() => {
    shutdownResolved = true
  })
  await aborted.promise
  await Promise.resolve()
  expect(shutdownResolved).toBe(false)

  releaseCleanup.resolve()
  await shutdown
  expect(queue.getOperationState()).toMatchObject({ status: 'resumable' })
  await expect(
    getResumableApplicationTransaction(
      await realpath(fixture.installPath),
      APP_ID,
    ),
  ).resolves.not.toBeNull()
  await expect(
    queue.start({
      appId: APP_ID,
      installPath: fixture.installPath,
      depotIds: [DEPOTS[0].depotId],
    }),
  ).rejects.toThrow('shutting down')
})

test('shutdown awaits cancellation of paused work', async () => {
  const fixture = await setup()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )
  await writeQueueStagingJournal(
    {
      kind: 'download',
      appId: APP_ID,
      outputDirectory: fixture.installPath,
      installedDepots: [],
      desiredDepots: [],
      reconcile: async () => {},
    },
    true,
  )
  fixture.database.reserveInstallPath(APP_ID, fixture.installPath)
  await queue.restoreInterrupted()

  const cancellation = queue.cancel()
  await queue.shutdown()
  await expect(cancellation).resolves.toEqual({ accepted: true })
  expect(fixture.database.getLibraryEntry(APP_ID)?.installPath).toBeNull()
})
