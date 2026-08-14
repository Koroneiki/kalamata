import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Diagnostics } from '../src/bun/diagnostics.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

test('appends structured diagnostic events and errors', async () => {
  directory = await mkdtemp(join(tmpdir(), 'kalamata-diagnostics-'))
  const diagnostics = new Diagnostics(directory)

  diagnostics.info({
    event: 'app.started',
    version: '1.2.3',
    platform: 'darwin',
    architecture: 'arm64',
  })
  diagnostics.error({
    event: 'operation.failed',
    error: new Error('network unavailable'),
    appId: 440,
    kind: 'download',
  })

  const lines = (await readFile(diagnostics.path, 'utf8')).trim().split('\n')
  expect(lines.map((line) => JSON.parse(line))).toMatchObject([
    { level: 'info', event: 'app.started', version: '1.2.3' },
    {
      level: 'error',
      event: 'operation.failed',
      appId: 440,
      error: { name: 'Error', message: 'network unavailable' },
    },
  ])
})

test('does not throw when an error has a cyclic cause', async () => {
  directory = await mkdtemp(join(tmpdir(), 'kalamata-diagnostics-'))
  const diagnostics = new Diagnostics(directory)
  const error = new Error('cyclic')
  error.cause = error

  expect(() =>
    diagnostics.error({ event: 'app.shutdown-failed', error }),
  ).not.toThrow()
  const logged = JSON.parse(await readFile(diagnostics.path, 'utf8'))
  expect(logged.error.cause).toEqual({
    name: 'Error',
    message: 'Circular error cause omitted',
  })
})

test('rotates a one MiB log and keeps one archive', async () => {
  directory = await mkdtemp(join(tmpdir(), 'kalamata-diagnostics-'))
  const diagnostics = new Diagnostics(directory)
  const archivePath = join(directory, 'kalamata.old.log')
  await writeFile(diagnostics.path, Buffer.alloc(1024 * 1024, 'a'))
  await writeFile(archivePath, 'stale archive')

  diagnostics.info({ event: 'app.ready' })

  expect((await stat(archivePath)).size).toBe(1024 * 1024)
  expect(JSON.parse(await readFile(diagnostics.path, 'utf8'))).toMatchObject({
    level: 'info',
    event: 'app.ready',
  })
})
