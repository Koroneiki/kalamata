import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installStateDirectory } from '../src/backend/depot/install/internal-paths.ts'
import {
  acquireOutputLock,
  OutputLockBusyError,
} from '../src/backend/depot/install/output-lock.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory)
  directory = undefined
})

test('prevents concurrent access and permits reacquisition after release', async () => {
  directory = await mkdtemp(join(tmpdir(), 'output-lock-'))
  const release = await acquireOutputLock(directory, directory)
  try {
    await expect(
      acquireOutputLock(directory, directory),
    ).rejects.toBeInstanceOf(OutputLockBusyError)
  } finally {
    await release()
  }

  const releaseAgain = await acquireOutputLock(directory, directory)
  await releaseAgain()
})

test('reuses an unlocked lock database without admitting two owners', async () => {
  directory = await mkdtemp(join(tmpdir(), 'output-lock-'))
  const initialRelease = await acquireOutputLock(directory, directory)
  await initialRelease()

  const attempts = await Promise.allSettled([
    acquireOutputLock(directory, directory),
    acquireOutputLock(directory, directory),
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

test('does not report a corrupt lock database as contention', async () => {
  directory = await mkdtemp(join(tmpdir(), 'output-lock-'))
  const configDirectory = installStateDirectory(directory, directory)
  await mkdir(configDirectory, { recursive: true })
  await writeFile(join(configDirectory, 'download.lock'), 'not a database')

  const error = await acquireOutputLock(directory, directory).catch(
    (cause) => cause,
  )

  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(OutputLockBusyError)
})

test('rejects symlinked transaction, repair-fallback, and lock paths', async () => {
  directory = await mkdtemp(join(tmpdir(), 'output-lock-'))
  const configDirectory = installStateDirectory(directory, directory)
  const outside = join(directory, 'outside')
  await mkdir(configDirectory, { recursive: true })
  await mkdir(outside)

  for (const name of ['transactions', 'repair-fallback', 'download.lock']) {
    const path = join(configDirectory, name)
    await symlink(outside, path)
    await expect(acquireOutputLock(directory, directory)).rejects.toThrow(
      'symbolic link',
    )
    await unlink(path)
  }
})
