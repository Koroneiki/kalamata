import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApplicationTransactionError,
  archiveUnresolvedApplicationTransaction,
  clearRepairFallback,
  discardPrecommitApplicationTransaction,
  getResumableApplicationTransaction,
  recoverApplicationTransaction,
  runApplicationTransaction,
  type ApplicationTransactionCrashBoundary,
  type DesiredApplicationDepot,
  type InstalledApplicationDepot,
} from '../src/backend/depot/application-transaction.ts'
import { acquireOutputLock } from '../src/backend/depot/depot-config-store.ts'
import { HttpStatusError } from '../src/backend/depot/chunk-download.ts'
import type {
  ChunkClient,
  ContentServer,
} from '../src/backend/depot/content-client.ts'
import type {
  DepotManifest,
  ManifestChunk,
  ManifestFile,
} from '../src/backend/depot/types.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('application filesystem transactions', () => {
  test('failure and cancellation before commit preserve live files', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'game.bin'), 'old')
    const installed = depot(10, '1', { 'game.bin': 'old' })
    const failed = depot(10, '2', { 'game.bin': 'new' }, fakeClient({}))

    await expect(run(directory, [installed], [failed])).rejects.toMatchObject({
      kind: 'transfer-exhausted',
    })
    expect(await text('game.bin')).toBe('old')

    const controller = new AbortController()
    controller.abort()
    await expect(
      run(directory, [installed], [failed], { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'cancellation' })
    expect(await text('game.bin')).toBe('old')
  })

  test('ENOSPC before commit preserves live files', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'game.bin'), 'old')
    const installed = depot(10, '1', { 'game.bin': 'old' })
    const desired = depot(10, '2', { 'game.bin': 'new' }, enospcClient())

    await expect(run(directory, [installed], [desired])).rejects.toMatchObject({
      kind: 'insufficient-space',
    })
    expect(await text('game.bin')).toBe('old')
  })

  test('installs, updates, removes, and preserves unrelated files in one transaction', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'update.bin'), 'old')
    await writeFile(join(directory, 'remove.bin'), 'gone')
    await writeFile(join(directory, 'unrelated.bin'), 'keep')
    const installed = depot(10, '1', {
      'update.bin': 'old',
      'remove.bin': 'gone',
    })
    const desired = depot(10, '2', {
      'update.bin': 'new',
      'install.bin': 'added',
    })

    await run(directory, [installed], [desired])

    expect(await text('update.bin')).toBe('new')
    expect(await text('install.bin')).toBe('added')
    expect(await exists('remove.bin')).toBe(false)
    expect(await text('unrelated.bin')).toBe('keep')
  })

  test('replaces an unrelated regular file at an exact target path', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'occupied.bin'), 'user')
    const desired = depot(10, '1', { 'occupied.bin': 'game' })

    await run(directory, [], [desired])
    expect(await text('occupied.bin')).toBe('game')
  })

  test('installs, updates, and removes different depots in one transaction', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'update.bin'), 'old')
    await writeFile(join(directory, 'remove.bin'), 'gone')
    const outdated = depot(10, '1', { 'update.bin': 'old' })
    const removed = depot(20, '1', { 'remove.bin': 'gone' })
    const updated = depot(10, '2', { 'update.bin': 'new' })
    const installed = depot(30, '1', { 'install.bin': 'added' })

    await run(directory, [outdated, removed], [updated, installed])

    expect(await text('update.bin')).toBe('new')
    expect(await text('install.bin')).toBe('added')
    expect(await exists('remove.bin')).toBe(false)
  })

  test('later mounted depot wins and removing it reveals the earlier owner', async () => {
    directory = await tempDirectory()
    const low = depot(10, '1', { 'shared.bin': 'low' })
    const high = depot(20, '1', { 'shared.bin': 'high' })
    await run(directory, [], [high, low])
    expect(await text('shared.bin')).toBe('low')

    await run(directory, [low, high], [low])
    expect(await text('shared.bin')).toBe('low')
  })

  test('higher depot file overrides a lower directory and removal restores it', async () => {
    directory = await tempDirectory()
    const low = depot(10, '1', { 'tree/leaf.bin': 'low' })
    const high = depot(20, '1', { tree: 'high' })

    await run(directory, [], [low, high])
    expect(await text('tree')).toBe('high')

    await run(directory, [low, high], [low])
    expect(await text('tree/leaf.bin')).toBe('low')
  })

  test('repair handles same-size corruption, missing and wrong type, then no-ops', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'corrupt.bin'), 'BAD!')
    await mkdir(join(directory, 'wrong.bin'))
    const desired = depot(10, '1', {
      'corrupt.bin': 'good',
      'missing.bin': 'new',
      'wrong.bin': 'file',
    })
    const client = desired.client

    await run(directory, [desired], [desired], { kind: 'repair' })
    expect(await text('corrupt.bin')).toBe('good')
    expect(await text('missing.bin')).toBe('new')
    expect(await text('wrong.bin')).toBe('file')
    const calls = (client.downloadChunk as ReturnType<typeof mock>).mock.calls
      .length

    const result = await run(directory, [desired], [desired], {
      kind: 'repair',
    })
    expect(result.transactionId).toBeNull()
    expect(
      (client.downloadChunk as ReturnType<typeof mock>).mock.calls.length,
    ).toBe(calls)
  })

  test('normal updates trust unchanged manifest entries without repairing them', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'game.bin'), 'BAD!')
    const installed = depot(10, '1', { 'game.bin': 'good' })

    const result = await run(directory, [installed], [installed])

    expect(result.transactionId).toBeNull()
    expect(await text('game.bin')).toBe('BAD!')
    expect(installed.client.downloadChunk).not.toHaveBeenCalled()
  })

  test('preserves UserConfig through update, repair, and removal', async () => {
    directory = await tempDirectory()
    const installed = depot(10, '1', { 'settings.cfg': 'default' })
    installed.manifest.files[0]!.flags = 1
    await run(directory, [], [installed])
    await writeFile(join(directory, 'settings.cfg'), 'custom')

    const updated = depot(10, '2', { 'settings.cfg': 'new-default' })
    updated.manifest.files[0]!.flags = 1
    await run(directory, [installed], [updated])
    await run(directory, [updated], [updated], { kind: 'repair' })
    await run(directory, [updated], [])

    expect(await text('settings.cfg')).toBe('custom')
  })

  test('versions VersionedUserConfig and applies winning overlap flags', async () => {
    directory = await tempDirectory()
    const installed = depot(10, '1', { 'settings.cfg': 'default' })
    installed.manifest.files[0]!.flags = 2
    await run(directory, [], [installed])
    await writeFile(join(directory, 'settings.cfg'), 'custom')

    await run(directory, [installed], [installed], { kind: 'repair' })
    expect(await text('settings.cfg')).toBe('custom')

    const updated = depot(10, '2', { 'settings.cfg': 'new-default' })
    updated.manifest.files[0]!.flags = 2
    await run(directory, [installed], [updated])
    expect(await text('settings.cfg')).toBe('new-default')

    const userOwned = depot(10, '3', { 'settings.cfg': 'user-default' })
    userOwned.manifest.files[0]!.flags = 1
    const overriding = depot(20, '1', { 'settings.cfg': 'winner' })
    await run(directory, [updated], [userOwned, overriding])
    expect(await text('settings.cfg')).toBe('winner')

    await run(directory, [userOwned, overriding], [])
    expect(await exists('settings.cfg')).toBe(false)
  })

  test('trusts a valid completion ledger without downloading the staged chunk', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', { 'game.bin': 'good' })
    await writeStagingJournal(desired, 'good')

    await run(directory, [], [desired])

    expect(await text('game.bin')).toBe('good')
    expect(desired.client.downloadChunk).not.toHaveBeenCalled()
  })

  test('discards staging when the completion ledger is not bound to its layout', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', { 'game.bin': 'good' })
    await writeStagingJournal(desired, 'good', 'unknown:4')

    await run(directory, [], [desired])

    expect(await text('game.bin')).toBe('good')
    expect(desired.client.downloadChunk).toHaveBeenCalledTimes(1)
  })

  test('downloads a duplicate chunk once while counting both installed copies', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', {
      'first.bin': 'same',
      'second.bin': 'same',
    })
    const downloadChunk = desired.client.downloadChunk
    desired.client.downloadChunk = mock(
      async (appId, depotId, sha, server, signal, expectedSize) => ({
        ...(await downloadChunk(
          appId,
          depotId,
          sha,
          server,
          signal,
          expectedSize,
        )),
        networkBytes: 2,
      }),
    )
    const progress: Array<{
      actualNetwork: string
      logicalInstalledCompleted: string
    }> = []

    const result = await run(directory, [], [desired], {
      onEvent: (event) => {
        if (event.type === 'progress') progress.push(event)
      },
    })

    expect(result.networkBytes).toBe('2')
    expect(result.logicalInstalledBytes).toBe('8')
    expect(desired.client.downloadChunk).toHaveBeenCalledTimes(1)
    expect(progress.at(-1)).toMatchObject({
      actualNetwork: '2',
      logicalInstalledCompleted: '8',
    })
  })

  test('rotates retryable content failures and stops after untried servers', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', { 'game.bin': 'new' })
    const servers = [{ Host: 'broken' }, { Host: 'working' }]
    desired.client.getContentServers = async () => ({ servers })
    const original = desired.client.downloadChunk
    desired.client.downloadChunk = mock(
      async (appId, depotId, sha, server, signal, expectedSize) => {
        if (server.Host === 'broken') throw new Error('bad response')
        return original(appId, depotId, sha, server, signal, expectedSize)
      },
    )

    await run(directory, [], [desired])
    expect(
      (desired.client.downloadChunk as ReturnType<typeof mock>).mock.calls.map(
        (call) => call[3].Host,
      ),
    ).toEqual(['broken', 'working'])

    await rm(directory, { recursive: true, force: true })
    directory = await tempDirectory()
    const unavailable = depot(10, '1', { 'game.bin': 'new' }, fakeClient({}))
    await expect(run(directory, [], [unavailable])).rejects.toMatchObject({
      kind: 'transfer-exhausted',
    })
    expect(unavailable.client.downloadChunk).toHaveBeenCalledTimes(1)
  })

  test('prefers the least-loaded content server', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', { 'game.bin': 'new' })
    desired.client.getContentServers = async () => ({
      servers: [
        { Host: 'busy', weightedload: 100 },
        { Host: 'available', weightedload: 1 },
      ],
    })

    await run(directory, [], [desired])

    expect(desired.client.downloadChunk).toHaveBeenCalledTimes(1)
    expect(
      (desired.client.downloadChunk as ReturnType<typeof mock>).mock.calls[0]![3]
        .Host,
    ).toBe('available')
  })

  test('cancellation interrupts a stalled content-server request', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', { 'game.bin': 'new' })
    let resolveRequested!: () => void
    const requested = new Promise<void>((resolvePromise) => {
      resolveRequested = resolvePromise
    })
    desired.client.getContentServers = () => {
      resolveRequested()
      return new Promise(() => {})
    }
    const controller = new AbortController()
    const transaction = run(directory, [], [desired], {
      signal: controller.signal,
    })

    await requested
    controller.abort()

    await expect(transaction).rejects.toMatchObject({ kind: 'cancellation' })
  })

  test('rotates after one repeated Retry-After response from a server', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', { 'game.bin': 'new' })
    const servers = [{ Host: 'busy' }, { Host: 'working' }]
    desired.client.getContentServers = async () => ({ servers })
    const original = desired.client.downloadChunk
    desired.client.downloadChunk = mock(
      async (appId, depotId, sha, server, signal, expectedSize) => {
        if (server.Host === 'busy') throw new HttpStatusError(503, 0)
        return original(appId, depotId, sha, server, signal, expectedSize)
      },
    )

    await run(directory, [], [desired])

    expect(
      (desired.client.downloadChunk as ReturnType<typeof mock>).mock.calls.map(
        (call) => call[3].Host,
      ),
    ).toEqual(['busy', 'busy', 'working'])
  })

  for (const boundary of [
    'ready-to-commit',
    'old-moved',
    'some-new-installed',
    'filesystem-committed',
    'sqlite-reconciled',
  ] as ApplicationTransactionCrashBoundary[]) {
    test(`rolls forward after ${boundary}`, async () => {
      directory = await tempDirectory()
      await writeFile(join(directory, 'game.bin'), 'old')
      const old = depot(10, '1', { 'game.bin': 'old' })
      const desired = depot(10, '2', { 'game.bin': 'new' })
      let sqlite = 0

      await expect(
        run(directory, [old], [desired], {
          reconcile: async () => void sqlite++,
          testCrashAt: (at) => {
            if (at === boundary) throw new Error(`crash at ${at}`)
          },
        }),
      ).rejects.toBeInstanceOf(ApplicationTransactionError)

      const callsBeforeRecovery = (
        desired.client.downloadChunk as ReturnType<typeof mock>
      ).mock.calls.length
      await recoverApplicationTransaction(directory, {
        appId: 100,
        reconcile: async () => void sqlite++,
      })
      expect(await text('game.bin')).toBe('new')
      expect(
        (desired.client.downloadChunk as ReturnType<typeof mock>).mock.calls
          .length,
      ).toBe(callsBeforeRecovery)
      expect(sqlite).toBe(1)
      expect(await transactionEntries()).toEqual([])
    })
  }

  test('resumes reconciliation without redownloading and retains backup until it succeeds', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'game.bin'), 'old')
    const old = depot(10, '1', { 'game.bin': 'old' })
    const desired = depot(10, '2', { 'game.bin': 'new' })

    await expect(
      run(directory, [old], [desired], {
        reconcile: async () => {
          throw new Error('database unavailable')
        },
      }),
    ).rejects.toMatchObject({ kind: 'persistence' })
    const calls = (desired.client.downloadChunk as ReturnType<typeof mock>).mock
      .calls.length
    const [transaction] = await transactionEntries()
    expect(
      await exists(
        join('.Kalamata/transactions', transaction!, 'backup/game.bin'),
      ),
    ).toBe(true)

    await recoverApplicationTransaction(directory, {
      appId: 100,
      reconcile: async () => {},
    })
    expect(await text('game.bin')).toBe('new')
    expect(
      (desired.client.downloadChunk as ReturnType<typeof mock>).mock.calls
        .length,
    ).toBe(calls)
    expect(await transactionEntries()).toEqual([])
  })

  test('retains the archived repair target across repeated repair attempts', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'game.bin'), 'old')
    const old = depot(10, '1', { 'game.bin': 'old' })
    const desired = depot(10, '2', { 'game.bin': 'new' })

    await expect(
      run(directory, [old], [desired], {
        testCrashAt: (boundary) => {
          if (boundary === 'ready-to-commit') throw new Error('crash')
        },
      }),
    ).rejects.toBeInstanceOf(ApplicationTransactionError)

    const first = await archiveUnresolvedApplicationTransaction(directory)
    const second = await archiveUnresolvedApplicationTransaction(directory)
    expect(second).toEqual(first)
    expect(second).toEqual([
      expect.objectContaining({ depotId: 10, manifestId: '2', mountIndex: 0 }),
    ])
  })

  test('transaction-tree mutators honor the output lock', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', { 'game.bin': 'good' })
    await writeStagingJournal(desired, 'good')
    await mkdir(join(directory, '.Kalamata/repair-fallback'), {
      recursive: true,
    })
    const release = await acquireOutputLock(directory)

    try {
      await expect(
        archiveUnresolvedApplicationTransaction(directory),
      ).rejects.toThrow('already using')
      await expect(
        discardPrecommitApplicationTransaction(directory),
      ).rejects.toThrow('already using')
      await expect(clearRepairFallback(directory)).rejects.toThrow(
        'already using',
      )
      expect(await transactionEntries()).toEqual(['resume-test'])
      expect(await exists('.Kalamata/repair-fallback')).toBe(true)
    } finally {
      await release()
    }
  })

  test('malformed recovery journal leaves live files and backups untouched', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'game.bin'), 'live')
    const root = join(directory, '.Kalamata/transactions/bad')
    await mkdir(join(root, 'backup'), { recursive: true })
    await writeFile(join(root, 'backup/game.bin'), 'backup')
    await writeFile(join(root, 'journal.json'), '{broken')

    await expect(
      recoverApplicationTransaction(directory, {
        appId: 100,
        reconcile: async () => {},
      }),
    ).rejects.toMatchObject({ kind: 'recovery' })
    expect(await text('game.bin')).toBe('live')
    expect(
      await text('.Kalamata/transactions/bad/backup/game.bin'),
    ).toBe('backup')
  })

  test('recovery removes completed transaction leftovers', async () => {
    directory = await tempDirectory()
    await writeFile(join(directory, 'game.bin'), 'live')
    for (const [id, phase] of [['completed', 'completed']] as const) {
      const root = join(directory, '.Kalamata/transactions', id)
      await mkdir(join(root, 'staging'), { recursive: true })
      await writeFile(join(root, 'staging/residue'), 'temporary')
      await writeFile(
        join(root, 'journal.json'),
        JSON.stringify({
          version: 2,
          id,
          generation: 'generation',
          appId: 100,
          kind: 'reconcile',
          installPath: directory,
          phase,
          paused: false,
          source: [],
          desired: [],
          stagedFiles: [],
          completedChunks: {},
          logicalInstalledTotal: '0',
          retainedBytes: '0',
          oldMoves: [],
          installs: [],
          obsoleteDirectories: [],
        }),
      )
    }

    await recoverApplicationTransaction(directory, {
      appId: 100,
      reconcile: async () => {},
    })

    expect(await text('game.bin')).toBe('live')
    expect(await transactionEntries()).toEqual([])
  })

  test('rejects journals belonging to another app or install path', async () => {
    directory = await tempDirectory()
    const desired = depot(10, '1', { 'game.bin': 'good' })
    await writeStagingJournal(desired, 'good')

    await expect(
      getResumableApplicationTransaction(directory, 101),
    ).rejects.toMatchObject({ kind: 'recovery' })
    await expect(
      recoverApplicationTransaction(directory, {
        appId: 101,
        reconcile: async () => {},
      }),
    ).rejects.toMatchObject({ kind: 'recovery' })

    const journalPath = join(
      directory,
      '.Kalamata/transactions/resume-test/journal.json',
    )
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.appId = 100
    journal.installPath = `${directory}-other`
    await writeFile(journalPath, JSON.stringify(journal))

    await expect(
      getResumableApplicationTransaction(directory, 100),
    ).rejects.toMatchObject({ kind: 'recovery' })
  })
})

