import { afterEach, expect, mock } from 'bun:test'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReconcileApplicationOptions } from '../../../src/backend/depot/depot-download-service.ts'
import { ApplicationTransactionError } from '../../../src/backend/depot/install/transaction/types.ts'
import {
  getResumableApplicationTransaction,
  recoverApplicationTransaction,
} from '../../../src/backend/depot/install/transaction/recovery.ts'
import { DownloadQueueCoordinator } from '../../../src/backend/operations/download-queue.ts'
import {
  APP_ID,
  DEPOTS,
  DLC_APP_ID,
  type DownloadQueueFixture,
  deferred,
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

test('startup restores an explicitly paused download with its reserved path', async () => {
  const fixture = await setup()
  const options = restoreOptions(fixture)
  fixture.database.reserveInstallPath(APP_ID, fixture.installPath)
  await writeQueueStagingJournal(options, true)

  await recoverApplicationTransaction(fixture.installPath, {
    appId: APP_ID,
    reconcile: async () => {},
  })
  const resumable = await getResumableApplicationTransaction(
    fixture.installPath,
    APP_ID,
  )
  if (!resumable) fixture.database.clearUnusedInstallPath(APP_ID)

  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )
  await queue.restoreInterrupted()

  expect(fixture.database.getLibraryEntry(APP_ID)?.installPath).toBe(
    fixture.installPath,
  )
  expect(queue.getOperationState()).toMatchObject({
    status: 'paused',
    appId: APP_ID,
    installPath: fixture.installPath,
  })
})

test('startup automatically restarts a download interrupted while running', async () => {
  const fixture = await setup()
  const options = restoreOptions(fixture)
  fixture.database.reserveInstallPath(APP_ID, fixture.installPath)
  await writeQueueStagingJournal(options)
  const finish = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (reconcileOptions) => {
        await finish.promise
        return successfulReconciliation(reconcileOptions)
      },
    },
    fixture.database,
  )

  await queue.restoreInterrupted()

  expect(queue.getOperationState()).toMatchObject({
    status: 'active',
    appId: APP_ID,
    installPath: fixture.installPath,
  })
  finish.resolve()
  await waitForTerminal(queue)
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

function restoreOptions(
  fixture: DownloadQueueFixture,
): ReconcileApplicationOptions {
  const depot = DEPOTS[0]
  const manifest = fixture.database
    .getManifestRows(depot.depotId)
    .find(({ manifestId }) => manifestId === depot.manifestId)!
  return {
    kind: 'download',
    appId: APP_ID,
    outputDirectory: fixture.installPath,
    installedDepots: [],
    desiredDepots: [
      {
        depotId: depot.depotId,
        ownerAppId: APP_ID,
        manifestId: depot.manifestId,
        manifestPath: join(fixture.database.dataRoot, manifest.relativePath),
        depotKey: Buffer.from(depot.key, 'hex'),
      },
    ],
    reconcile: async () => {},
  }
}
