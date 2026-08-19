import { randomUUID } from 'node:crypto'
import { cp, lstat, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ColdClientInstallation,
  ColdClientSetupDraft,
  ColdClientSetupRequest,
  ColdClientStatus,
} from '../../types/cold-client.ts'
import { coldClientSetupRequestSchema } from '../../types/cold-client.ts'
import { acquireOutputLock } from '../depot/install/output-lock.ts'
import type { ArtifactDescriptor } from './dependency-schema.ts'
import { coldClientDepotFingerprint } from './depot-fingerprint.ts'
import type { GeneratedGseConfiguration } from './generator.ts'
import {
  readColdClientLoaderIniValues,
  updateColdClientLoaderIni,
} from './ini.ts'
import {
  assertRequiredManagedCoreFiles,
  collectManagedCoreFiles,
} from './managed-inventory.ts'
import type { ColdClientOperationContext } from './operation-coordinator.ts'

interface ServiceDatabase {
  getLibraryEntry(appId: number): { installPath: string | null } | null
  getInstalls(appId: number): Array<{
    depotId: number
    installedManifestId: string
  }>
  getColdClientInstallation(appId: number): ColdClientInstallation | null
}

interface ServiceDependencies {
  activeArtifact(dependencyId: 'gbe' | 'gse'): ArtifactDescriptor | null
  artifact(
    dependencyId: 'gbe' | 'gse',
    assetId: number,
  ): ArtifactDescriptor | null
  validateArtifactSnapshot(
    dependencyId: 'gbe' | 'gse',
    assetId: number,
  ): Promise<{ descriptor: ArtifactDescriptor; directory: string }>
}

interface InspectorProvider {
  inspect(appId: number): Promise<ColdClientSetupDraft>
}

interface GeneratorProvider {
  generate(
    appId: number,
    signal: AbortSignal,
  ): Promise<GeneratedGseConfiguration>
}

interface InterfaceGeneratorProvider {
  generate(
    executable: string,
    steamApiPath: string,
    temporaryRoot: string,
    destination: string,
    signal: AbortSignal,
  ): Promise<void>
}

interface OperationProvider {
  run<Result>(
    kind: 'setup',
    appId: number,
    operation: (context: ColdClientOperationContext) => Promise<Result>,
  ): Promise<Result>
}

interface ReplacementProvider {
  replaceSetup(options: {
    installRoot: string
    stagingDirectory: string
    previousInstallation: ColdClientInstallation | null
    targetInstallation: ColdClientInstallation
    validateLive(directory: string): Promise<void>
  }): Promise<void>
  hasJournal(installRoot: string): Promise<boolean>
  recover(
    installRoot: string,
    validateLive: (directory: string) => Promise<void>,
  ): Promise<
    | { status: 'none' }
    | { status: 'recovered'; direction: 'rollback' | 'forward' }
    | { status: 'invalid'; message: string }
  >
}

interface ColdClientServiceOptions {
  platform?: NodeJS.Platform
  now?: () => number
  acquireLock?: typeof acquireOutputLock
}

const requiredSettingsFiles = [
  'configs.app.ini',
  'configs.main.ini',
  'configs.overlay.ini',
  'configs.user.ini',
  'steam_appid.txt',
]

export class ColdClientService {
  readonly #platform: NodeJS.Platform
  readonly #now: () => number
  readonly #acquireLock: typeof acquireOutputLock

  constructor(
    private readonly database: ServiceDatabase,
    private readonly dependencies: ServiceDependencies,
    private readonly inspector: InspectorProvider,
    private readonly generator: GeneratorProvider,
    private readonly interfaceGenerator: InterfaceGeneratorProvider,
    private readonly operations: OperationProvider,
    private readonly replacement: ReplacementProvider,
    options: ColdClientServiceOptions = {},
  ) {
    this.#platform = options.platform ?? process.platform
    this.#now = options.now ?? Date.now
    this.#acquireLock = options.acquireLock ?? acquireOutputLock
  }