function run(
  outputDirectory: string,
  installedDepots: InstalledApplicationDepot[],
  desiredDepots: DesiredApplicationDepot[],
  overrides: Partial<Parameters<typeof runApplicationTransaction>[0]> = {},
) {
  return runApplicationTransaction({
    appId: 100,
    kind: 'reconcile',
    outputDirectory,
    installedDepots,
    desiredDepots,
    reconcile: async () => {},
    ...overrides,
  })
}

function depot(
  depotId: number,
  manifestId: string,
  files: Record<string, string>,
  client = fakeClient(files),
): DesiredApplicationDepot {
  return {
    depotId,
    appId: 100,
    ownerAppId: 100,
    manifest: manifest(depotId, manifestId, files),
    client,
  }
}

function manifest(
  depotId: number,
  manifestId: string,
  files: Record<string, string>,
): DepotManifest {
  const entries = Object.entries(files).map(([filename, value]) =>
    manifestFile(filename, value),
  )
  const size = entries.reduce((sum, file) => sum + Number(file.size), 0)
  return {
    depot_id: depotId,
    gid_manifest: manifestId,
    filenames_encrypted: false,
    cb_disk_original: String(size),
    cb_disk_compressed: String(size),
    files: entries,
  }
}

function manifestFile(filename: string, value: string): ManifestFile {
  const data = Buffer.from(value)
  const item = chunk(createHash('sha1').update(data).digest('hex'), 0, data)
  return {
    filename,
    size: String(data.length),
    flags: 0,
    sha_content: createHash('sha1').update(data).digest('hex'),
    chunks: data.length === 0 ? [] : [item],
  }
}

