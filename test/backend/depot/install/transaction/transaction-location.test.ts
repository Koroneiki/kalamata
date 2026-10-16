import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installStateDirectory } from '../../../../../src/backend/depot/install/internal-paths.ts'
import {
  getResumableApplicationTransaction,
  hasRepairFallback,
  recoverApplicationTransaction,
} from '../../../../../src/backend/depot/install/transaction/recovery.ts'
import { moveTemporaryPath } from '../../../../../src/backend/depot/install/transaction/move-path.ts'
import type { ApplicationTransactionCrashBoundary } from '../../../../../src/backend/depot/install/transaction/types.ts'
import { depot, run } from './transaction-fixtures.ts'

const nativeRename = fs.rename
let root: string | undefined
let restoreRename: (() => void) | undefined

afterEach(async () => {
  restoreRename?.()
  restoreRename = undefined
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = undefined
})

async function fixture() {
  root = await fs.mkdtemp(join(tmpdir(), 'kalamata-install-state-'))
  const game = join(root, 'game')
  const dataRoot = join(root, 'appdata')
  await fs.mkdir(game)
  return { game, dataRoot, state: installStateDirectory(dataRoot, game) }
}

function crossVolume(game: string, dataRoot: string) {
  // Exercise EXDEV without requiring a mounted second volume on every test host.
  const rename = spyOn(fs, 'rename').mockImplementation(
    async (source, destination) => {
      const fromGame = String(source).startsWith(`${game}/`)
      const toData = String(destination).startsWith(`${dataRoot}/`)
      const fromData = String(source).startsWith(`${dataRoot}/`)
      const toGame = String(destination).startsWith(`${game}/`)
      if ((fromGame && toData) || (fromData && toGame))
        throw Object.assign(new Error('different volumes'), { code: 'EXDEV' })
      await nativeRename(source, destination)
    },
  )
  restoreRename = () => rename.mockRestore()
}

test('ignores legacy state without reading, migrating, or deleting it', async () => {
  const { game, dataRoot, state } = await fixture()
  const legacy = join(game, '.Kalamata')
  const evidence = {
    'transactions/broken/journal.json': '{broken',
    'transactions/broken/commit-ready': '',
    'transactions/broken/backup/game.bin': 'old backup',
    'repair-fallback/evidence/journal.json': '{broken',
    'coldclient-replacement.json': '{broken',
    'download.lock': 'not a database',
  }
  for (const [path, contents] of Object.entries(evidence)) {
    const destination = join(legacy, path)
    await fs.mkdir(join(destination, '..'), { recursive: true })
    await fs.writeFile(destination, contents)
  }

  expect(
    await getResumableApplicationTransaction(game, 100, dataRoot),
  ).toBeNull()
  expect(await hasRepairFallback(game, dataRoot)).toBe(false)
  await recoverApplicationTransaction(game, {
    dataRoot,
    appId: 100,
    reconcile: async () => {},
  })
  await run(game, [], [depot(10, '1', { 'game.bin': 'new' })], { dataRoot })

  expect(await fs.readFile(join(game, 'game.bin'), 'utf8')).toBe('new')
  expect(await fs.readdir(join(state, 'transactions'))).toEqual([])
  for (const [path, contents] of Object.entries(evidence))
    expect(await fs.readFile(join(legacy, path), 'utf8')).toBe(contents)
})

