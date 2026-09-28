import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SteamService } from '../src/backend/index.ts'
import { BackgroundDownloadCoordinator } from '../src/backend/downloads/background-download-coordinator.ts'
import { KalamataDatabase } from '../src/db/database.ts'

test('concurrent depot-key requests retain each caller’s depot order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steam-depot-keys-'))
  const database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  const jobs = new BackgroundDownloadCoordinator(root, () => {})
  const steam = new SteamService(undefined, jobs)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => (release = resolve))
  try {
    await jobs.initialize()
    database.setDepotKey(10, 'a'.repeat(64))
    database.setDepotKey(11, 'b'.repeat(64))
    const preceding = jobs.enqueue({
      key: 'preceding',
      kind: 'depot-keys',
      title: 'Preceding job',
      run: () => blocked,
    })
    const first = steam.acquireDepotKeys(database, {
      appId: 100,
      depotIds: [10, 11],
    })
    const second = steam.acquireDepotKeys(database, {
      appId: 100,
      depotIds: [11, 10],
    })
    release()
    await preceding
    expect((await first).acquiredDepotIds).toEqual([10, 11])
    expect((await second).acquiredDepotIds).toEqual([11, 10])
  } finally {
    release()
    await jobs.shutdown()
    steam.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})
