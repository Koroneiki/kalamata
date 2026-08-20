import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  ColdClientDependencyId,
  ColdClientDependencyItemStatus,
  ColdClientDependencyStatus,
} from '../../types/cold-client.ts'
import {
  coldClientDependencyIds,
  coldClientDependencyIdSchema,
} from '../../types/cold-client.ts'
import { writeDurableJson } from '../filesystem/durable-json.ts'
import { ArchiveExtractor, validateExtractedTree } from './archive-extractor.ts'
import {
  type ArtifactDescriptor,
  type DependencyMetadata,
  type RemoteArtifact,
  artifactDescriptorSchema,
  dependencyMetadataSchema,
  emptyDependencyMetadata,
  githubReleaseSchema,
  parseRemoteArtifact,
} from './dependency-schema.ts'
import { asError } from './error.ts'
import { ColdClientMutationMutex } from './mutation-mutex.ts'

interface DependencyDefinition {
  dependencyId: ColdClientDependencyId
  repository: string
  assetName: string
  archive: boolean
  requiredFiles: string[]
}

interface ColdClientFetcher {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
}

interface DependencyServiceOptions {
  platform?: NodeJS.Platform
  fetcher?: ColdClientFetcher
  extractor?: ArchiveExtractor
  mutex?: ColdClientMutationMutex
  now?: () => number
  reportCleanupError?: (error: Error) => void
}

const definitions = {
  '7zip': {
    dependencyId: '7zip',
    repository: 'ip7z/7zip',
    assetName: '7zr.exe',
    archive: false,
    requiredFiles: ['7zr.exe'],
  },
  gbe: {
    dependencyId: 'gbe',
    repository: 'Detanup01/gbe_fork',
    assetName: 'emu-win-release.7z',
    archive: true,
    requiredFiles: [
      'release/steamclient_experimental/ColdClientLoader.ini',
      'release/steamclient_experimental/GameOverlayRenderer.dll',
      'release/steamclient_experimental/GameOverlayRenderer64.dll',
      'release/steamclient_experimental/steamclient.dll',
      'release/steamclient_experimental/steamclient64.dll',
      'release/steamclient_experimental/steamclient_loader_x86.exe',
      'release/steamclient_experimental/steamclient_loader_x64.exe',
      'release/steamclient_experimental/extra_dlls/steamclient_extra_x86.dll',
      'release/steamclient_experimental/extra_dlls/steamclient_extra_x64.dll',
      'release/tools/generate_interfaces/generate_interfaces_x64.exe',
    ],
  },
  gse: {
    dependencyId: 'gse',
    repository: 'alex47exe/gse_fork_tools',
    assetName: 'gen_emu_cfg-Windows-Release.7z',
    archive: true,
    requiredFiles: [
      'generate_emu_config/generate_emu_config.exe',
      'generate_emu_config/_internal/python312.dll',
      'generate_emu_config/_DEFAULT/1/steam_settings/configs.overlay.ini',
    ],
  },
} satisfies Record<ColdClientDependencyId, DependencyDefinition>

export class ColdClientDependencyService {
  readonly root: string
  readonly dependenciesRoot: string
  readonly loginFilename = 'my_login.txt'
  readonly #metadataPath: string
  readonly #downloadsRoot: string
  readonly #stagingRoot: string
  readonly #platform: NodeJS.Platform
  readonly #fetcher: ColdClientFetcher
  readonly #extractor: ArchiveExtractor
  readonly #mutex: ColdClientMutationMutex
  readonly #now: () => number
  readonly #reportCleanupError: (error: Error) => void
  readonly #remote = new Map<ColdClientDependencyId, RemoteArtifact>()
  readonly #checkErrors = new Map<ColdClientDependencyId, string>()
  #metadata = emptyDependencyMetadata()
  #lastCheckedAt: number | null = null
  #check: Promise<ColdClientDependencyStatus> | undefined
  #update: Promise<ColdClientDependencyStatus> | undefined
  #shutdown = false
  #initialized = false
  readonly #abortController = new AbortController()

