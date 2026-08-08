import { afterEach, expect, mock, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type SteamUser from 'steam-user'
import { DepotDownloadService } from '../src/backend/depot/depot-download-service.ts'
import type {
  DownloadDepotOptions,
  DownloadResult,
} from '../src/backend/depot/types.ts'
import type { ProductInfo } from '../src/backend/steam/types.ts'
import { DownloadQueueCoordinator } from '../src/bun/download-queue.ts'
import { KalamataDatabase } from '../src/db/database.ts'
import type { DownloadQueueState } from '../src/types/rpc.ts'

const APP_ID = 10
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

async function setup(
  seedSecond = true,
): Promise<{ database: KalamataDatabase; installPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'kalamata-queue-'))
  database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  const installPath = join(root, 'install')
  await mkdir(installPath)
  for (const [index, depot] of DEPOTS.entries()) {
    const relativePath = database.addManifest(depot.depotId, depot.manifestId)
    await copyFile(
      join(
        import.meta.dir,
        'fixtures',
        `${depot.depotId}_${depot.manifestId}.manifest`,
      ),
      join(root, relativePath),
    )
    if (index === 0 || seedSecond)
      database.setDepotKey(depot.depotId, depot.key)
  }
  return { database, installPath }
}

test('validates the whole plan, runs in order, maps events, and persists atomically', async () => {
  const { database, installPath } = await setup()
  const calls: number[] = []
  const emitted: unknown[] = []
  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
  let active = 0
  let maximumActive = 0
  const downloadDepot = mock(async (options: DownloadDepotOptions) => {
    calls.push(options.depotId)
    active++
    maximumActive = Math.max(maximumActive, active)
    options.onEvent?.({ type: 'progress', downloaded: '4', total: '10' })
    options.onEvent?.({ type: 'file-validating', path: 'folder/file.bin' })
    if (options.depotId === DEPOTS[0].depotId) await firstBlocked
    active--
    return {
      manifestId: DEPOTS.find(({ depotId }) => depotId === options.depotId)!
        .manifestId,
      downloadedBytes: String(options.depotId),
      reusedBytes: '2',
    }
  })
  const queue = new DownloadQueueCoordinator(
    { getProductInfo: async () => product(), downloadDepot },
    database,
    (state) => emitted.push(state),
  )

  const initial = await queue.start({
    appId: APP_ID,
    installPath,
    depotIds: DEPOTS.map(({ depotId }) => depotId),
  })
  expect(initial).toMatchObject({ status: 'running', position: 1, total: 2 })
  expect(database.getLibrary()).toEqual([])
  expect(calls).toEqual([DEPOTS[0].depotId])
  await expect(
    queue.start({ appId: APP_ID, installPath, depotIds: [DEPOTS[0].depotId] }),
  ).rejects.toThrow('already running')

  releaseFirst()
  await waitForTerminal(queue)
  expect(calls).toEqual(DEPOTS.map(({ depotId }) => depotId))
  expect(maximumActive).toBe(1)
  expect(database.getLibrary()).toHaveLength(1)
  expect(database.getInstalls(APP_ID)).toHaveLength(2)
  expect(queue.getState()).toEqual({
    status: 'completed',
    appId: APP_ID,
    installPath: await realpath(installPath),
    depotIds: DEPOTS.map(({ depotId }) => depotId),
    completedDepotIds: DEPOTS.map(({ depotId }) => depotId),
    downloadedBytes: String(DEPOTS[0].depotId + DEPOTS[1].depotId),
    reusedBytes: '4',
  })
  expect(
    emitted.some(
      (state: any) => state.operation === 'Validating folder/file.bin',
    ),
  ).toBe(true)
  expect(() => JSON.stringify(emitted)).not.toThrow()
})

test('rejects duplicate IDs and unavailable later depots before downloading', async () => {
  const { database, installPath } = await setup(false)
  const downloadDepot = mock(async () => resultFor(DEPOTS[0]))
  const queue = new DownloadQueueCoordinator(
    { getProductInfo: async () => product(), downloadDepot },
    database,
  )
  await expect(
    queue.start({
      appId: APP_ID,
      installPath,
      depotIds: [DEPOTS[0].depotId, DEPOTS[0].depotId],
    }),
  ).rejects.toThrow('duplicates')
  await expect(
    queue.start({
      appId: APP_ID,
      installPath,
      depotIds: DEPOTS.map(({ depotId }) => depotId),
    }),
  ).rejects.toThrow(`Depot ${DEPOTS[1].depotId} is not available`)
  expect(downloadDepot).not.toHaveBeenCalled()
  expect(database.getLibrary()).toEqual([])
})

