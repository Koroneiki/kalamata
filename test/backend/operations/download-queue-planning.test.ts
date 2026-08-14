import { afterEach, expect, mock } from 'bun:test'
import { realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApplicationTransactionError } from '../../../src/backend/depot/install/transaction/types.ts'
import type { ReconcileApplicationOptions } from '../../../src/backend/depot/depot-download-service.ts'
import { DownloadQueueCoordinator } from '../../../src/backend/operations/download-queue.ts'
import { planApplication } from '../../../src/backend/operations/application-planner.ts'
import {
  APP_ID,
  DEPOTS,
  DLC_APP_ID,
  type DownloadQueueFixture,
  install,
  products,
  queueTest as test,
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
  const reportError = mock(
    (
      _error: Error,
      _context: {
        appId: number
        kind: 'download' | 'reconcile' | 'repair'
      },
    ) => {},
  )
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfoWithDlc: async () => {
        throw new ApplicationTransactionError('steam', secret)
      },
      reconcileApplication: mock(successfulReconciliation),
    },
    fixture.database,
    () => {},
    reportError,
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
  expect(reportError).toHaveBeenCalledTimes(1)
  const reportedError = reportError.mock.calls[0]![0]
  expect(reportedError).toMatchObject({
    name: 'OperationError:steam',
    message: 'Steam could not be reached or did not authorize the request.',
  })
  expect(reportedError.stack).not.toContain(secret)
  expect(reportedError.stack).not.toContain(DEPOTS[0].key)
})

test('planning reuses manifest resources without reusing occurrence ownership', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  const getManifestRows = mock(
    fixture.database.getManifestRows.bind(fixture.database),
  )
  fixture.database.getManifestRows = getManifestRows

  const plan = await planApplication(
    {
      kind: 'repair',
      appId: APP_ID,
      installPath: fixture.installPath,
      fixedDesired: [
        {
          depotId: DEPOTS[0].depotId,
          manifestId: DEPOTS[0].manifestId,
          mountIndex: 0,
          ownerAppId: DLC_APP_ID,
        },
      ],
    },
    { getProductInfoWithDlc: async () => products() },
    fixture.database,
    new AbortController().signal,
    () => {},
  )

  expect(getManifestRows).toHaveBeenCalledTimes(1)
  expect(plan.installedDepots).toEqual([
    expect.objectContaining({ ownerAppId: APP_ID }),
  ])
  expect(plan.desiredDepots).toEqual([
    expect.objectContaining({ ownerAppId: DLC_APP_ID }),
  ])
})

test('planning restores a fixed new depot from its local manifest and key', async () => {
  const fixture = await setup()
  const getProductInfoWithDlc = mock(async () => products())

  const plan = await planApplication(
    {
      kind: 'download',
      appId: APP_ID,
      installPath: fixture.installPath,
      requestedDepotIds: [DEPOTS[0].depotId],
      fixedDesired: [
        {
          depotId: DEPOTS[0].depotId,
          manifestId: DEPOTS[0].manifestId,
          mountIndex: 0,
          ownerAppId: APP_ID,
        },
      ],
    },
    { getProductInfoWithDlc },
    fixture.database,
    new AbortController().signal,
    () => {},
  )

  expect(getProductInfoWithDlc).not.toHaveBeenCalled()
  expect(plan.desiredDepots).toEqual([
    expect.objectContaining({
      depotId: DEPOTS[0].depotId,
      manifestId: DEPOTS[0].manifestId,
      ownerAppId: APP_ID,
    }),
  ])
})

test('custom targets are always pinned', async () => {
  const fixture = await setup()
  await install(fixture, DEPOTS[0])
  fixture.database.setDepotPinned(APP_ID, DEPOTS[0].depotId, true)

  const plan = await planApplication(
    {
      kind: 'reconcile',
      appId: APP_ID,
      installPath: fixture.installPath,
      desiredDepotIds: [DEPOTS[0].depotId],
      manifestTargets: [
        {
          depotId: DEPOTS[0].depotId,
          manifestId: DEPOTS[0].manifestId,
        },
      ],
    },
    { getProductInfoWithDlc: async () => products() },
    fixture.database,
    new AbortController().signal,
    () => {},
  )

  expect(plan.desiredDepots[0]).toMatchObject({
    manifestId: DEPOTS[0].manifestId,
    pinned: true,
  })
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