  constructor(userDataRoot: string, options: DependencyServiceOptions = {}) {
    this.root = join(userDataRoot, 'coldclient')
    this.dependenciesRoot = join(this.root, 'dependencies')
    this.#metadataPath = join(this.dependenciesRoot, 'metadata.json')
    this.#downloadsRoot = join(this.root, 'downloads')
    this.#stagingRoot = join(this.root, 'staging')
    this.#platform = options.platform ?? process.platform
    this.#fetcher = options.fetcher ?? fetch
    this.#extractor = options.extractor ?? new ArchiveExtractor()
    this.#mutex = options.mutex ?? new ColdClientMutationMutex()
    this.#now = options.now ?? Date.now
    this.#reportCleanupError = options.reportCleanupError ?? (() => {})
  }

  async initialize(referencedGbeAssetIds: ReadonlySet<number> = new Set()) {
    await mkdir(this.dependenciesRoot, { recursive: true })
    await this.cleanupTemporaryPaths()
    this.#metadata = await this.loadMetadata()
    for (const dependencyId of coldClientDependencyIds) {
      const activeId = this.#metadata.active[dependencyId]
      if (activeId !== null) await this.validateArtifact(dependencyId, activeId)
    }
    await this.cleanupInactiveArtifacts(referencedGbeAssetIds)
    this.#initialized = true
  }

  async getStatus(): Promise<ColdClientDependencyStatus> {
    this.assertInitialized()
    if (this.#check) return this.#check
    return this.buildStatus()
  }

  private async buildStatus(): Promise<ColdClientDependencyStatus> {
    const activeGseId = this.#metadata.active.gse
    const loginDirectory =
      activeGseId === null
        ? null
        : join(
            this.artifactDirectory('gse', activeGseId),
            'generate_emu_config',
          )
    return {
      supported: this.#platform === 'win32',
      dependencies: coldClientDependencyIds.map((dependencyId) =>
        this.dependencyStatus(dependencyId),
      ),
      lastCheckedAt: this.#lastCheckedAt,
      loginFileExists:
        loginDirectory !== null &&
        (await exists(join(loginDirectory, this.loginFilename))),
      loginDirectory,
    }
  }

  checkForUpdates(): Promise<ColdClientDependencyStatus> {
    this.assertSupported()
    this.assertAccepting()
    this.assertInitialized()
    if (this.#check) return this.#check
    this.#check = this.performCheck().finally(() => {
      this.#check = undefined
    })
    return this.#check
  }

