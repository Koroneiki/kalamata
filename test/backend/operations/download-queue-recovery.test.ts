import { afterEach, expect, mock, test } from 'bun:test'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApplicationTransactionError } from '../../../src/backend/depot/install/transaction/types.ts'
import { DownloadQueueCoordinator } from '../../../src/backend/operations/download-queue.ts'
import {
  APP_ID,
  DEPOTS,
  DLC_APP_ID,
  type DownloadQueueFixture,
  deferred,
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

test('unavailable resources remain resumable after staging begins', async () => {
  const fixture = await setup()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        await writeQueueStagingJournal(options)
        throw new ApplicationTransactionError(
          'unavailable-resource',
          'no content servers',
        )
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toMatchObject({
    status: 'resumable',
    error: { kind: 'unavailable-resource' },
  })
})

test('commit-ready failures require repair and keep the app protected', async () => {
  const fixture = await setup()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async () => {
        const transaction = join(
          fixture.installPath,
          '.Kalamata',
          'transactions',
          'pending',
        )
        await mkdir(transaction, { recursive: true })
        await writeFile(join(transaction, 'commit-ready'), '')
        throw new ApplicationTransactionError(
          'persistence',
          'database unavailable',
        )
      },
    },
    fixture.database,
  )

  await queue.start({
    appId: APP_ID,
    installPath: fixture.installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toMatchObject({
    status: 'repair-required',
    appId: APP_ID,
  })
  expect(queue.isBusyForApp(APP_ID)).toBe(true)
})

test('repair-required protection does not block a different application', async () => {
  const fixture = await setup()
  const otherInstallPath = join(fixture.root, 'other-install')
  await mkdir(otherInstallPath)
  fixture.database.addLibraryEntry(DLC_APP_ID)
  fixture.database.reserveInstallPath(DLC_APP_ID, otherInstallPath)
  const reconcileApplication = mock(successfulReconciliation)
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication,
    },
    fixture.database,
  )
  queue.markRepairRequired(APP_ID, fixture.installPath)

  await queue.queueDepotUpdate({
    appId: DLC_APP_ID,
    desiredDepotIds: [],
  })
  await waitForTerminal(queue)

  expect(reconcileApplication).toHaveBeenCalledTimes(1)
  expect(queue.getOperationState()).toMatchObject({
    status: 'repair-required',
    appId: APP_ID,
  })
  expect(queue.isBusyForApp(APP_ID)).toBe(true)
})

test('surfaces queued recovery failures one at a time', async () => {
  const fixture = await setup()
  fixture.database.reserveInstallPath(
    APP_ID,
    await realpath(fixture.installPath),
  )
  const otherInstallPath = join(fixture.root, 'other-install')
  await mkdir(otherInstallPath)
  fixture.database.addLibraryEntry(DLC_APP_ID)
  fixture.database.reserveInstallPath(DLC_APP_ID, otherInstallPath)
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )
  queue.markRepairRequired(APP_ID, fixture.installPath)
  queue.markRepairRequired(DLC_APP_ID, otherInstallPath)

  expect(queue.getOperationState()).toMatchObject({
    status: 'repair-required',
    appId: APP_ID,
  })
  await queue.repairApplication({ appId: APP_ID })
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toMatchObject({
    status: 'repair-required',
    appId: DLC_APP_ID,
    installPath: otherInstallPath,
  })
})

test('cleanup failure transitions to repair-required instead of staying active', async () => {
  const fixture = await setup()
  const entered = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        const transaction = join(
          fixture.installPath,
          '.Kalamata',
          'transactions',
          'malformed',
        )
        await mkdir(transaction, { recursive: true })
        await writeFile(join(transaction, 'journal.json'), '{broken')
        entered.resolve()
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
  await entered.promise
  expect(await queue.cancel()).toEqual({ accepted: true })
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toMatchObject({
    status: 'repair-required',
    appId: APP_ID,
  })
})
