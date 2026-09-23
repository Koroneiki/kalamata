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