  private async performCheck(): Promise<ColdClientDependencyStatus> {
    await Promise.allSettled(
      coldClientDependencyIds.map(async (dependencyId) => {
        try {
          this.#remote.set(
            dependencyId,
            await this.fetchLatestArtifact(dependencyId),
          )
          this.#checkErrors.delete(dependencyId)
        } catch (error) {
          this.#remote.delete(dependencyId)
          this.#checkErrors.set(dependencyId, errorMessage(error))
        }
      }),
    )
    this.#lastCheckedAt = this.#now()
    return this.buildStatus()
  }

  updateDependencies(
    dependencyIds: ColdClientDependencyId[],
  ): Promise<ColdClientDependencyStatus> {
    this.assertSupported()
    this.assertAccepting()
    this.assertInitialized()
    if (this.#update) throw new Error('A dependency update is already running')
    const selected = dependencyIds.map((id) =>
      coldClientDependencyIdSchema.parse(id),
    )
    if (selected.length === 0) throw new Error('Select at least one dependency')
    if (new Set(selected).size !== selected.length) {
      throw new Error('Dependencies must not contain duplicates')
    }
    this.#update = this.performUpdate(selected).finally(() => {
      this.#update = undefined
    })
    return this.#update
  }

  activeArtifact(
    dependencyId: ColdClientDependencyId,
  ): ArtifactDescriptor | null {
    const assetId = this.#metadata.active[dependencyId]
    return assetId === null
      ? null
      : (this.#metadata.artifacts.find(
          (artifact) =>
            artifact.dependencyId === dependencyId &&
            artifact.assetId === assetId,
        ) ?? null)
  }

  artifact(
    dependencyId: ColdClientDependencyId,
    assetId: number,
  ): ArtifactDescriptor | null {
    return (
      this.#metadata.artifacts.find(
        (artifact) =>
          artifact.dependencyId === dependencyId &&
          artifact.assetId === assetId,
      ) ?? null
    )
  }

  // Called through the orchestration service's dependency contract.
  // fallow-ignore-next-line unused-class-member
  async validateArtifactSnapshot(
    dependencyId: ColdClientDependencyId,
    assetId: number,
  ): Promise<{ descriptor: ArtifactDescriptor; directory: string }> {
    const descriptor = this.artifact(dependencyId, assetId)
    if (!descriptor)
      throw new Error('ColdClient dependency metadata is missing')
    await this.validateArtifact(dependencyId, assetId)
    return {
      descriptor,
      directory: this.artifactDirectory(dependencyId, assetId),
    }
  }

  artifactDirectory(
    dependencyId: ColdClientDependencyId,
    assetId: number,
  ): string {
    return join(this.dependenciesRoot, dependencyId, String(assetId))
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return
    this.#shutdown = true
    this.#abortController.abort(new Error('Application is shutting down'))
    await Promise.allSettled(
      [this.#check, this.#update].filter(
        (operation): operation is Promise<ColdClientDependencyStatus> =>
          operation !== undefined,
      ),
    )
  }

  private async performUpdate(
    selected: ColdClientDependencyId[],
  ): Promise<ColdClientDependencyStatus> {
    const archiveSelected = selected.some((id) => definitions[id].archive)
    const updateExtractor =
      selected.includes('7zip') ||
      (archiveSelected && this.#metadata.active['7zip'] === null)
    if (updateExtractor) await this.installDependency('7zip')
    await Promise.all(
      selected
        .filter((dependencyId) => dependencyId !== '7zip')
        .map((dependencyId) => this.installDependency(dependencyId)),
    )
    return this.getStatus()
  }

  private async installDependency(
    dependencyId: ColdClientDependencyId,
  ): Promise<void> {
    this.#abortController.signal.throwIfAborted()
    const remote =
      this.#remote.get(dependencyId) ??
      (await this.fetchLatestArtifact(dependencyId))
    this.#remote.set(dependencyId, remote)
    this.#checkErrors.delete(dependencyId)
    const operationId = randomUUID()
    const downloadDirectory = join(this.#downloadsRoot, operationId)
    const stagingDirectory = join(this.#stagingRoot, operationId)
    const downloadPath = join(downloadDirectory, remote.assetName)
    await mkdir(downloadDirectory, { recursive: true })
    await mkdir(stagingDirectory, { recursive: true })
    try {
      const sha256 = await this.download(remote, downloadPath)
      if (remote.digest !== null && remote.digest !== sha256) {
        throw new Error('Downloaded dependency digest does not match GitHub')
      }
      if (dependencyId === '7zip') {
        await validatePortableExecutable(downloadPath, remote.assetName)
        await rename(downloadPath, join(stagingDirectory, '7zr.exe'))
      } else {
        const extractorId = this.#metadata.active['7zip']
        if (extractorId === null) throw new Error('7-Zip is not available')
        await this.#extractor.extract(
          join(this.artifactDirectory('7zip', extractorId), '7zr.exe'),
          downloadPath,
          stagingDirectory,
          this.#abortController.signal,
        )
      }
      await validateInventory(
        stagingDirectory,
        definitions[dependencyId].requiredFiles,
      )
      const descriptor = artifactDescriptorSchema.parse({
        dependencyId,
        repository: remote.repository,
        assetId: remote.assetId,
        releaseId: remote.releaseId,
        tag: remote.tag,
        publishedAt: remote.publishedAt,
        assetName: remote.assetName,
        sourceUrl: remote.sourceUrl,
        sha256,
        verificationMode:
          remote.digest === null ? 'https-inventory' : 'github-digest',
        validatedAt: this.#now(),
      })
      await this.activate(descriptor, stagingDirectory)
    } finally {
      await rm(downloadDirectory, { recursive: true, force: true })
      await rm(stagingDirectory, { recursive: true, force: true })
    }
  }

  private async activate(
    descriptor: ArtifactDescriptor,
    stagingDirectory: string,
  ): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.#abortController.signal.throwIfAborted()
      const dependencyId = descriptor.dependencyId
      let oldLogin: string | null = null
      if (dependencyId === 'gse') {
        const activeId = this.#metadata.active.gse
        if (activeId !== null) {
          const candidate = join(
            this.artifactDirectory('gse', activeId),
            'generate_emu_config',
            this.loginFilename,
          )
          if (await exists(candidate)) oldLogin = candidate
        }
      }
      await validateInventory(
        stagingDirectory,
        definitions[dependencyId].requiredFiles,
      )
      const destination = this.artifactDirectory(
        dependencyId,
        descriptor.assetId,
      )
      await mkdir(dirname(destination), { recursive: true })
      if (await exists(destination)) {
        await this.validateArtifact(dependencyId, descriptor.assetId)
        if (oldLogin) {
          await copyFile(
            oldLogin,
            join(destination, 'generate_emu_config', this.loginFilename),
          )
        }
      } else {
        if (oldLogin) {
          await copyFile(
            oldLogin,
            join(stagingDirectory, 'generate_emu_config', this.loginFilename),
          )
        }
        await rename(stagingDirectory, destination)
      }
      const metadata = dependencyMetadataSchema.parse({
        ...this.#metadata,
        active: {
          ...this.#metadata.active,
          [dependencyId]: descriptor.assetId,
        },
        artifacts: [
          ...this.#metadata.artifacts.filter(
            (artifact) =>
              artifact.dependencyId !== dependencyId ||
              artifact.assetId !== descriptor.assetId,
          ),
          descriptor,
        ],
      })
      await writeDurableJson(this.#metadataPath, metadata)
      this.#metadata = metadata
    })
  }

  private async download(
    remote: RemoteArtifact,
    destination: string,
  ): Promise<string> {
    const response = await this.#fetcher(remote.sourceUrl, {
      headers: { Accept: 'application/octet-stream' },
      signal: this.#abortController.signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`Dependency download failed (${response.status})`)
    }
    if (new URL(response.url || remote.sourceUrl).protocol !== 'https:') {
      throw new Error('Dependency download redirected outside HTTPS')
    }
    const handle = await open(destination, 'wx')
    const hash = createHash('sha256')
    let size = 0
    try {
      const reader = response.body.getReader()
      while (true) {
        const result = await reader.read()
        if (result.done) break
        this.#abortController.signal.throwIfAborted()
        hash.update(result.value)
        size += result.value.byteLength
        await handle.write(result.value)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (size !== remote.expectedSize) {
      throw new Error('Downloaded dependency size does not match GitHub')
    }
    return hash.digest('hex')
  }

  private async fetchLatestArtifact(
    dependencyId: ColdClientDependencyId,
  ): Promise<RemoteArtifact> {
    const definition = definitions[dependencyId]
    const response = await this.#fetcher(
      `https://api.github.com/repos/${definition.repository}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: this.#abortController.signal,
      },
    )
    if (!response.ok) {
      throw new Error(`Dependency update check failed (${response.status})`)
    }
    return parseRemoteArtifact(
      dependencyId,
      definition.repository,
      definition.assetName,
      githubReleaseSchema.parse(await response.json()),
    )
  }

  private dependencyStatus(
    dependencyId: ColdClientDependencyId,
  ): ColdClientDependencyItemStatus {
    const current = this.activeArtifact(dependencyId)
    const available = this.#remote.get(dependencyId) ?? null
    const error = this.#checkErrors.get(dependencyId) ?? null
    return {
      dependencyId,
      status: dependencyState(current, available, error),
      currentAssetId: current?.assetId ?? null,
      currentTag: current?.tag ?? null,
      availableAssetId: available?.assetId ?? null,
      availableTag: available?.tag ?? null,
      error,
    }
  }

  private async loadMetadata(): Promise<DependencyMetadata> {
    try {
      return dependencyMetadataSchema.parse(
        JSON.parse(await readFile(this.#metadataPath, 'utf8')),
      )
    } catch (error) {
      if (filesystemErrorCode(error) === 'ENOENT')
        return emptyDependencyMetadata()
      throw new Error('ColdClient dependency metadata is invalid', {
        cause: error,
      })
    }
  }

  private async validateArtifact(
    dependencyId: ColdClientDependencyId,
    assetId: number,
  ): Promise<void> {
    const directory = this.artifactDirectory(dependencyId, assetId)
    if (dependencyId === '7zip') {
      await validatePortableExecutable(join(directory, '7zr.exe'), '7zr.exe')
    }
    await validateInventory(directory, definitions[dependencyId].requiredFiles)
  }

  private async cleanupTemporaryPaths(): Promise<void> {
    for (const path of [this.#downloadsRoot, this.#stagingRoot]) {
      try {
        await rm(path, { recursive: true, force: true })
        await mkdir(path, { recursive: true })
      } catch (error) {
        this.#reportCleanupError(asError(error))
      }
    }
  }

  private async cleanupInactiveArtifacts(
    referencedGbeAssetIds: ReadonlySet<number>,
  ): Promise<void> {
    for (const artifact of this.#metadata.artifacts) {
      if (
        this.#metadata.active[artifact.dependencyId] === artifact.assetId ||
        (artifact.dependencyId === 'gbe' &&
          referencedGbeAssetIds.has(artifact.assetId))
      ) {
        continue
      }
      try {
        await rm(
          this.artifactDirectory(artifact.dependencyId, artifact.assetId),
          {
            recursive: true,
            force: true,
          },
        )
      } catch (error) {
        this.#reportCleanupError(asError(error))
      }
    }
  }

  private assertSupported(): void {
    if (this.#platform !== 'win32') {
      throw new Error('ColdClient dependencies are available only on Windows')
    }
  }

  private assertAccepting(): void {
    if (this.#shutdown) throw new Error('Dependency service is shutting down')
  }

  private assertInitialized(): void {
    if (!this.#initialized) {
      throw new Error('ColdClient dependency cache is unavailable')
    }
  }
}

function dependencyState(
  current: ArtifactDescriptor | null,
  available: RemoteArtifact | null,
  error: string | null,
): ColdClientDependencyItemStatus['status'] {
  if (error) return 'check-failed'
  if (!current) return 'missing'
  if (available && available.assetId !== current.assetId)
    return 'update-available'
  return 'current'
}

async function validateInventory(
  root: string,
  requiredFiles: string[],
): Promise<void> {
  await validateExtractedTree(root)
  for (const relativePath of requiredFiles) {
    const metadata = await stat(join(root, relativePath))
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`Dependency file is missing or empty: ${relativePath}`)
    }
  }
}

async function validatePortableExecutable(
  path: string,
  expectedName: string,
): Promise<void> {
  if (basename(path) !== expectedName)
    throw new Error('Unexpected executable name')
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error('Downloaded extractor is empty')
  }
  const handle = await open(path, 'r')
  try {
    const signature = Buffer.alloc(2)
    const { bytesRead } = await handle.read(signature, 0, 2, 0)
    if (bytesRead !== 2 || signature[0] !== 0x4d || signature[1] !== 0x5a) {
      throw new Error('Downloaded extractor is not a Windows executable')
    }
  } finally {
    await handle.close()
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

function filesystemErrorCode<ErrorValue>(
  error: ErrorValue,
): string | undefined {
  const result = z.object({ code: z.coerce.string() }).safeParse(error)
  return result.success ? result.data.code : undefined
}

function errorMessage<ErrorValue>(error: ErrorValue): string {
  const result = z.instanceof(Error).safeParse(error)
  return result.success ? result.data.message : 'Dependency check failed'
}
