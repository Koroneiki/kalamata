import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { CONFIG_DIRECTORY, STAGING_DIRECTORY } from './depot-paths.ts'
import { parseManifest } from './local-inputs.ts'
import type { DepotManifest } from './types.ts'

interface DepotConfigData {
  version: 1
  installedManifestIds: Record<string, string | null>
}

export class DepotConfigStore {
  readonly directory: string
  readonly stagingDirectory: string
  readonly #filename: string
  readonly #data: DepotConfigData

  private constructor(outputDirectory: string, data: DepotConfigData) {
    this.directory = join(outputDirectory, CONFIG_DIRECTORY)
    this.stagingDirectory = join(this.directory, STAGING_DIRECTORY)
    this.#filename = join(this.directory, 'depot.config.json')
    this.#data = data
  }

  static async load(outputDirectory: string): Promise<DepotConfigStore> {
    await assertSafeConfigDirectory(outputDirectory)
    const filename = join(
      outputDirectory,
      CONFIG_DIRECTORY,
      'depot.config.json',
    )
    let contents: string
    try {
      contents = await readFile(filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new DepotConfigStore(outputDirectory, {
          version: 1,
          installedManifestIds: {},
        })
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch (error) {
      throw new Error(`Invalid depot config ${filename}`, { cause: error })
    }
    if (!isDepotConfigData(parsed))
      throw new Error(`Invalid depot config ${filename}`)
    return new DepotConfigStore(outputDirectory, parsed)
  }

  getInstalledManifestId(depotId: number): string | undefined {
    return this.#data.installedManifestIds[String(depotId)] ?? undefined
  }

  async setInstalledManifestId(
    depotId: number,
    manifestId: string | null,
  ): Promise<void> {
    const key = String(depotId)
    if (
      Object.hasOwn(this.#data.installedManifestIds, key) &&
      this.#data.installedManifestIds[key] === manifestId
    )
      return
    const nextData: DepotConfigData = {
      ...this.#data,
      installedManifestIds: {
        ...this.#data.installedManifestIds,
        [key]: manifestId,
      },
    }
    await mkdir(this.directory, { recursive: true })
    await writeAtomically(
      this.#filename,
      `${JSON.stringify(nextData, null, 2)}\n`,
    )
    this.#data.installedManifestIds = nextData.installedManifestIds
  }

  async replaceInstalledManifestIds(
    manifests: ReadonlyMap<number, string>,
  ): Promise<void> {
    const installedManifestIds = Object.fromEntries(
      [...manifests]
        .sort(([left], [right]) => left - right)
        .map(([depotId, manifestId]) => [String(depotId), manifestId]),
    )
    if (
      JSON.stringify(this.#data.installedManifestIds) ===
      JSON.stringify(installedManifestIds)
    )
      return
    const nextData: DepotConfigData = {
      version: 1,
      installedManifestIds,
    }
    await mkdir(this.directory, { recursive: true })
    await writeAtomically(
      this.#filename,
      `${JSON.stringify(nextData, null, 2)}\n`,
    )
    this.#data.installedManifestIds = installedManifestIds
  }

  async loadManifest(
    depotId: number,
    manifestId: string,
    key: Buffer,
  ): Promise<DepotManifest | undefined> {
    const filename = this.manifestPath(depotId, manifestId)
    let contents: Buffer
    let expectedHash: string
    try {
      ;[contents, expectedHash] = await Promise.all([
        readFile(filename),
        readFile(`${filename}.sha`, 'utf8'),
      ])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }

    const actualHash = sha1(contents)
    if (expectedHash.trim().toLowerCase() !== actualHash) return undefined
    let manifest: DepotManifest
    try {
      manifest = parseManifest(contents, key)
    } catch {
      return undefined
    }
    if (manifest.depot_id !== depotId || manifest.gid_manifest !== manifestId)
      return undefined
    return manifest
  }

  async saveManifest(
    depotId: number,
    manifestId: string,
    contents: Buffer,
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const filename = this.manifestPath(depotId, manifestId)
    await writeBufferAtomically(filename, contents)
    await writeAtomically(`${filename}.sha`, `${sha1(contents)}\n`)
  }

  manifestPath(depotId: number, manifestId: string): string {
    return join(this.directory, `${depotId}_${manifestId}.manifest`)
  }
}

export async function acquireOutputLock(
  outputDirectory: string,
): Promise<() => Promise<void>> {
  await assertSafeConfigDirectory(outputDirectory)
  const directory = join(outputDirectory, CONFIG_DIRECTORY)
  const ownerPath = join(directory, 'download.lock')
  await mkdir(directory, { recursive: true })
  let database: Database | undefined
  try {
    database = new Database(ownerPath, { create: true })
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;')
  } catch (error) {
    database?.close(false)
    throw new Error(`Another download is already using ${outputDirectory}`, {
      cause: error,
    })
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      database.exec('COMMIT')
    } finally {
      database.close(false)
    }
  }
}

async function writeAtomically(
  filename: string,
  contents: string,
): Promise<void> {
  await writeBufferAtomically(filename, Buffer.from(contents))
}

async function writeBufferAtomically(
  filename: string,
  contents: Buffer,
): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents)
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true })
  }
}

function sha1(contents: Buffer): string {
  return createHash('sha1').update(contents).digest('hex')
}

function isDepotConfigData(value: unknown): value is DepotConfigData {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<DepotConfigData>
  if (
    data.version !== 1 ||
    !data.installedManifestIds ||
    typeof data.installedManifestIds !== 'object' ||
    Array.isArray(data.installedManifestIds)
  )
    return false
  return Object.entries(data.installedManifestIds).every(
    ([depotId, manifestId]) =>
      /^\d+$/u.test(depotId) &&
      (manifestId === null ||
        (typeof manifestId === 'string' && /^\d+$/u.test(manifestId))),
  )
}

async function assertSafeConfigDirectory(
  outputDirectory: string,
): Promise<void> {
  const directory = join(outputDirectory, CONFIG_DIRECTORY)
  for (const path of [
    directory,
    join(directory, STAGING_DIRECTORY),
    join(directory, 'transactions'),
    join(directory, 'repair-fallback'),
    join(directory, 'download.lock'),
  ]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(
          `Internal state path must not be a symbolic link: ${path}`,
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
