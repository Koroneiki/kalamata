import { afterEach, expect, mock, test } from 'bun:test'
import { realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApplicationTransactionError } from '../../../src/backend/depot/install/transaction/types.ts'
import type { ReconcileApplicationOptions } from '../../../src/backend/depot/depot-download-service.ts'
import { DownloadQueueCoordinator } from '../../../src/backend/operations/download-queue.ts'
import {
  APP_ID,
  DEPOTS,
  DLC_APP_ID,
  type DownloadQueueFixture,
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

test('planning failure is a terminal typed state and does not reject start', async () => {
  const fixture = await setup()
  const secret = `${DEPOTS[0].key}: steam raw failure`
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => {
        throw new ApplicationTransactionError('steam', secret)
      },
      reconcileApplication: mock(successfulReconciliation),
    },
    fixture.database,
  )

  await expect(
    queue.start({
      appId: APP_ID,
      installPath: fixture.installPath,
      depotIds: [DEPOTS[0].depotId],
    }),
  ).resolves.toMatchObject({ status: 'active', phase: 'planning' })
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toEqual({
    status: 'failed',
    kind: 'download',
    appId: APP_ID,
    installPath: await realpath(fixture.installPath),
    desiredDepotIds: [DEPOTS[0].depotId],
    error: {
      kind: 'steam',
      message: 'Steam could not be reached or did not authorize the request.',
    },
  })
  const serialized = JSON.stringify(queue.getOperationState())
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain(DEPOTS[0].key)
})

test('queueDepotUpdate persists selections and reconciles the returned metadata order', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  let options!: ReconcileApplicationOptions
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (value) => {
        options = value
        return successfulReconciliation(value)
      },
    },
    fixture.database,
  )
  const desiredDepotIds = DEPOTS.map(({ depotId }) => depotId)

  const active = await queue.queueDepotUpdate({
    appId: APP_ID,
    desiredDepotIds: [...desiredDepotIds].reverse(),
  })
  expect(active.status).toBe('active')

  await waitForTerminal(queue)
  expect(options.desiredDepots.map(({ depotId }) => depotId)).toEqual(
    desiredDepotIds,
  )
  expect(fixture.database.getSelectedDepotIds(APP_ID)).toEqual(
    [...desiredDepotIds].sort((left, right) => left - right),
  )
  expect(fixture.database.getInstalls(APP_ID)).toEqual([
    expect.objectContaining({
      depotId: DEPOTS[0].depotId,
      ownerAppId: APP_ID,
    }),
    expect.objectContaining({
      depotId: DEPOTS[1].depotId,
      ownerAppId: DLC_APP_ID,
    }),
  ])
})

test('queueDepotUpdate rejects unavailable new depots without removing installs', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  fixture.database.replaceSelectedDepotIds(APP_ID, [DEPOTS[0].depotId])
  const reconcileApplication = mock(successfulReconciliation)
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication,
    },
    fixture.database,
  )

  await queue.queueDepotUpdate({
    appId: APP_ID,
    desiredDepotIds: [999999],
  })
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toMatchObject({
    status: 'failed',
    error: { kind: 'unavailable-resource' },
  })
  expect(
    fixture.database.getInstalls(APP_ID).map(({ depotId }) => depotId),
  ).toEqual([DEPOTS[0].depotId])
  expect(fixture.database.getSelectedDepotIds(APP_ID)).toEqual([
    DEPOTS[0].depotId,
  ])
  expect(reconcileApplication).not.toHaveBeenCalled()
})

test('queueDepotUpdate preserves selections when local inputs are unavailable', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  fixture.database.replaceSelectedDepotIds(APP_ID, [DEPOTS[0].depotId])
  const row = fixture.database.getManifestRows(DEPOTS[1].depotId)[0]!
  await rm(join(fixture.root, row.relativePath))
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: mock(successfulReconciliation),
    },
    fixture.database,
  )

  await queue.queueDepotUpdate({
    appId: APP_ID,
    desiredDepotIds: [DEPOTS[0].depotId, DEPOTS[1].depotId],
  })
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toMatchObject({
    status: 'failed',
    error: { kind: 'unavailable-resource' },
  })
  expect(fixture.database.getSelectedDepotIds(APP_ID)).toEqual([
    DEPOTS[0].depotId,
  ])
})

test('queueDepotUpdate preserves selections when a manifest is malformed', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  fixture.database.replaceSelectedDepotIds(APP_ID, [DEPOTS[0].depotId])
  const row = fixture.database.getManifestRows(DEPOTS[1].depotId)[0]!
  await writeFile(join(fixture.root, row.relativePath), 'malformed')
  const reconcileApplication = mock(successfulReconciliation)
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication,
    },
    fixture.database,
  )

  await queue.queueDepotUpdate({
    appId: APP_ID,
    desiredDepotIds: [DEPOTS[0].depotId, DEPOTS[1].depotId],
  })
  await waitForTerminal(queue)

  expect(queue.getOperationState()).toMatchObject({
    status: 'failed',
    error: { kind: 'unavailable-resource' },
  })
  expect(fixture.database.getSelectedDepotIds(APP_ID)).toEqual([
    DEPOTS[0].depotId,
  ])
  expect(reconcileApplication).not.toHaveBeenCalled()
})

