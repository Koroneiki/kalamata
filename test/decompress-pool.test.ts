import { afterEach, describe, expect, test } from 'bun:test'
import { lzma } from '@napi-rs/lzma'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { DecompressPool } from '../src/backend/depot/transfer/decompress-pool.ts'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip') as new () => {
  addFile(name: string, contents: Buffer): void
  toBuffer(): Buffer
}
const symmetricEncrypt = require('@doctormckay/steam-crypto')
  .symmetricEncrypt as (data: Buffer, key: Buffer, iv: Buffer) => Buffer

const key = Buffer.alloc(32, 0x42)
const pools: DecompressPool[] = []

afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
})

describe('DecompressPool', () => {
  test('decrypts, decompresses, and validates a chunk in a Bun worker', async () => {
    const pool = createPool(1)
    const expected = Buffer.from('worker processed chunk')
    const encrypted = encryptedZip(expected)

    expect(await pool.process(encrypted, sha1(expected))).toEqual(expected)
  })

  test("repeatedly decompresses Steam ZSTD chunks with Bun's native decoder", async () => {
    const pool = createPool(1)
    const expected = Array.from({ length: 4 }, (_, index) =>
      Buffer.alloc(256 * 1024, index),
    )

    for (const contents of expected) {
      expect(
        await pool.process(encryptedZstd(contents), sha1(contents)),
      ).toEqual(contents)
    }
  })

  test('repeatedly decompresses Steam VZip chunks with the native decoder', async () => {
    const pool = createPool(1)
    const expected = [
      Buffer.from('first legacy chunk'),
      Buffer.from('second legacy chunk'),
    ]

    for (const contents of expected) {
      expect(
        await pool.process(encryptedVzip(contents), sha1(contents)),
      ).toEqual(contents)
    }
  })

  test('rejects a VZip chunk with a malformed footer', async () => {
    const pool = createPool(1)
    const expected = Buffer.from('valid contents')

    await expect(
      pool.process(
        encryptedVzip(expected, (payload) =>
          payload.write('xx', payload.length - 2),
        ),
        sha1(expected),
      ),
    ).rejects.toThrow("Didn't see expected footer")
  })

  test('rejects a VZip size that disagrees with the manifest', async () => {
    const pool = createPool(1)
    const expected = Buffer.from('valid contents')

    await expect(
      pool.process(
        encryptedVzip(expected),
        sha1(expected),
        expected.length + 1,
      ),
    ).rejects.toThrow('does not match the manifest')
  })

  test('rejects a VZip chunk with a CRC mismatch', async () => {
    const pool = createPool(1)
    const expected = Buffer.from('valid contents')

    await expect(
      pool.process(
        encryptedVzip(expected, (payload) =>
          payload.writeUInt32LE(0, payload.length - 10),
        ),
        sha1(expected),
      ),
    ).rejects.toThrow('CRC check failed')
  })

  test('processes queued chunks across multiple workers', async () => {
    const pool = createPool(2)
    const expected = Array.from({ length: 6 }, (_, index) =>
      Buffer.alloc(64 * 1024, index),
    )

    const actual = await Promise.all(
      expected.map((contents) =>
        pool.process(encryptedZip(contents), sha1(contents)),
      ),
    )

    expect(actual).toEqual(expected)
  })

  test('keeps a worker usable after a chunk validation error', async () => {
    const pool = createPool(1)
    const expected = Buffer.from('valid contents')

    await expect(
      pool.process(encryptedZip(expected), '0'.repeat(40)),
    ).rejects.toThrow('SHA1 mismatch')
    expect(await pool.process(encryptedZip(expected), sha1(expected))).toEqual(
      expected,
    )
  })

  test('rejects a container size that disagrees with the manifest', async () => {
    const pool = createPool(1)
    const expected = Buffer.from('valid contents')
    await expect(
      pool.process(encryptedZip(expected), sha1(expected), expected.length + 1),
    ).rejects.toThrow('does not match the manifest')
  })

  test('rejects active, queued, and future work after disposal', async () => {
    const pool = createPool(2)
    const expected = Array.from({ length: 3 }, (_, index) =>
      Buffer.alloc(1024 * 1024, 0x2a + index),
    )
    const processing = expected.map((contents) =>
      pool.process(encryptedZip(contents), sha1(contents)),
    )

    pool.dispose()

    for (const promise of processing)
      await expect(promise).rejects.toThrow('Pool disposed')
    await expect(
      pool.process(encryptedZip(expected[0]!), sha1(expected[0]!)),
    ).rejects.toThrow('Pool disposed')
  })
})

function createPool(count: number): DecompressPool {
  const pool = new DecompressPool(key, count)
  pools.push(pool)
  return pool
}

function encryptedZip(contents: Buffer): Buffer {
  const zip = new AdmZip()
  zip.addFile('chunk', contents)
  return symmetricEncrypt(zip.toBuffer(), key, Buffer.alloc(16, 0x24))
}

function encryptedZstd(contents: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write('VSZa')
  const footer = Buffer.alloc(15)
  footer.writeUInt32LE(Bun.hash.crc32(contents) >>> 0, 0)
  footer.writeUInt32LE(contents.length, 4)
  footer.write('zsv', 12)
  return symmetricEncrypt(
    Buffer.concat([header, Bun.zstdCompressSync(contents), footer]),
    key,
    Buffer.alloc(16, 0x24),
  )
}

function encryptedVzip(
  contents: Buffer,
  mutate?: (payload: Buffer) => void,
): Buffer {
  const compressed = lzma.compressSync(contents)
  // Convert LZMA-alone output into Steam VZip by removing its 8-byte size field
  // and surrounding the remaining properties/payload with Steam's header/footer.
  const footer = Buffer.alloc(10)
  footer.writeUInt32LE(Bun.hash.crc32(contents) >>> 0, 0)
  footer.writeUInt32LE(contents.length, 4)
  footer.write('zv', 8)
  const payload = Buffer.concat([
    Buffer.from('VZa'),
    Buffer.alloc(4),
    compressed.subarray(0, 5),
    compressed.subarray(13),
    footer,
  ])
  mutate?.(payload)
  return symmetricEncrypt(payload, key, Buffer.alloc(16, 0x24))
}

function sha1(contents: Buffer): string {
  return createHash('sha1').update(contents).digest('hex')
}
