import { afterEach, expect, mock, test } from 'bun:test'
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type SteamUser from 'steam-user'
import {
  ApplicationTransactionError,
  getResumableApplicationTransaction,
  type ApplicationDepotRecord,
  type ApplicationTransactionResult,
} from '../src/backend/depot/application-transaction.ts'
import {
  DepotDownloadService,
  type ReconcileApplicationOptions,
} from '../src/backend/depot/depot-download-service.ts'
import type {
  ProductInfo,
  ProductInfoResult,
} from '../src/backend/steam/types.ts'
import { DownloadQueueCoordinator } from '../src/bun/download-queue.ts'
import { KalamataDatabase } from '../src/db/database.ts'

const APP_ID = 10
const DLC_APP_ID = 20
const DEPOTS = [
  {
    depotId: 2379781,
    manifestId: '3512319404653808464',
    key: '16261e41d3e864018778d4a1d81658521a67d9ffb8543ea7e3e21f0685721af1',
  },
  {
    depotId: 593281,
    manifestId: '7871757316108895128',
    key: '33130777c4dc3a1691afe38e0202242580e2135bfb239dcd83e50cd18d384687',
  },
] as const

let root: string | undefined
let database: KalamataDatabase | undefined

afterEach(async () => {
  database?.close()
  if (root) await rm(root, { recursive: true, force: true })
  database = undefined
  root = undefined
})

async function setup(): Promise<{
  database: KalamataDatabase
  installPath: string
}> {
  root = await mkdtemp(join(tmpdir(), 'kalamata-queue-'))
  database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  const installPath = join(root, 'install')
  await mkdir(installPath)
  database.addLibraryEntry(APP_ID)
  for (const depot of DEPOTS) {
    const relativePath = database.addManifest(depot.depotId, depot.manifestId)
    await copyFile(
      join(
        import.meta.dir,
        'fixtures',
        `${depot.depotId}_${depot.manifestId}.manifest`,
      ),
      join(root, relativePath),
    )
    database.setDepotKey(depot.depotId, depot.key)
  }
  return { database, installPath }
}

test('start returns active legacy state before product planning completes', async () => {
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
    status: 'running',
    depotIds: [DEPOTS[0].depotId],
    operation: 'planning',
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
  ).resolves.toMatchObject({ status: 'running' })
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
  expect(fixture.database.getInstalls(APP_ID).map(({ depotId }) => depotId)).toEqual([
    DEPOTS[0].depotId,
  ])
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
  await rm(join(root!, row.relativePath))
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
  await writeFile(join(root!, row.relativePath), 'malformed')
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
  const otherInstallPath = join(root!, 'other-install')
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
  fixture.database.reserveInstallPath(APP_ID, await realpath(fixture.installPath))
  const otherInstallPath = join(root!, 'other-install')
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
  expect(queue.pause()).toEqual({ accepted: true })
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
  expect(queue.pause()).toEqual({ accepted: true })
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
  expect(queue.pause()).toEqual({ accepted: true })
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

test('downloader rejects a non-32-byte inline key before reading inputs', async () => {
  const service = new DepotDownloadService({} as never)
  await expect(
    service.download({
      appId: APP_ID,
      depotId: DEPOTS[0].depotId,
      manifestPath: 'missing',
      depotKey: Buffer.alloc(31),
      outputDirectory: 'missing',
    }),
  ).rejects.toThrow('32-byte Buffer')
})

async function install(
  fixture: { database: KalamataDatabase; installPath: string },
  depot: (typeof DEPOTS)[number],
): Promise<void> {
  fixture.database.recordInstalledDepot(
    APP_ID,
    await realpath(fixture.installPath),
    depot.depotId,
    depot.manifestId,
  )
}

async function successfulReconciliation(
  options: ReconcileApplicationOptions,
): Promise<ApplicationTransactionResult> {
  const desired: ApplicationDepotRecord[] = options.desiredDepots.map(
    ({ depotId, manifestId, ownerAppId }, mountIndex) => ({
      depotId,
      manifestId,
      mountIndex,
      ownerAppId,
    }),
  )
  await options.reconcile(desired)
  return {
    transactionId: 'transaction-id',
    logicalInstalledBytes: '30',
    reusedLocalBytes: '20',
    networkBytes: '10',
  }
}

async function writeQueueStagingJournal(
  options: ReconcileApplicationOptions,
): Promise<void> {
  const id = 'queue-resume'
  const transaction = join(
    options.outputDirectory,
    '.Kalamata',
    'transactions',
    id,
  )
  await mkdir(join(transaction, 'staging'), { recursive: true })
  await writeFile(
    join(transaction, 'journal.json'),
    JSON.stringify({
      version: 2,
      id,
      generation: 'generation',
      appId: options.appId,
      kind: options.kind,
      installPath: options.outputDirectory,
      phase: 'staging',
      paused: false,
      source: options.installedDepots.map(
        ({ depotId, manifestId, ownerAppId }, mountIndex) => ({
          depotId,
          manifestId,
          mountIndex,
          ownerAppId,
        }),
      ),
      desired: options.desiredDepots.map(
        ({ depotId, manifestId, ownerAppId }, mountIndex) => ({
          depotId,
          manifestId,
          mountIndex,
          ownerAppId,
        }),
      ),
      stagedFiles: [],
      completedChunks: {},
      logicalInstalledTotal: '0',
      retainedBytes: '0',
      oldMoves: [],
      installs: [],
      obsoleteDirectories: [],
    }),
  )
}

async function waitForTerminal(queue: DownloadQueueCoordinator): Promise<void> {
  while (queue.getOperationState().status === 'active') await Bun.sleep(1)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function product(
  appId: number,
  depotEntries: Record<string, unknown>,
): ProductInfo {
  return {
    appId,
    changenumber: 1,
    missingToken: false,
    appinfo: {
      common: { name: 'Queue Test' },
      depots: depotEntries,
    } as unknown as SteamUser.AppInfoContent,
  }
}

function products(
  dlcManifestId: string = DEPOTS[1].manifestId,
): ProductInfoResult {
  return {
    baseProduct: product(APP_ID, {
      [DEPOTS[0].depotId]: depotMetadata(DEPOTS[0].manifestId),
    }),
    dlcProducts: [
      product(DLC_APP_ID, {
        [DEPOTS[1].depotId]: depotMetadata(dlcManifestId),
      }),
    ],
  }
}

function depotMetadata(manifestId: string) {
  return {
    config: { oslist: 'windows' },
    manifests: { public: { gid: manifestId, size: '10', download: '10' } },
  }
}