function chunk(sha: string, offset: number, value: Buffer): ManifestChunk {
  return {
    sha,
    offset: String(offset),
    cb_original: value.length,
    cb_compressed: value.length,
    crc: adler(value),
  }
}

function fakeClient(files: Record<string, string>): ChunkClient {
  const chunks = new Map(
    Object.values(files).map((value) => {
      const data = Buffer.from(value)
      return [createHash('sha1').update(data).digest('hex'), data]
    }),
  )
  const server: ContentServer = { Host: 'cdn.test' }
  return {
    getContentServers: async () => ({ servers: [server] }),
    downloadChunk: mock(async (_appId, _depotId, sha) => {
      const data = chunks.get(sha)
      if (!data) throw new Error(`missing ${sha}`)
      return { chunk: data }
    }),
  }
}

function enospcClient(): ChunkClient {
  const server: ContentServer = { Host: 'cdn.test' }
  return {
    getContentServers: async () => ({ servers: [server] }),
    downloadChunk: mock(async () => {
      const error = new Error('disk full') as NodeJS.ErrnoException
      error.code = 'ENOSPC'
      throw error
    }),
  }
}

function adler(value: Buffer): number {
  let a = 0
  let b = 0
  for (const byte of value) {
    a = (a + byte) % 65_521
    b = (b + a) % 65_521
  }
  return (a | (b << 16)) >>> 0
}

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'application-transaction-'))
}

