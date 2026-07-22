import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acquireOutputLock,
  DepotConfigStore,
} from '../src/backend/depot-config-store.ts'

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
        join(directory, '.DepotDownloader/depot.config.json'),
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
  const configDirectory = join(directory, '.DepotDownloader')
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

test('does not automatically remove a stale lock', async () => {
  directory = await mkdtemp(join(tmpdir(), 'depot-config-'))
  const lockDirectory = join(directory, '.DepotDownloader', 'download.lock')
  await mkdir(lockDirectory, { recursive: true })
  await writeFile(
    join(lockDirectory, 'owner.json'),
    JSON.stringify({ id: 'stale', pid: 2_147_483_647 }),
  )

  const attempts = await Promise.allSettled([
    acquireOutputLock(directory),
    acquireOutputLock(directory),
  ])

  expect(attempts.every((result) => result.status === 'rejected')).toBe(true)
  expect(await Bun.file(join(lockDirectory, 'owner.json')).exists()).toBe(true)
})