test('stops after a download failure and retains prior committed installs', async () => {
  const { database, installPath } = await setup()
  const calls: number[] = []
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfo: async () => product(),
      downloadDepot: async (options) => {
        calls.push(options.depotId)
        if (options.depotId === DEPOTS[1].depotId)
          throw new Error('CDN unavailable')
        return resultFor(DEPOTS[0])
      },
    },
    database,
  )
  await queue.start({
    appId: APP_ID,
    installPath,
    depotIds: DEPOTS.map(({ depotId }) => depotId),
  })
  await waitForTerminal(queue)
  expect(queue.getState()).toMatchObject({
    status: 'failed',
    completedDepotIds: [DEPOTS[0].depotId],
    failedDepotId: DEPOTS[1].depotId,
    failureKind: 'download',
    error:
      'The depot could not be downloaded. Start the download again to resume it.',
  })
  expect(JSON.stringify(queue.getState())).not.toContain('CDN unavailable')
  expect(calls).toEqual(DEPOTS.map(({ depotId }) => depotId))
  expect(database.getInstalls(APP_ID)).toEqual([
    { depotId: DEPOTS[0].depotId, installedManifestId: DEPOTS[0].manifestId },
  ])
})

test('stops after persistence failure without marking the depot completed', async () => {
  const { database, installPath } = await setup()
  const original = database.recordInstalledDepot.bind(database)
  let persistenceCalls = 0
  database.recordInstalledDepot = (...args) => {
    persistenceCalls++
    if (persistenceCalls === 2) throw new Error('database full')
    original(...args)
  }
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfo: async () => product(),
      downloadDepot: async ({ depotId }) =>
        resultFor(DEPOTS.find((depot) => depot.depotId === depotId)!),
    },
    database,
  )
  await queue.start({
    appId: APP_ID,
    installPath,
    depotIds: DEPOTS.map(({ depotId }) => depotId),
  })
  await waitForTerminal(queue)
  expect(queue.getState()).toMatchObject({
    status: 'failed',
    completedDepotIds: [DEPOTS[0].depotId],
    failedDepotId: DEPOTS[1].depotId,
    failureKind: 'persistence',
    error:
      'The depot files were downloaded, but the installation could not be recorded. Start the download again to reconcile it.',
  })
  expect(JSON.stringify(queue.getState())).not.toContain('database full')
  expect(database.getInstalls(APP_ID)).toHaveLength(1)
})

test('preserves exact byte totals beyond the safe integer range', async () => {
  const { database, installPath } = await setup()
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfo: async () => product(),
      downloadDepot: async ({ depotId }) => ({
        manifestId: DEPOTS.find((depot) => depot.depotId === depotId)!
          .manifestId,
        downloadedBytes: '9007199254740993',
        reusedBytes: '9007199254740993',
      }),
    },
    database,
  )

  await queue.start({
    appId: APP_ID,
    installPath,
    depotIds: DEPOTS.map(({ depotId }) => depotId),
  })
  await waitForTerminal(queue)

  expect(queue.getState()).toMatchObject({
    status: 'completed',
    downloadedBytes: '18014398509481986',
    reusedBytes: '18014398509481986',
  })
})

test('coalesces progress updates within one event-loop turn', async () => {
  const { database, installPath } = await setup()
  const emitted: DownloadQueueState[] = []
  let emitProgress!: (downloaded: string) => void
  let finish!: () => void
  const blocked = new Promise<void>((resolve) => (finish = resolve))
  const queue = new DownloadQueueCoordinator(
    {
      getProductInfo: async () => product(),
      downloadDepot: async (options) => {
        emitProgress = (downloaded) =>
          options.onEvent?.({ type: 'progress', downloaded, total: '100' })
        emitProgress('1')
        await Promise.resolve()
        emitProgress('2')
        await Promise.resolve()
        emitProgress('3')
        await blocked
        return resultFor(DEPOTS[0])
      },
    },
    database,
    (state) => emitted.push(state),
  )

  await queue.start({
    appId: APP_ID,
    installPath,
    depotIds: [DEPOTS[0].depotId],
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(
    emitted.filter(
      (state) => state.status === 'running' && state.downloadedBytes !== '0',
    ),
  ).toEqual([
    expect.objectContaining({ downloadedBytes: '3', totalBytes: '100' }),
  ])

  emitProgress('4')
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(
    emitted.filter(
      (state) => state.status === 'running' && state.downloadedBytes !== '0',
    ),
  ).toHaveLength(2)
  finish()
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

async function waitForTerminal(queue: DownloadQueueCoordinator): Promise<void> {
  while (queue.getState().status === 'running') await Bun.sleep(1)
}

function resultFor(depot: (typeof DEPOTS)[number]): DownloadResult {
  return {
    manifestId: depot.manifestId,
    downloadedBytes: '1',
    reusedBytes: '0',
  }
}

function product(): ProductInfo {
  return {
    appId: APP_ID,
    changenumber: 1,
    missingToken: false,
    appinfo: {
      common: { name: 'Queue Test' },
      depots: Object.fromEntries(
        DEPOTS.map((depot) => [
          depot.depotId,
          {
            manifests: {
              public: { gid: depot.manifestId, size: '10', download: '10' },
            },
          },
        ]),
      ),
    } as unknown as SteamUser.AppInfoContent,
  }
}
