import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KalamataDatabase } from '../src/db/database.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

let database: KalamataDatabase | undefined
let root: string | undefined

afterEach(async () => {
  database?.close()
  database = undefined
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'kalamata-application-queue-'))
  database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', 'src', 'db', 'migrations'),
  )
  return database
}

test('persists and claims queue items in FIFO order', async () => {
  const db = await setup()
  db.addLibraryEntry(10)
  db.addLibraryEntry(20)
  db.appendApplicationQueueItem({
    id: 'first',
    appId: 10,
    kind: 'download',
    installPath: '/tmp/first',
    depotIds: [101, 102],
    manifestTargets: [{ depotId: 102, manifestId: '123' }],
    createdAt: 1,
  })
  db.appendApplicationQueueItem({
    id: 'second',
    appId: 20,
    kind: 'reconcile',
    installPath: '/tmp/second',
    depotIds: [],
    createdAt: 2,
  })

  expect(db.claimFirstApplicationQueueItem()).toEqual({
    id: 'first',
    appId: 10,
    kind: 'download',
    installPath: '/tmp/first',
    depotIds: [101, 102],
    manifestTargets: [{ depotId: 102, manifestId: '123' }],
    createdAt: 1,
  })
  expect(db.getApplicationQueueItems().map(({ id }) => id)).toEqual(['second'])
})

test('removing a pending first install releases its unused path', async () => {
  const db = await setup()
  const installPath = join(root!, 'install')
  await mkdir(installPath)
  db.addLibraryEntry(10)
  db.appendApplicationQueueItem(
    {
      id: 'first',
      appId: 10,
      kind: 'download',
      installPath,
      depotIds: [101],
      createdAt: 1,
    },
    true,
  )

  expect(db.getLibraryEntry(10)?.installPath).toBe(installPath)
  expect(db.removeApplicationQueueItem('first')?.id).toBe('first')
  expect(db.getLibraryEntry(10)?.installPath).toBeNull()
})

test('claims the first item whose app is not blocked', async () => {
  const db = await setup()
  db.addLibraryEntry(10)
  db.addLibraryEntry(20)
  for (const [id, appId] of [
    ['blocked', 10],
    ['eligible', 20],
  ] as const)
    db.appendApplicationQueueItem({
      id,
      appId,
      kind: 'reconcile',
      installPath: `/tmp/${id}`,
      depotIds: [],
      createdAt: appId,
    })

  expect(db.claimFirstApplicationQueueItem(new Set([10]))?.id).toBe('eligible')
  expect(db.getApplicationQueueItems().map(({ id }) => id)).toEqual(['blocked'])
})

test('prioritizes one item and places displaced work directly behind it', async () => {
  const db = await setup()
  for (const appId of [10, 20, 30]) db.addLibraryEntry(appId)
  for (const [id, appId] of [
    ['first', 10],
    ['selected', 20],
  ] as const)
    db.appendApplicationQueueItem({
      id,
      appId,
      kind: 'reconcile',
      installPath: `/tmp/${id}`,
      depotIds: [],
      createdAt: appId,
    })

  db.prioritizeApplicationQueueItem('selected', {
    id: 'displaced',
    appId: 30,
    kind: 'download',
    installPath: '/tmp/displaced',
    depotIds: [301],
    createdAt: 30,
  })

  expect(db.getApplicationQueueItems().map(({ id }) => id)).toEqual([
    'selected',
    'displaced',
    'first',
  ])
})