test('pauses and resumes staged bytes in appdata without creating game-side state', async () => {
  const { game, dataRoot, state } = await fixture()
  const desired = depot(10, '1', { 'game.bin': 'new' })
  const controller = new AbortController()
  await expect(
    run(game, [], [desired], {
      dataRoot,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'phase' && event.phase === 'verifying')
          controller.abort(
            Object.assign(new Error('pause'), { name: 'PauseError' }),
          )
      },
    }),
  ).rejects.toMatchObject({ kind: 'cancellation' })

  expect(await fs.readdir(game)).toEqual([])
  expect(
    await getResumableApplicationTransaction(game, 100, dataRoot),
  ).toMatchObject({ paused: true, installedBytesCompleted: '3' })
  const [id] = await fs.readdir(join(state, 'transactions'))
  expect(
    await fs.readFile(
      join(state, 'transactions', id!, 'staging/game.bin'),
      'utf8',
    ),
  ).toBe('new')
  await run(game, [], [desired], { dataRoot })
  expect(await fs.readdir(game)).toEqual(['game.bin'])
  expect(await fs.readFile(join(game, 'game.bin'), 'utf8')).toBe('new')
})

test('cross-volume commits support removals and file/directory replacements', async () => {
  const { game, dataRoot } = await fixture()
  crossVolume(game, dataRoot)
  await fs.mkdir(join(game, 'tree'))
  await fs.writeFile(join(game, 'tree/leaf.bin'), 'leaf')
  await fs.writeFile(join(game, 'file'), 'old file')
  await fs.writeFile(join(game, 'remove.bin'), 'gone')
  const installed = depot(10, '1', {
    'tree/leaf.bin': 'leaf',
    file: 'old file',
    'remove.bin': 'gone',
  })
  const desired = depot(10, '2', {
    tree: 'new file',
    'file/nested.bin': 'nested',
  })

  await run(game, [installed], [desired], { dataRoot })

  expect((await fs.readdir(game)).sort()).toEqual(['file', 'tree'])
  expect(await fs.readFile(join(game, 'tree'), 'utf8')).toBe('new file')
  expect(await fs.readFile(join(game, 'file/nested.bin'), 'utf8')).toBe(
    'nested',
  )
})

for (const boundary of [
  'backup-copied',
  'backup-published',
  'old-moved',
  'new-copied',
  'new-published',
  'some-new-installed',
] satisfies ApplicationTransactionCrashBoundary[]) {
  test(`cross-volume recovery after ${boundary} preserves backups and publishes complete files`, async () => {
    const { game, dataRoot, state } = await fixture()
    crossVolume(game, dataRoot)
    await fs.writeFile(join(game, 'game.bin'), 'old')
    const installed = depot(10, '1', { 'game.bin': 'old' })
    const desired = depot(10, '2', { 'game.bin': 'new' })
    desired.manifest.files[0]!.flags = 32
    await expect(
      run(game, [installed], [desired], {
        dataRoot,
        testCrashAt: (at) => {
          if (at === boundary) throw new Error('process crash')
        },
      }),
    ).rejects.toThrow()
    const [id] = await fs.readdir(join(state, 'transactions'))
    const backup = join(state, 'transactions', id!, 'backup/game.bin')
    if (boundary === 'backup-copied' || boundary === 'backup-published')
      expect(await fs.readFile(join(game, 'game.bin'), 'utf8')).toBe('old')
    if (boundary !== 'backup-copied')
      expect(await fs.readFile(backup, 'utf8')).toBe('old')
    if (boundary === 'backup-copied' || boundary === 'new-copied') {
      const destination =
        boundary === 'backup-copied' ? backup : join(game, 'game.bin')
      await fs.writeFile(moveTemporaryPath(destination, id!), 'partial copy')
    }

    let reconciled = false
    await recoverApplicationTransaction(game, {
      dataRoot,
      appId: 100,
      reconcile: async () => {
        expect(await fs.readFile(backup, 'utf8')).toBe('old')
        reconciled = true
      },
    })

    expect(reconciled).toBe(true)
    expect(await fs.readFile(join(game, 'game.bin'), 'utf8')).toBe('new')
    if (process.platform !== 'win32')
      expect((await fs.stat(join(game, 'game.bin'))).mode & 0o111).toBe(0o111)
    expect(await fs.readdir(game)).toEqual(['game.bin'])
    expect(await fs.readdir(join(state, 'transactions'))).toEqual([])
  })
}
