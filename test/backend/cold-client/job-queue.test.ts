import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundDownloadCoordinator } from '../../../src/backend/downloads/background-download-coordinator.ts'
import { ColdClientJobQueue } from '../../../src/backend/cold-client/job-queue.ts'
import { ColdClientMutationMutex } from '../../../src/backend/cold-client/mutation-mutex.ts'
import { ColdClientOperationCoordinator } from '../../../src/backend/cold-client/operation-coordinator.ts'

test('queues per-game work behind downloads and records its phases and result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jobs-'))
  const phases: string[] = []
  const downloads = new BackgroundDownloadCoordinator(root, (snapshot) => {
    const phase = snapshot.jobs.find((job) => job.kind === 'cold-client')?.phase
    if (phase) phases.push(phase)
  })
  const mutex = new ColdClientMutationMutex()
  let jobs!: ColdClientJobQueue
  const operations = new ColdClientOperationCoordinator(mutex, (state) =>
    jobs.onOperationChanged(state),
  )
  jobs = new ColdClientJobQueue(downloads, (appId) => {
    operations.cancel(appId)
  })
  try {
    await downloads.initialize()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => (release = resolve))
    const blocker = downloads.enqueue({
      key: 'manifest:42',
      kind: 'manifest',
      title: 'Manifest',
      run: () => waiting,
    })
    const result = jobs.enqueue('setup', 42, () =>
      operations.run('setup', 42, async (context) => {
        context.setPhase('building')
        context.beginReplacement()
        context.setPhase('validating')
        return { configured: true }
      }),
    )
    expect(jobs.hasPendingForApp(42)).toBe(true)
    expect(downloads.snapshot().jobs.at(-1)).toMatchObject({
      status: 'queued',
      kind: 'cold-client',
      appId: 42,
    })
    expect(() => jobs.enqueue('setup', 42, async () => ({}))).toThrow()
    release()
    await blocker
    expect(await result).toEqual({ configured: true })
    expect(phases).toContain('building')
    expect(phases).toContain('publishing')
    expect(phases).toContain('validating')
    expect(downloads.snapshot().jobs.at(-1)).toMatchObject({
      status: 'completed',
      finishedAt: expect.any(Number),
    })
  } finally {
    await downloads.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
