import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { HubcapArchive } from '../src/backend/depot/keys/hubcap-archive.ts'

const require = createRequire(import.meta.url)
// SAFETY: adm-zip exports the constructor used to build this in-memory fixture.
const AdmZip = require('adm-zip') as new () => {
  addFile(name: string, contents: Buffer): void
  toBuffer(): Buffer
}

test('retains only the latest completed ZIP for the next acquisition', async () => {
  const zip = new AdmZip()
  zip.addFile('100.lua', Buffer.from(''))
  const calls: string[] = []
  const archive = new HubcapArchive(async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/user/stats'))
      return Response.json({
        daily_usage: 1,
        daily_limit: 100,
        can_make_requests: true,
      })
    return new Response(Uint8Array.from(zip.toBuffer()).buffer)
  })
  const usage = {
    dailyUsage: 0,
    dailyLimit: 100,
    remaining: 100,
    canMakeRequests: true,
  }
  const signal = new AbortController().signal

  await archive.get(100, 'secret', usage, signal)
  expect(archive.has(100, 'secret')).toBe(true)
  await archive.get(101, 'secret', usage, signal)
  expect(archive.has(100, 'secret')).toBe(false)
  expect(archive.has(101, 'secret')).toBe(true)
  await archive.get(101, 'secret', undefined, signal)
  expect(
    calls.filter((url) => url.endsWith('/api/v1/manifest/101')),
  ).toHaveLength(1)
  await archive.shutdown()
})