test('queueDepotUpdate checks Steam metadata when the selection is unchanged', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  const getProductInfoWithDlc = mock(async () => products())
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc,
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )

  await queue.queueDepotUpdate({
    appId: APP_ID,
    desiredDepotIds: [DEPOTS[0].depotId],
  })
  await waitForTerminal(queue)

  expect(getProductInfoWithDlc).toHaveBeenCalledTimes(1)
  expect(queue.getOperationState().status).toBe('completed')
})

test('startDownload is additive and preserves an omitted installed manifest', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[1])
  let options!: ReconcileApplicationOptions
  const publicReplacement = '9999999999999999999'
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(publicReplacement),
      reconcileApplication: async (value) => {
        options = value
        return successfulReconciliation(value)
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

  expect(options.installedDepots).toEqual([
    expect.objectContaining({
      depotId: DEPOTS[1].depotId,
      manifestId: DEPOTS[1].manifestId,
    }),
  ])
  expect(options.desiredDepots.map(({ depotId }) => depotId)).toEqual(
    DEPOTS.map(({ depotId }) => depotId),
  )
  expect(
    options.desiredDepots.find(({ depotId }) => depotId === DEPOTS[1].depotId),
  ).toMatchObject({ manifestId: DEPOTS[1].manifestId })
  expect(JSON.stringify(options.desiredDepots)).not.toContain(publicReplacement)
})

test('repair uses the persisted installed version and mount order', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  fixture.database.replaceSelectedDepotIds(APP_ID, [DEPOTS[1].depotId])
  let options!: ReconcileApplicationOptions
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (value) => {
        options = value
        return successfulReconciliation(value)
      },
    },
    fixture.database,
  )

  const active = await queue.repairApplication({ appId: APP_ID })
  expect(active).toMatchObject({
    kind: 'repair',
    desiredDepotIds: [DEPOTS[0].depotId],
  })
  await waitForTerminal(queue)

  expect(options.desiredDepots.map(({ depotId }) => depotId)).toEqual([
    DEPOTS[0].depotId,
  ])
})

test('repair preserves the persisted DLC owner application', async () => {
  const fixture = await setup()
  fixture.database.reconcileInstalledDepots(APP_ID, fixture.installPath, [
    {
      depotId: DEPOTS[1].depotId,
      manifestId: DEPOTS[1].manifestId,
      mountIndex: 0,
      ownerAppId: DLC_APP_ID,
    },
  ])
  let options!: ReconcileApplicationOptions
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (value) => {
        options = value
        return successfulReconciliation(value)
      },
    },
    fixture.database,
  )

  await queue.repairApplication({ appId: APP_ID })
  await waitForTerminal(queue)

  expect(options.desiredDepots).toEqual([
    expect.objectContaining({
      depotId: DEPOTS[1].depotId,
      ownerAppId: DLC_APP_ID,
    }),
  ])
})

test('repair resolves unknown legacy DLC ownership from metadata', async () => {
  const fixture = await setup()
  fixture.database.reconcileInstalledDepots(APP_ID, fixture.installPath, [
    {
      depotId: DEPOTS[1].depotId,
      manifestId: DEPOTS[1].manifestId,
      mountIndex: 0,
    },
  ])
  fixture.database.sqlite
    .query(
      'UPDATE library_depot_installs SET owner_app_id = NULL WHERE app_id = ?',
    )
    .run(APP_ID)
  let options!: ReconcileApplicationOptions
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => products(),
      reconcileApplication: async (value) => {
        options = value
        return successfulReconciliation(value)
      },
    },
    fixture.database,
  )

  await queue.repairApplication({ appId: APP_ID })
  await waitForTerminal(queue)

  expect(options.desiredDepots[0]).toMatchObject({
    depotId: DEPOTS[1].depotId,
    ownerAppId: DLC_APP_ID,
  })
})

test('pure removal resolves unknown ownership for retained legacy DLC', async () => {
  const fixture = await setup()
  fixture.database.reconcileInstalledDepots(APP_ID, fixture.installPath, [
    {
      depotId: DEPOTS[0].depotId,
      manifestId: DEPOTS[0].manifestId,
      mountIndex: 0,
    },
    {
      depotId: DEPOTS[1].depotId,
      manifestId: DEPOTS[1].manifestId,
      mountIndex: 1,
    },
  ])
  fixture.database.sqlite
    .query(
      'UPDATE library_depot_installs SET owner_app_id = NULL WHERE app_id = ?',
    )
    .run(APP_ID)
  const getProductInfoWithDlc = mock(async () => products())
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc,
      reconcileApplication: successfulReconciliation,
    },
    fixture.database,
  )

  await queue.queueDepotUpdate({
    appId: APP_ID,
    desiredDepotIds: [DEPOTS[1].depotId],
  })
  await waitForTerminal(queue)

  expect(getProductInfoWithDlc).toHaveBeenCalledTimes(1)
  expect(fixture.database.getInstalls(APP_ID)).toEqual([
    expect.objectContaining({
      depotId: DEPOTS[1].depotId,
      ownerAppId: DLC_APP_ID,
    }),
  ])
})
