import { afterEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acquireOutputLock,
  DepotConfigStore,
} from '../src/backend/depot/depot-config-store.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

test('persists readable manifest state including the incomplete marker', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-config-'))
  const store = await DepotConfigStore.load(directory)

  await store.setInstalledManifestId(20, null)
  expect(store.getInstalledManifestId(20)).toBeUndefined()
  await store.setInstalledManifestId(20, '12345678901234567890')

  const reloaded = await DepotConfigStore.load(directory)
  expect(reloaded.getInstalledManifestId(20)).toBe('12345678901234567890')
  expect(
    JSON.parse(
      await readFile(
        join(directory, '.Kalamata/depot.config.json'),
        'utf8',
      ),
    ),
  ).toEqual({
    version: 1,
    installedManifestIds: { '20': '12345678901234567890' },
  })
})

test('prevents concurrent downloads in one output directory', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-config-'))
  const release = await acquireOutputLock(directory)
  try {
    await expect(acquireOutputLock(directory)).rejects.toThrow('already using')
  } finally {
    await release()
  }
  const releaseAgain = await acquireOutputLock(directory)
  await releaseAgain()
})

test('rejects malformed manifest ID maps', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-config-'))
  const configDirectory = join(directory, '.Kalamata')
  await mkdir(configDirectory)
  await writeFile(
    join(configDirectory, 'depot.config.json'),
    JSON.stringify({
      version: 1,
      installedManifestIds: [],
    }),
  )

  await expect(DepotConfigStore.load(directory)).rejects.toThrow(
    'Invalid depot config',
  )
})

test('reuses an unlocked lock database without admitting two owners', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-config-'))
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

test('rejects symlinked transaction state and lock paths', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-config-'))
  const configDirectory = join(directory, '.Kalamata')
  const outside = join(directory, 'outside')
  await mkdir(configDirectory)
  await mkdir(outside)

  for (const name of ['transactions', 'repair-fallback', 'download.lock']) {
    const path = join(configDirectory, name)
    await symlink(outside, path)
    await expect(acquireOutputLock(directory)).rejects.toThrow('symbolic link')
    await rm(path)
  }
})
