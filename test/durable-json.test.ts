import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDurableJson } from '../src/backend/filesystem/durable-json.ts'
import { removeTemporaryDirectory } from './helpers/filesystem.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory)
  directory = undefined
})

test('atomically replaces JSON without leaving temporary files', async () => {
  directory = await mkdtemp(join(tmpdir(), 'durable-json-'))
  const path = join(directory, 'nested', 'state.json')

  await writeDurableJson(path, { version: 1 })
  await writeDurableJson(path, { version: 2 })

  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 2 })
  expect(await readdir(join(directory, 'nested'))).toEqual(['state.json'])
})
