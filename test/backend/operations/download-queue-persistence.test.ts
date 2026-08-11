import { afterEach, expect, test } from 'bun:test'
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

test('reconciliation callback replaces SQLite installs as one desired set', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  await install(fixture, DEPOTS[1])
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )

  await queue.queueDepotUpdate({
    appId: APP_ID,
    desiredDepotIds: [DEPOTS[0].depotId],
  })
  await waitForTerminal(queue)

  expect(fixture.database.getInstalls(APP_ID)).toEqual([
    {
      depotId: DEPOTS[0].depotId,
      installedManifestId: DEPOTS[0].manifestId,
      mountIndex: 0,
      ownerAppId: APP_ID,
    },
  ])
})

test('application transaction progress maps exact decimal counters', async () => {
  const fixture = await setup()
  const progressEmitted = deferred<void>()
  const finish = deferred<void>()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (options) => {
        options.onEvent?.({ type: 'phase', phase: 'downloading' })
        options.onEvent?.({
          type: 'progress',
          logicalInstalledCompleted: '9007199254740993',
          logicalInstalledTotal: '18014398509481987',
          reusedLocal: '9223372036854775808',
          actualNetwork: '18446744073709551617',
        })
        progressEmitted.resolve()
        await finish.promise
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
  await progressEmitted.promise

  expect(queue.getOperationState()).toMatchObject({
    status: 'active',
    phase: 'downloading',
    installedBytesCompleted: '9007199254740993',
    installedBytesTotal: '18014398509481987',
    reusedLocalBytes: '9223372036854775808',
    networkBytes: '18446744073709551617',
  })
  expect(queue.getState()).toMatchObject({
    status: 'running',
    downloadedBytes: '9007199254740993',
    totalBytes: '18014398509481987',
  })

  finish.resolve()
  await waitForTerminal(queue)
})
