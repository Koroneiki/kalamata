import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundDownloadCoordinator } from '../../src/backend/downloads/background-download-coordinator.ts'
import type { JobContext } from '../../src/backend/downloads/background-download-coordinator.ts'
import type { BackgroundDownloadsSnapshot } from '../../src/types/background-downloads.ts'

test('shares a semantic job, runs queued downloads in order, and retries failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'background-jobs-'))
  const snapshots: BackgroundDownloadsSnapshot[] = []
  const coordinator = new BackgroundDownloadCoordinator(root, (state) =>
    snapshots.push(state),
  )
  try {
    await coordinator.initialize()
    let runs = 0
    const order: string[] = []
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const definition = {
      key: 'manifest:1:2',
      kind: 'manifest' as const,
      title: 'Manifest',
      run: async ({ signal, workspace, progress, setSource }: JobContext) => {
        runs++
        await writeFile(join(workspace, 'partial'), 'incomplete')
        progress('downloading', 3, 10)
        setSource('Hubcap API')
        if (runs === 1) {
          await ready
          throw new Error('Network unavailable')
        }
        signal.throwIfAborted()
        return 'validated'
      },
    }
    const first = coordinator.enqueue(definition)
    const same = coordinator.enqueue(definition)
    expect(first).toBe(same)
    const second = coordinator.enqueue({
      key: 'dependency:gbe',
      kind: 'dependency',
      title: 'GBE',
      run: async () => {
        order.push('second')
        return 'installed'
      },
    })
    const third = coordinator.enqueue({
      key: 'dependency:gse',
      kind: 'dependency',
      title: 'GSE',
      run: async () => {
        order.push('third')
        return 'installed'
      },
    })
    const id = coordinator.snapshot().jobs[0]!.id
    const thirdId = coordinator.snapshot().jobs[2]!.id
    expect(coordinator.snapshot().jobs.map(({ status }) => status)).toEqual([
      'active',
      'queued',
      'queued',
    ])
    expect(coordinator.prioritize(thirdId)).toBe(true)
    expect(coordinator.snapshot().jobs[1]?.id).toBe(thirdId)
    expect(coordinator.snapshot().jobs[0]?.status).toBe('active')
    while (coordinator.snapshot().jobs[0]?.source !== 'Hubcap API')
      await Bun.sleep(1)
    expect(coordinator.snapshot().jobs[0]).toMatchObject({
      transferredBytes: 0,
      totalBytes: null,
    })
    release()
    await expect(first).rejects.toThrow('Network unavailable')
    expect(await second).toBe('installed')
    expect(await third).toBe('installed')
    expect(order).toEqual(['third', 'second'])
    expect(coordinator.snapshot().jobs[0]!.status).toBe('failed')
    expect(await readdir(join(root, 'background-downloads'))).toEqual([])
    const nextId = coordinator.retry(id)
    expect(nextId).not.toBe(id)
    // The new run starts once its workspace exists.
    while (
      coordinator.snapshot().jobs.find(({ id }) => id === nextId)?.status ===
      'active'
    )
      await Bun.sleep(1)
    expect(runs).toBe(2)
    expect(
      coordinator.snapshot().jobs.find(({ id }) => id === nextId)?.status,
    ).toBe('completed')
    expect(snapshots.some(({ jobs }) => jobs[1]?.status === 'queued')).toBe(
      true,
    )
    expect(await readdir(join(root, 'background-downloads'))).toEqual([])
    expect(coordinator.dismiss(nextId)).toBe(true)
    expect(coordinator.snapshot().jobs).toHaveLength(2)
  } finally {
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test('groups manifest tasks by parent app and retries only failed manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'background-jobs-'))
  const coordinator = new BackgroundDownloadCoordinator(root, () => {})
  try {
    await coordinator.initialize()
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const firstReady = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstAttempts = 0
    const first = coordinator.enqueue({
      key: 'manifest:dlc-depot:1',
      groupKey: 'manifest-app:100',
      kind: 'manifest',
      title: 'Manifests for app 100',
      appId: 100,
      run: async () => {
        firstAttempts++
        if (firstAttempts === 1) {
          firstStarted()
          await holdFirst
          throw new Error('first manifest failed')
        }
        return 'retried manifest'
      },
    })
    await firstReady
    const second = coordinator.enqueue({
      key: 'manifest:base-depot:2',
      groupKey: 'manifest-app:100',
      kind: 'manifest',
      title: 'Manifests for app 100',
      appId: 100,
      run: async () => 'second manifest',
    })
    const otherApp = coordinator.enqueue({
      key: 'manifest:other-app-depot:3',
      groupKey: 'manifest-app:200',
      kind: 'manifest',
      title: 'Manifests for app 200',
      appId: 200,
      run: async () => 'other app manifest',
    })

    expect(coordinator.snapshot().jobs).toHaveLength(2)
    expect(coordinator.snapshot().jobs[0]).toMatchObject({
      appId: 100,
      depotId: null,
      itemCount: 2,
      status: 'active',
    })
    releaseFirst()
    const outcomes = await Promise.allSettled([first, second, otherApp])
    expect(outcomes.map(({ status }) => status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
    ])
    expect(firstAttempts).toBe(1)

    const failed = coordinator
      .snapshot()
      .jobs.find(({ appId }) => appId === 100)
    expect(failed).toMatchObject({
      itemCount: 2,
      status: 'failed',
      totalBytes: null,
      manifestProgress: { finishedCount: 2, currentIndex: null },
    })
    const retryId = coordinator.retry(failed!.id)
    while (
      coordinator.snapshot().jobs.find(({ id }) => id === retryId)?.status !==
      'completed'
    ) {
      await Bun.sleep(1)
    }
    expect(firstAttempts).toBe(2)
    expect(
      coordinator.snapshot().jobs.find(({ id }) => id === retryId),
    ).toMatchObject({
      appId: 100,
      itemCount: 1,
      status: 'completed',
      totalBytes: null,
    })
  } finally {
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps manifest progress and byte totals across grouped tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'background-jobs-'))
  const coordinator = new BackgroundDownloadCoordinator(root, () => {})
  try {
    await coordinator.initialize()
    let firstStarted!: () => void
    let releaseFirst!: () => void
    let secondStarted!: () => void
    let releaseSecond!: () => void
    const firstReady = new Promise<void>((resolve) => (firstStarted = resolve))
    const holdFirst = new Promise<void>((resolve) => (releaseFirst = resolve))
    const secondReady = new Promise<void>(
      (resolve) => (secondStarted = resolve),
    )
    const holdSecond = new Promise<void>((resolve) => (releaseSecond = resolve))
    const first = coordinator.enqueue({
      key: 'manifest:1:10',
      groupKey: 'manifest-app:100',
      kind: 'manifest',
      title: 'Manifests for app 100',
      appId: 100,
      depotId: 1,
      run: async ({ progress }: JobContext) => {
        progress('downloading', 5, 10)
        firstStarted()
        await holdFirst
        progress('verifying', 10, 10)
      },
    })
    await firstReady
    const second = coordinator.enqueue({
      key: 'manifest:2:20',
      groupKey: 'manifest-app:100',
      kind: 'manifest',
      title: 'Manifests for app 100',
      appId: 100,
      depotId: 2,
      run: async ({ progress, setSource }: JobContext) => {
        progress('downloading', 3, 6)
        setSource('Hubcap API')
        progress('downloading', 4, 6)
        secondStarted()
        await holdSecond
        progress('verifying', 6, 6)
      },
    })
    const duringFirst = coordinator.snapshot().jobs[0]!
    expect(duringFirst).toMatchObject({
      itemCount: 2,
      transferredBytes: 5,
      totalBytes: null,
      manifestProgress: {
        finishedCount: 0,
        currentIndex: 1,
        currentDepotId: 1,
        transferredBytes: 5,
        totalBytes: 10,
      },
    })
    releaseFirst()
    await secondReady
    expect(coordinator.snapshot().jobs[0]).toMatchObject({
      transferredBytes: 14,
      totalBytes: null,
      manifestProgress: {
        finishedCount: 1,
        currentIndex: 2,
        currentDepotId: 2,
        transferredBytes: 4,
        totalBytes: 6,
      },
    })
    expect(duringFirst.manifestProgress?.finishedCount).toBe(0)
    releaseSecond()
    await Promise.all([first, second])
    expect(coordinator.snapshot().jobs[0]).toMatchObject({
      status: 'completed',
      transferredBytes: 16,
      totalBytes: 16,
      manifestProgress: {
        finishedCount: 2,
        currentIndex: null,
        currentDepotId: null,
      },
    })
  } finally {
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test('startup discards abandoned scratch and shutdown waits for abortable jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'background-jobs-'))
  const scratch = join(root, 'background-downloads')
  await mkdir(join(scratch, 'orphan'), { recursive: true })
  await Bun.write(join(scratch, 'orphan', 'partial'), 'old data')
  const coordinator = new BackgroundDownloadCoordinator(root, () => {})
  try {
    await coordinator.initialize()
    expect(await readdir(scratch)).toEqual([])
    let settle!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const job = coordinator.enqueue({
      key: 'dependency:gbe',
      kind: 'dependency',
      title: 'GBE',
      run: async ({ signal, workspace }) => {
        await writeFile(join(workspace, 'partial'), 'download')
        started()
        await new Promise<void>((resolve) => {
          settle = resolve
        })
        signal.throwIfAborted()
      },
    })
    await ready
    const stopping = coordinator.shutdown()
    expect(() =>
      coordinator.enqueue({
        key: 'other',
        kind: 'manifest',
        title: 'other',
        run: async () => {},
      }),
    ).toThrow('shutting down')
    expect(
      await readFile(
        join(scratch, coordinator.snapshot().jobs[0]!.id, 'partial'),
        'utf8',
      ),
    ).toBe('download')
    settle()
    await expect(job).rejects.toThrow('shutting down')
    await stopping
    expect(await readdir(root)).toEqual([])
    const restarted = new BackgroundDownloadCoordinator(root, () => {})
    await restarted.initialize()
    expect(restarted.snapshot().jobs).toEqual([])
    await restarted.shutdown()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shutdown does not wait for an unabortable provider or admit its late result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'background-jobs-'))
  const coordinator = new BackgroundDownloadCoordinator(root, () => {})
  try {
    await coordinator.initialize()
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let applied = false
    const update = coordinator.enqueue({
      key: 'application-update',
      kind: 'application-update',
      title: 'Update',
      canCancel: false,
      run: async ({ signal }) => {
        started()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        signal.throwIfAborted()
        applied = true
      },
    })
    await ready
    await coordinator.shutdown()
    expect(applied).toBe(false)
    release()
    await expect(update).rejects.toThrow('shutting down')
    expect(applied).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