  configure(requestInput: ColdClientSetupRequest): Promise<ColdClientStatus> {
    const request = coldClientSetupRequestSchema.parse(requestInput)
    return this.operations.run('setup', request.appId, async (context) => {
      const initialDraft = await this.inspector.inspect(request.appId)
      validateReviewedRequest(request, initialDraft)
      const initialLibrary = requireInstalledLibrary(
        this.database,
        request.appId,
      )
      const initialRoot = await realpath(initialLibrary.installPath)
      const initialDepots = depotSnapshot(this.database, request.appId)
      const generated = await this.generator.generate(
        request.appId,
        context.signal,
      )
      if (generated.gseAssetId !== request.gseAssetId) {
        throw new Error('GSE Tools changed after setup review')
      }
      context.setPhase('building')
      await this.buildAndReplace(
        request,
        initialDraft,
        initialRoot,
        initialDepots,
        generated,
        context,
      )
      return this.getStatus(request.appId)
    })
  }

  async getStatus(appId: number): Promise<ColdClientStatus> {
    if (this.#platform !== 'win32') {
      return { status: 'unsupported', reason: 'host-platform' }
    }
    const library = this.database.getLibraryEntry(appId)
    if (
      !library?.installPath ||
      this.database.getInstalls(appId).length === 0
    ) {
      return { status: 'unsupported', reason: 'not-installed' }
    }
    const installation = this.database.getColdClientInstallation(appId)
    if (!installation) return { status: 'not-configured' }
    try {
      if (await this.replacement.hasJournal(library.installPath)) {
        return {
          status: 'invalid',
          message: 'An interrupted ColdClient replacement requires repair.',
        }
      }
      await validateInstalledCore(library.installPath, installation)
      const installedGbe = requireArtifact(
        this.dependencies,
        'gbe',
        installation.gbeAssetId,
      )
      const installedGse = requireArtifact(
        this.dependencies,
        'gse',
        installation.gseAssetId,
      )
      const activeGbe = this.dependencies.activeArtifact('gbe')
      const activeGse = this.dependencies.activeArtifact('gse')
      const recommendationReasons: Array<'depots-changed' | 'gse-updated'> = []
      if (
        coldClientDepotFingerprint(this.database.getInstalls(appId)) !==
        installation.generatedDepotFingerprint
      ) {
        recommendationReasons.push('depots-changed')
      }
      if (activeGse && activeGse.assetId !== installation.gseAssetId) {
        recommendationReasons.push('gse-updated')
      }
      return {
        status: 'configured',
        coreUpdateAvailable:
          activeGbe !== null && activeGbe.assetId !== installation.gbeAssetId,
        recommendationReasons,
        installedGbeTag: installedGbe.tag,
        availableGbeTag: activeGbe?.tag ?? null,
        installedGseTag: installedGse.tag,
        availableGseTag: activeGse?.tag ?? null,
        lastConfiguredAt: installation.configuredAt,
      }
    } catch {
      return {
        status: 'invalid',
        message: 'The ColdClient installation is incomplete or unsafe.',
      }
    }
  }

  async recover(appId: number, installRoot: string) {
    return this.replacement.recover(installRoot, async () => {
      const installation = this.database.getColdClientInstallation(appId)
      if (!installation) {
        throw new Error('Committed ColdClient installation record is missing')
      }
      await validateInstalledCore(installRoot, installation)
    })
  }