async function text(path: string): Promise<string> {
  return readFile(join(directory!, path), 'utf8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(join(directory!, path))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function transactionEntries(): Promise<string[]> {
  try {
    return await readdir(join(directory!, '.Kalamata/transactions'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeStagingJournal(
  desired: DesiredApplicationDepot,
  contents: string,
  completionKey?: string,
): Promise<void> {
  const id = 'resume-test'
  const root = join(directory!, '.Kalamata/transactions', id)
  const staging = join(root, 'staging')
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'game.bin'), contents)
  const file = desired.manifest.files[0]!
  const chunk = file.chunks[0]!
  const key = `${chunk.sha.toLowerCase()}:${chunk.cb_original}`
  await writeFile(
    join(root, 'journal.json'),
    JSON.stringify({
      version: 2,
      id,
      generation: 'generation',
      appId: 100,
      kind: 'reconcile',
      installPath: directory,
      phase: 'staging',
      paused: true,
      source: [],
      desired: [
        {
          depotId: desired.depotId,
          manifestId: desired.manifest.gid_manifest,
          mountIndex: 0,
          ownerAppId: desired.ownerAppId,
        },
      ],
      stagedFiles: [
        {
          path: 'game.bin',
          size: file.size,
          sha1: file.sha_content,
          chunks: [
            {
              key,
              offset: chunk.offset,
              size: chunk.cb_original,
            },
          ],
        },
      ],
      completedChunks: {
        [completionKey ?? key]: { source: 'network', networkBytes: '3' },
      },
      logicalInstalledTotal: file.size,
      retainedBytes: '0',
      oldMoves: [],
      installs: [],
      obsoleteDirectories: [],
    }),
  )
}
