import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadHistory } from '../../src/backend/downloads/download-history.ts'
import { BackgroundDownloadCoordinator } from '../../src/backend/downloads/background-download-coordinator.ts'
import type { OperationLifecycleEvent } from '../../src/backend/operations/download-queue.ts'
import { removeTemporaryDirectory } from '../helpers/filesystem.ts'

function completedOperation(appId: number): OperationLifecycleEvent {
  return {
    event: 'operation.completed',
    operationId: String(appId),
    transactionId: null,
    appId,
    kind: 'download',
    desiredDepotIds: [1, 2, 3],
    depotCount: 3,
    filesAdded: 1,
    filesModified: 0,
    filesDeleted: 0,
    networkBytes: '1024',
    reusedLocalBytes: '0',
  }
}

test('persists mixed job and game history, retaining only the newest 100 entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kalamata-history-'))
  const history = new DownloadHistory(root)
  const jobs = new BackgroundDownloadCoordinator(
    root,
    () => {},
    (job) => history.recordJob(job),
  )
  try {
    await history.initialize()
    await jobs.initialize()
    for (let appId = 1; appId <= 100; appId++)
      history.recordOperation(completedOperation(appId))
    await jobs.enqueue({
      key: 'manifest',
      appId: 101,
      kind: 'manifest',
      title: 'Manifests',
      groupKey: 'manifests:101',
      run: async (context) => {
        context.setSource('GitHub')
        context.progress('downloading', 512, 512)
      },
    })
    await history.flush()

    const restored = new DownloadHistory(root)
    await restored.initialize()
    expect(restored.snapshot()).toHaveLength(100)
    expect(restored.snapshot()[0]).toMatchObject({
      appId: 101,
      compact: true,
      status: 'completed',
      description: '1 manifest · GitHub',
      transferredBytes: '512',
      totalBytes: '512',
    })
    expect(restored.snapshot()[1]).toMatchObject({
      appId: 100,
      compact: false,
      transferredBytes: '1024',
      operation: 'install',
      depotCount: 3,
    })
    expect(restored.snapshot().at(-1)?.appId).toBe(2)
  } finally {
    await jobs.shutdown()
    await history.flush()
    await removeTemporaryDirectory(root)
  }
})

test('dismissing one entry persists without deleting other entries or subsequent completions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kalamata-history-dismiss-'))
  const history = new DownloadHistory(root)
  try {
    await history.initialize()
    history.recordJob({
      id: 'failed-manifests',
      key: 'manifests:1',
      kind: 'manifest',
      title: 'Manifests',
      appId: 1,
      depotId: null,
      itemCount: 3,
      status: 'failed',
      phase: 'failed',
      source: 'GitHub',
      transferredBytes: 0,
      totalBytes: 512,
      error: 'Manifest unavailable',
      finishedAt: Date.now(),
    })
    history.recordOperation(completedOperation(2))
    const gameId = history.snapshot()[0]!.id
    const dismissed = history.dismiss(gameId)
    history.recordOperation(completedOperation(3))
    await dismissed
    await history.flush()

    const restored = new DownloadHistory(root)
    await restored.initialize()
    expect(restored.snapshot().map(({ appId }) => appId)).toEqual([3, 1])
    expect(restored.snapshot()[1]).toMatchObject({
      description: '3 manifests · GitHub',
      transferredBytes: '0',
      totalBytes: '512',
      status: 'failed',
      error: 'Manifest unavailable',
    })
    await restored.dismiss('failed-manifests')
    const restarted = new DownloadHistory(root)
    await restarted.initialize()
    expect(restarted.snapshot().map(({ appId }) => appId)).toEqual([3])
  } finally {
    await history.flush()
    await removeTemporaryDirectory(root)
  }
})

test('history saved before job and operation details stays readable and dismissible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kalamata-history-legacy-'))
  const history = new DownloadHistory(root)
  try {
    const entry = {
      id: 'legacy-job',
      appId: 1,
      title: 'Manifests',
      compact: true,
      status: 'completed',
      transferredBytes: '512',
      error: null,
      finishedAt: 1,
    } as const
    const gameEntry = { ...entry, id: 'legacy-game', compact: false }
    await writeFile(
      join(root, 'activity-history.json'),
      JSON.stringify([entry, gameEntry]),
    )
    await history.initialize()
    expect(history.snapshot()).toEqual([entry, gameEntry])
    await history.dismiss(entry.id)
    await history.dismiss(gameEntry.id)
    const restored = new DownloadHistory(root)
    await restored.initialize()
    expect(restored.snapshot()).toEqual([])
  } finally {
    await history.flush()
    await removeTemporaryDirectory(root)
  }
})

test('Clear all wins over pending writes without stopping new downloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kalamata-history-clear-'))
  const history = new DownloadHistory(root)
  try {
    await history.initialize()
    history.recordOperation(completedOperation(1))
    history.recordOperation(completedOperation(2))
    await history.clear()
    const cleared = new DownloadHistory(root)
    await cleared.initialize()
    expect(cleared.snapshot()).toEqual([])

    history.recordOperation(completedOperation(3))
    await history.flush()
    const restored = new DownloadHistory(root)
    await restored.initialize()
    expect(restored.snapshot().map(({ appId }) => appId)).toEqual([3])
  } finally {
    await history.flush()
    await removeTemporaryDirectory(root)
  }
})

test('damaged cosmetic history does not block new entries; pauses are not finished activities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kalamata-history-damaged-'))
  const errors: Error[] = []
  const history = new DownloadHistory(
    root,
    () => {},
    (error) => errors.push(error),
  )
  try {
    await writeFile(join(root, 'activity-history.json'), '{damaged')
    await history.initialize()
    expect(errors).toHaveLength(1)
    expect(history.snapshot()).toEqual([])
    history.recordOperation({
      event: 'operation.suspended',
      operationId: '1',
      appId: 1,
      kind: 'download',
      phase: 'downloading',
      networkBytes: '3',
      reusedLocalBytes: '0',
      status: 'paused',
    })
    expect(history.snapshot()).toEqual([])
    history.recordOperation({
      event: 'operation.failed',
      operationId: '1',
      appId: 1,
      kind: 'download',
      desiredDepotIds: [1, 2, 3],
      depotCount: 3,
      phase: 'downloading',
      networkBytes: '3',
      reusedLocalBytes: '0',
      error: 'Transfer failed',
    })
    history.recordOperation(completedOperation(1))
    await history.flush()
    const restored = new DownloadHistory(root)
    await restored.initialize()
    expect(restored.snapshot().map(({ status }) => status)).toEqual([
      'completed',
      'failed',
    ])
    expect(restored.snapshot()[1]).toMatchObject({
      operation: 'install',
      depotCount: 3,
      status: 'failed',
    })
  } finally {
    await history.flush()
    await removeTemporaryDirectory(root)
  }
})
