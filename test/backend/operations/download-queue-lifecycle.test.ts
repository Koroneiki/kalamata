import { afterEach, expect, mock, test } from 'bun:test'
import { realpath } from 'node:fs/promises'
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

  expect(started).toMatchObject({
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
  ).rejects.toThrow('already running')

  productInfo.resolve(products())
  await waitForTerminal(queue)
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

test('planning can pause before cancellation confirmation', async () => {
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

  expect(await queue.pause()).toEqual({ accepted: true })
  expect(queue.getOperationState()).toMatchObject({
    status: 'paused',
    phase: 'planning',
  })
  expect(await queue.cancel()).toEqual({ accepted: true })
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
          options.onEvent?.({ type: 'phase', phase: 'staging' })
          staging.resolve()
          await new Promise((_, reject) =>
            options.signal!.addEventListener(
              'abort',
              () => reject(options.signal!.reason),
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

test('cancel overrides a pending pause and discards resumable work', async () => {
  const fixture = await setup()
  const staging = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        options.onEvent?.({ type: 'phase', phase: 'staging' })
        staging.resolve()
        await new Promise((_, reject) =>
          options.signal!.addEventListener(
            'abort',
            () => reject(options.signal!.reason),
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
        options.onEvent?.({ type: 'phase', phase: 'staging' })
        staging.resolve()
        await new Promise((_, reject) =>
          options.signal!.addEventListener(
            'abort',
            () => reject(options.signal!.reason),
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
