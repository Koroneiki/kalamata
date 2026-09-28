import { expect, test } from 'bun:test'
import { createCipheriv, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { verifyDepotKey } from '../src/backend/depot/keys/verify-depot-key.ts'
import type { SteamSession } from '../src/backend/steam/steam-session.ts'

const require = createRequire(import.meta.url)

test('verifies a key through another content server when the first fails', async () => {
  const key = Buffer.alloc(32, 0x42)
  const contents = Buffer.from('depot key probe')
  const sha = createHash('sha1').update(contents).digest('hex')
  const zip = new (require('adm-zip') as new () => {
    addFile(name: string, data: Buffer): void
    toBuffer(): Buffer
  })()
  zip.addFile('chunk', contents)
  const iv = Buffer.alloc(16, 0x24)
  const ivCipher = createCipheriv('aes-256-ecb', key, null)
  ivCipher.setAutoPadding(false)
  const dataCipher = createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([
    ivCipher.update(iv),
    ivCipher.final(),
    dataCipher.update(zip.toBuffer()),
    dataCipher.final(),
  ])

  const schema = require('steam-user/protobufs/generated/_load.js') as {
    ContentManifestPayload: { encode(value: unknown): { finish(): Uint8Array } }
    ContentManifestMetadata: {
      encode(value: unknown): { finish(): Uint8Array }
    }
  }
  const payload = schema.ContentManifestPayload.encode({
    mappings: [
      {
        filename: 'file.bin',
        size: String(contents.length),
        flags: 0,
        sha_content: Buffer.from(sha, 'hex'),
        chunks: [
          {
            sha: Buffer.from(sha, 'hex'),
            crc: 1,
            offset: '0',
            cb_original: contents.length,
            cb_compressed: encrypted.length,
          },
        ],
      },
    ],
  }).finish()
  const metadata = schema.ContentManifestMetadata.encode({
    depot_id: 20,
    gid_manifest: '123',
    filenames_encrypted: false,
    cb_disk_original: String(contents.length),
    cb_disk_compressed: String(encrypted.length),
  }).finish()
  const section = (magic: number, data: Uint8Array) => {
    const header = Buffer.alloc(8)
    header.writeUint32LE(magic, 0)
    header.writeUint32LE(data.length, 4)
    return Buffer.concat([header, data])
  }
  const manifest = Buffer.concat([
    section(0x71f617d0, payload),
    section(0x1f4812be, metadata),
    Buffer.from([0xab, 0x15, 0xc4, 0x32]),
  ])

  const hosts: string[] = []
  const server = createServer((request, response) => {
    hosts.push(request.headers.host ?? '')
    if (request.headers.host === 'broken.example') {
      response.writeHead(503)
      response.end()
    } else {
      response.writeHead(200)
      response.end(encrypted)
    }
  })
  try {
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP content server')
    const session = {
      getClient: async () => ({
        getContentServers: async () => ({
          servers: [
            {
              Host: `127.0.0.1:${address.port}`,
              vhost: 'broken.example',
              weightedload: 1,
            },
            {
              Host: `127.0.0.1:${address.port}`,
              vhost: 'working.example',
              weightedload: 2,
            },
          ],
        }),
      }),
    } as unknown as Pick<SteamSession, 'getClient'>

    expect(
      await verifyDepotKey(
        session,
        10,
        20,
        '123',
        manifest,
        key,
        new AbortController().signal,
      ),
    ).toBe(true)
    expect(hosts).toEqual(['broken.example', 'working.example'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
