import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireOutputLock } from '../src/backend/depot/install/output-lock.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory)
  directory = undefined
})

test('prevents concurrent access and permits reacquisition after release', async () => {
  directory = await mkdtemp(join(tmpdir(), 'output-lock-'))
  const release = await acquireOutputLock(directory)
  try {
    await expect(acquireOutputLock(directory)).rejects.toThrow('already using')
  } finally {
    await release()
  }

  const releaseAgain = await acquireOutputLock(directory)
  await releaseAgain()
})

test('reuses an unlocked lock database without admitting two owners', async () => {
  directory = await mkdtemp(join(tmpdir(), 'output-lock-'))
  const initialRelease = await acquireOutputLock(directory)
  await initialRelease()

  const attempts = await Promise.allSettled([
    acquireOutputLock(directory),
    acquireOutputLock(directory),
  ])

  expect(
    attempts.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1)
  expect(
    attempts.filter((result) => result.status === 'rejected'),
  ).toHaveLength(1)
  const acquired = attempts.find((result) => result.status === 'fulfilled')
  if (acquired?.status === 'fulfilled') await acquired.value()
})

test('rejects symlinked transaction, repair-fallback, and lock paths', async () => {
  directory = await mkdtemp(join(tmpdir(), 'output-lock-'))
  const configDirectory = join(directory, '.Kalamata')
  const outside = join(directory, 'outside')
  await mkdir(configDirectory)
  await mkdir(outside)

  for (const name of ['transactions', 'repair-fallback', 'download.lock']) {
    const path = join(configDirectory, name)
    await symlink(outside, path)
    await expect(acquireOutputLock(directory)).rejects.toThrow('symbolic link')
    await unlink(path)
  }
})
