import { createDecipheriv, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lzma } from '@napi-rs/lzma'
import { MAX_CHUNK_BYTES } from '../manifests/manifest-utils.ts'

const _require = createRequire(import.meta.url)

interface ZipEntry {
  header?: { size?: number }
}

interface ZipArchive {
  getEntries(): ZipEntry[]
  readFile(entry: ZipEntry): Buffer | null
}

interface ZipArchiveConstructor {
  new (data: Buffer): ZipArchive
}

const AdmZip: ZipArchiveConstructor = _require('adm-zip')

export async function processChunkData(
  encryptedData: Buffer,
  key: Buffer,
  expectedSha1: string,
  expectedSize?: number,
): Promise<Buffer> {
  if (
    expectedSize !== undefined &&
    (!Number.isSafeInteger(expectedSize) ||
      expectedSize < 1 ||
      expectedSize > MAX_CHUNK_BYTES)
  ) {
    throw new Error(`Invalid expected size for chunk ${expectedSha1}`)
  }
  const decrypted = decryptSteamChunk(encryptedData, key)
  const decompressed = decompress(decrypted, expectedSize)
  if (expectedSize !== undefined && decompressed.length !== expectedSize) {
    throw new Error(
      `Chunk ${expectedSha1} has size ${decompressed.length}, expected ${expectedSize}`,
    )
  }
  const actualSha1 = createHash('sha1').update(decompressed).digest('hex')
  if (actualSha1 !== expectedSha1.toLowerCase()) {
    throw new Error(`SHA1 mismatch for chunk ${expectedSha1}`)
  }
  return decompressed
}

function decryptSteamChunk(data: Buffer, key: Buffer): Buffer {
  // Steam prepends an ECB-encrypted IV to its CBC-encrypted payload. Explicit
  // finalization avoids steam-crypto's end/read race on Bun 1.4.
  const ivCipher = createDecipheriv('aes-256-ecb', key, null)
  ivCipher.setAutoPadding(false)
  const iv = Buffer.concat([
    ivCipher.update(data.subarray(0, 16)),
    ivCipher.final(),
  ])
  const dataCipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([
    dataCipher.update(data.subarray(16)),
    dataCipher.final(),
  ])
}

function decompress(data: Buffer, expectedSize?: number): Buffer {
  // Decode each Steam container format directly rather than delegating to
  // steam-user's compression helper.
  if (data.length >= 23 && data.subarray(0, 4).toString('utf8') === 'VSZa') {
    const footerOffset = data.length - 15
    if (data.subarray(data.length - 3).toString('utf8') !== 'zsv') {
      throw new Error("Zstd: Didn't see expected footer")
    }

    const expectedCrc = data.readUInt32LE(footerOffset)
    const declaredSize = data.readUInt32LE(footerOffset + 4)
    validateDeclaredSize('Zstd', declaredSize, expectedSize)
    const result = Bun.zstdDecompressSync(data.subarray(8, footerOffset))
    if (result.length !== declaredSize)
      throw new Error('Zstd: Decompressed size was not valid')
    if (Bun.hash.crc32(result) >>> 0 !== expectedCrc)
      throw new Error('Zstd: CRC check failed on decompressed data')
    return result
  }

  if (data.subarray(0, 3).toString('utf8') === 'VZa')
    return decompressVzip(data, expectedSize)
  if (data.subarray(0, 4).toString('binary') === 'PK\x03\x04')
    return decompressZip(data, expectedSize)
  throw new Error(
    `Unknown compression type: ${data.subarray(0, 4).toString('hex')}`,
  )
}

function decompressZip(data: Buffer, expectedSize?: number): Buffer {
  const archive = new AdmZip(data)
  const entry = archive.getEntries()[0]
  if (!entry) throw new Error('ZIP chunk contains no entries')
  if (entry.header?.size !== undefined)
    validateDeclaredSize('ZIP', entry.header.size, expectedSize)
  const result = archive.readFile(entry)
  if (!result) throw new Error('The ZIP decoder could not decompress the chunk')
  return result
}

function decompressVzip(data: Buffer, manifestSize?: number): Buffer {
  if (
    data.length < 22 ||
    data.subarray(data.length - 2).toString('utf8') !== 'zv'
  ) {
    throw new Error("VZip: Didn't see expected footer")
  }

  const footerOffset = data.length - 10
  const expectedCrc = data.readUInt32LE(footerOffset)
  const expectedSize = data.readUInt32LE(footerOffset + 4)
  validateDeclaredSize('VZip', expectedSize, manifestSize)
  // Steam VZip omits the standard LZMA-alone 8-byte size field. Reinsert it
  // between the five property bytes and compressed payload for the native decoder.
  const properties = data.subarray(7, 12)
  // Buffer.alloc leaves the high 32 bits zero; supported chunk sizes fit in the low word.
  const size = Buffer.alloc(8)
  size.writeUInt32LE(expectedSize)
  const compressed = Buffer.concat([
    properties,
    size,
    data.subarray(12, footerOffset),
  ])
  const result = lzma.decompressSync(compressed)
  if (result.length !== expectedSize)
    throw new Error('VZip: Decompressed size was not valid')
  if (Bun.hash.crc32(result) >>> 0 !== expectedCrc) {
    throw new Error('VZip: CRC check failed on decompressed data')
  }
  return result
}

function validateDeclaredSize(
  format: string,
  declaredSize: number,
  expectedSize?: number,
): void {
  if (declaredSize < 1 || declaredSize > MAX_CHUNK_BYTES) {
    throw new Error(
      `${format}: Declared size exceeds the supported chunk limit`,
    )
  }
  if (expectedSize !== undefined && declaredSize !== expectedSize) {
    throw new Error(`${format}: Declared size does not match the manifest`)
  }
}