  private async buildAndReplace(
    request: ColdClientSetupRequest,
    initialDraft: ColdClientSetupDraft,
    initialRoot: string,
    initialDepots: ReturnType<typeof depotSnapshot>,
    generated: GeneratedGseConfiguration,
    context: ColdClientOperationContext,
  ): Promise<void> {
    const release = await this.#acquireLock(initialRoot)
    let stagingDirectory: string | undefined
    try {
      const currentLibrary = requireInstalledLibrary(
        this.database,
        request.appId,
      )
      const installRoot = await realpath(currentLibrary.installPath)
      if (installRoot !== initialRoot) {
        throw new Error('The game install path changed during setup')
      }
      const currentDepots = depotSnapshot(this.database, request.appId)
      if (JSON.stringify(currentDepots) !== JSON.stringify(initialDepots)) {
        throw new Error('Installed depots changed during setup')
      }
      const lockedDraft = await this.inspector.inspect(request.appId)
      validateReviewedRequest(request, lockedDraft)
      if (
        lockedDraft.gbe.assetId !== initialDraft.gbe.assetId ||
        lockedDraft.gse.assetId !== initialDraft.gse.assetId
      ) {
        throw new Error('ColdClient dependencies changed during setup')
      }
      const gbe = await this.dependencies.validateArtifactSnapshot(
        'gbe',
        request.gbeAssetId,
      )
      await this.dependencies.validateArtifactSnapshot(
        'gse',
        request.gseAssetId,
      )
      context.signal.throwIfAborted()

      stagingDirectory = join(
        installRoot,
        `.Kalamata-coldclient-staging-${randomUUID()}`,
      )
      const source = join(gbe.directory, 'release', 'steamclient_experimental')
      await cp(source, stagingDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
      const unusedLoader =
        request.loaderArchitecture === 'x86'
          ? 'steamclient_loader_x64.exe'
          : 'steamclient_loader_x86.exe'
      await rm(join(stagingDirectory, unusedLoader), { force: true })
      const settings = join(stagingDirectory, 'steam_settings')
      await rm(settings, { recursive: true, force: true })
      await cp(generated.steamSettingsDirectory, settings, {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
      if (request.steamApiRelativePath) {
        await this.interfaceGenerator.generate(
          join(
            gbe.directory,
            'release',
            'tools',
            'generate_interfaces',
            'generate_interfaces_x64.exe',
          ),
          join(installRoot, ...request.steamApiRelativePath.split('/')),
          join(installRoot, CONFIG_TEMPORARY_DIRECTORY),
          join(settings, 'steam_interfaces.txt'),
          context.signal,
        )
        await rm(join(installRoot, CONFIG_TEMPORARY_DIRECTORY), {
          recursive: true,
          force: true,
        })
      }
      await updateColdClientLoaderIni(
        join(stagingDirectory, 'ColdClientLoader.ini'),
        {
          executableRelativePath: request.executableRelativePath,
          appId: request.appId,
          launchArguments: request.launchArguments,
        },
      )
      const managedCoreFiles = await validatePreparedInstallation(
        stagingDirectory,
        request,
      )
      const previousInstallation = this.database.getColdClientInstallation(
        request.appId,
      )
      const targetInstallation: ColdClientInstallation = {
        appId: request.appId,
        loaderArchitecture: request.loaderArchitecture,
        executableRelativePath: request.executableRelativePath,
        steamApiRelativePath: request.steamApiRelativePath,
        launchArguments: request.launchArguments,
        launchArgumentSource: request.launchArgumentSource,
        gbeAssetId: request.gbeAssetId,
        gseAssetId: request.gseAssetId,
        generatedDepotFingerprint: coldClientDepotFingerprint(currentDepots),
        managedCoreFiles,
        configuredAt: this.#now(),
      }
      context.beginReplacement()
      await this.replacement.replaceSetup({
        installRoot,
        stagingDirectory,
        previousInstallation,
        targetInstallation,
        validateLive: async (live) => {
          context.setPhase('validating')
          const liveFiles = await validatePreparedInstallation(live, request)
          if (JSON.stringify(liveFiles) !== JSON.stringify(managedCoreFiles)) {
            throw new Error(
              'Live ColdClient inventory changed during replacement',
            )
          }
        },
      })
      stagingDirectory = undefined
    } finally {
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
      await rm(generated.appDirectory, { recursive: true, force: true })
      await rm(join(initialRoot, CONFIG_TEMPORARY_DIRECTORY), {
        recursive: true,
        force: true,
      })
      await release()
    }
  }
}

const CONFIG_TEMPORARY_DIRECTORY = '.Kalamata-coldclient-interfaces'

function requireInstalledLibrary(database: ServiceDatabase, appId: number) {
  const library = database.getLibraryEntry(appId)
  if (!library?.installPath || database.getInstalls(appId).length === 0) {
    throw new Error('ColdClient setup requires an installed game')
  }
  return { installPath: library.installPath }
}

function depotSnapshot(database: ServiceDatabase, appId: number) {
  return database
    .getInstalls(appId)
    .map(({ depotId, installedManifestId }) => ({
      depotId,
      installedManifestId,
    }))
    .toSorted((left, right) => left.depotId - right.depotId)
}

function validateReviewedRequest(
  request: ColdClientSetupRequest,
  draft: ColdClientSetupDraft,
): void {
  if (
    request.gbeAssetId !== draft.gbe.assetId ||
    request.gseAssetId !== draft.gse.assetId
  ) {
    throw new Error('ColdClient dependencies changed after setup review')
  }
  if (!draft.executableCandidates.includes(request.executableRelativePath)) {
    throw new Error('The reviewed game executable is no longer available')
  }
  if (
    request.steamApiRelativePath === null
      ? draft.steamApiCandidates.length > 0
      : !draft.steamApiCandidates.includes(request.steamApiRelativePath)
  ) {
    throw new Error('The reviewed Steam API DLL is no longer available')
  }
  if (
    request.launchArgumentSource !== null &&
    !draft.launchOptions.some(({ key }) => key === request.launchArgumentSource)
  ) {
    throw new Error('The reviewed Steam launch entry is no longer available')
  }
  const architecture = request.steamApiRelativePath
    ?.toLowerCase()
    .endsWith('steam_api.dll')
    ? 'x86'
    : 'x64'
  if (request.loaderArchitecture !== architecture) {
    throw new Error('The reviewed loader architecture is inconsistent')
  }
}

async function validatePreparedInstallation(
  root: string,
  request: ColdClientSetupRequest,
): Promise<string[]> {
  for (const path of requiredSettingsFiles) {
    await assertRegularFile(join(root, 'steam_settings', path), path)
  }
  if (request.steamApiRelativePath) {
    await assertRegularFile(
      join(root, 'steam_settings', 'steam_interfaces.txt'),
      'steam_interfaces.txt',
    )
  }
  const ini = await readColdClientLoaderIniValues(
    join(root, 'ColdClientLoader.ini'),
  )
  const expectedExecutable = `..\\${request.executableRelativePath.replaceAll('/', '\\')}`
  if (
    ini.Exe !== expectedExecutable ||
    ini.ExeCommandLine !== request.launchArguments ||
    ini.AppId !== String(request.appId) ||
    ini.DllsToInjectFolder !== 'extra_dlls'
  ) {
    throw new Error('ColdClient loader INI does not match the reviewed setup')
  }
  const files = await collectManagedCoreFiles(root)
  assertRequiredManagedCoreFiles(files, request.loaderArchitecture)
  return files
}

async function validateInstalledCore(
  installRoot: string,
  installation: ColdClientInstallation,
): Promise<void> {
  const root = join(installRoot, '_ColdClient')
  await assertRegularFile(
    join(root, 'ColdClientLoader.ini'),
    'ColdClientLoader.ini',
  )
  for (const path of requiredSettingsFiles) {
    await assertRegularFile(join(root, 'steam_settings', path), path)
  }
  for (const path of installation.managedCoreFiles) {
    await assertRegularFile(join(root, ...path.split('/')), path)
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`ColdClient installation is missing ${label}`)
  }
}

function requireArtifact(
  dependencies: ServiceDependencies,
  dependencyId: 'gbe' | 'gse',
  assetId: number,
): ArtifactDescriptor {
  const artifact = dependencies.artifact(dependencyId, assetId)
  if (!artifact) throw new Error('ColdClient dependency record is missing')
  return artifact
}
