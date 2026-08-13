import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readJournal,
  writeJournal,
} from '../../../../../src/backend/depot/install/transaction/journal.ts'
import type { TransactionJournal } from '../../../../../src/backend/depot/install/transaction/types.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

test('parses and normalizes a valid transaction journal', async () => {
  const path = await writeTestJournal(validJournal())

  const journal = await readJournal(path)

  expect(journal.source[0]?.pinned).toBe(false)
  expect(journal.desired[0]?.pinned).toBe(false)
})

test('atomically writes a transaction journal', async () => {
  directory = await mkdtemp(join(tmpdir(), 'transaction-journal-'))
  const path = join(directory, 'nested', 'journal.json')

  await writeJournal(path, validJournal())

  expect(await readJournal(path)).toMatchObject(validJournal())
})

test('rejects a structurally unsafe transaction journal', async () => {
  const journal = {
    ...validJournal(),
    obsoleteDirectories: ['../outside'],
  }
  const path = await writeTestJournal(journal)

  await expect(readJournal(path)).rejects.toMatchObject({
    kind: 'recovery',
    message: `Malformed journal ${path}`,
  })
})

test('rejects depot records that cannot be reconciled', async () => {
  const journal = validJournal()
  journal.desired = [
    { depotId: 10, manifestId: '20', mountIndex: 0 },
    { depotId: 11, manifestId: '21', mountIndex: 0 },
  ]
  const path = await writeTestJournal(journal)

  await expect(readJournal(path)).rejects.toMatchObject({
    kind: 'recovery',
    message: `Malformed journal ${path}`,
  })
})

test('rejects incomplete file install actions before recovery', async () => {
  const journal = {
    ...validJournal(),
    phase: 'ready',
    installs: [{ path: 'game.bin', directory: false }],
  }
  const path = await writeTestJournal(journal)

  await expect(readJournal(path)).rejects.toMatchObject({
    kind: 'recovery',
    message: `Malformed journal ${path}`,
  })
})

function validJournal(): TransactionJournal {
  const depot = { depotId: 10, manifestId: '20', mountIndex: 0 }
  return {
    version: 2,
    id: 'transaction',
    generation: 'generation',
    appId: 30,
    kind: 'download',
    installPath: '/install',
    paused: false,
    phase: 'staging',
    source: [depot],
    desired: [depot],
    stagedFiles: [],
    completedChunks: {},
    logicalInstalledTotal: '0',
    retainedBytes: '0',
    oldMoves: [],
    installs: [],
    obsoleteDirectories: [],
  }
}

async function writeTestJournal(journal: unknown) {
  directory = await mkdtemp(join(tmpdir(), 'transaction-journal-'))
  const path = join(directory, 'journal.json')
  await writeFile(path, JSON.stringify(journal))
  return path
}
