import { afterEach, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundDownloadCoordinator } from '../../src/backend/downloads/background-download-coordinator.ts'
import { ApplicationUpdatePreparer } from '../../src/bun/application-update.ts'
import { removeTemporaryDirectory } from '../helpers/filesystem.ts'

let root: string | undefined
afterEach(async () => {
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

async function jobs() {
  root = await mkdtemp(join(tmpdir(), 'application-update-'))
  const coordinator = new BackgroundDownloadCoordinator(root, () => {})
  await coordinator.initialize()
  return coordinator
}

test('stages an update in a job and enables install only after it is ready', async () => {
  const coordinator = await jobs()
  let finish!: () => void
  const downloading = new Promise<void>((resolve) => {
    finish = resolve
  })
  const preparer = new ApplicationUpdatePreparer(
    '1.0.5',
    {
      check: async () => ({ updateAvailable: true, version: '1.0.6' }),
      download: () => downloading,
      info: () => ({ updateReady: true }),
    },
    coordinator,
    () => {},
    () => false,
  )

  const stage = preparer.checkAndStage()
  expect(preparer.status()).toMatchObject({ checking: true, ready: false })
  expect(coordinator.snapshot().jobs).toHaveLength(0)
  await Promise.resolve()
  expect(coordinator.snapshot().jobs[0]).toMatchObject({
    kind: 'application-update',
  })
  expect(preparer.status()).toMatchObject({
    availableVersion: '1.0.6',
    ready: false,
  })
  finish()
  await stage
  expect(preparer.status()).toMatchObject({
    ready: true,
    checking: false,
    error: null,
  })
  expect(coordinator.snapshot().jobs[0]?.status).toBe('completed')
  await preparer.checkAndStage()
  expect(coordinator.snapshot().jobs).toHaveLength(1)
  await coordinator.shutdown()
})

test('a download without a prepared update fails the job and remains retryable', async () => {
  const coordinator = await jobs()
  let prepared = false
  const preparer = new ApplicationUpdatePreparer(
    '1.0.5',
    {
      check: async () => ({ updateAvailable: true, version: '1.0.6' }),
      download: async () => {},
      info: () => ({ updateReady: prepared }),
    },
    coordinator,
    () => {},
    () => false,
  )

  await preparer.checkAndStage()
  expect(preparer.status()).toMatchObject({
    ready: false,
    error: 'The update could not be prepared',
  })
  expect(coordinator.snapshot().jobs[0]?.status).toBe('failed')
  prepared = true
  await preparer.checkAndStage()
  expect(preparer.status()).toMatchObject({ ready: true, error: null })
  expect(coordinator.snapshot().jobs.at(-1)?.status).toBe('completed')
  await coordinator.shutdown()
})
