import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ColdClientInstallation,
  ColdClientSetupDraft,
  ColdClientSetupMode,
  ColdClientSetupRequest,
  ColdClientSetupWarning,
  ColdClientStatus,
} from '../../types/cold-client.ts'
import { coldClientSetupRequestSchema } from '../../types/cold-client.ts'
import { acquireOutputLock } from '../depot/install/output-lock.ts'
import { filesystemErrorCode } from '../depot/install/transaction/types.ts'
import type { ArtifactDescriptor } from './dependency-schema.ts'
import { coldClientDepotFingerprint } from './depot-fingerprint.ts'
import { asError } from './error.ts'
import type { GeneratedGseConfiguration } from './generator.ts'
import {
  readColdClientLoaderIniValues,
  updateColdClientLoaderIni,
} from './ini.ts'
import {
  assertRequiredManagedCoreFiles,
  assertCoreUpdateOwnership,
  assertSafeDirectory,
  assertSafeRelativeFile,
  collectManagedCoreFiles,
} from './managed-inventory.ts'
import type { ColdClientOperationContext } from './operation-coordinator.ts'
import { hasColdClientRecoveryJournal } from './replacement.ts'

interface ServiceDatabase {
  getLibraryEntry(appId: number): { installPath: string | null } | null
  getInstalls(appId: number): Array<{
    depotId: number
    installedManifestId: string
  }>
  getColdClientInstallation(appId: number): ColdClientInstallation | null
  deleteColdClientInstallation(appId: number): void
  clearUnusedInstallPath(appId: number): void
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

const gbeSharedCoreFiles = [
  'steamclient.dll',
  'steamclient64.dll',
  'GameOverlayRenderer.dll',
  'GameOverlayRenderer64.dll',
  'extra_dlls/steamclient_extra_x86.dll',
  'extra_dlls/steamclient_extra_x64.dll',
] as const

interface OperationProvider {
  run<Result>(
    kind: 'setup' | 'regenerate' | 'update-core' | 'remove',
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
  replaceConfiguration(options: {
    installRoot: string
    stagingDirectory: string
    previousInstallation: ColdClientInstallation
    targetInstallation: ColdClientInstallation
    validateLive(directory: string): Promise<void>
  }): Promise<void>
  replaceCore(options: {
    installRoot: string
    stagingDirectory: string
    previousInstallation: ColdClientInstallation
    targetInstallation: ColdClientInstallation
    validateLive(directory: string): Promise<void>
  }): Promise<void>
  hasUnresolvedJournal(installRoot: string, appId: number): Promise<boolean>
  recover(
    installRoot: string,
    expectedAppId: number,
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
  reportCleanupError?: (error: Error) => void
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
  readonly #reportCleanupError: (error: Error) => void

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
    this.#reportCleanupError = options.reportCleanupError ?? (() => {})
  }

  async inspectSetup(
    appId: number,
    mode: ColdClientSetupMode,
  ): Promise<ColdClientSetupDraft> {
    const draft = await this.inspector.inspect(appId)
    if (mode === 'setup') return draft
    const previous = this.database.getColdClientInstallation(appId)
    if (!previous) throw new Error('ColdClient is not configured')
    const gbe = requireArtifact(this.dependencies, 'gbe', previous.gbeAssetId)
    return applySavedConfiguration(draft, previous, gbe)
  }

  configure(requestInput: ColdClientSetupRequest): Promise<ColdClientStatus> {
    this.assertSupported()
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

  regenerate(requestInput: ColdClientSetupRequest): Promise<ColdClientStatus> {
    this.assertSupported()
    const request = coldClientSetupRequestSchema.parse(requestInput)
    return this.operations.run('regenerate', request.appId, async (context) => {
      const initialDraft = await this.inspectSetup(request.appId, 'regenerate')
      validateReviewedRequest(request, initialDraft)
      const previous = this.database.getColdClientInstallation(request.appId)
      if (!previous) throw new Error('ColdClient is not configured')
      const library = requireInstalledLibrary(this.database, request.appId)
      const installRoot = await realpath(library.installPath)
      const initialDepots = depotSnapshot(this.database, request.appId)
      const generated = await this.generator.generate(
        request.appId,
        context.signal,
      )
      if (generated.gseAssetId !== request.gseAssetId) {
        throw new Error('GSE Tools changed after regeneration review')
      }
      context.setPhase('building')
      const release = await this.#acquireLock(installRoot)
      let stagingDirectory: string | undefined
      try {
        const currentLibrary = requireInstalledLibrary(
          this.database,
          request.appId,
        )
        if ((await realpath(currentLibrary.installPath)) !== installRoot) {
          throw new Error('The game install path changed during regeneration')
        }
        const current = this.database.getColdClientInstallation(request.appId)
        if (!sameInstallation(current, previous)) {
          throw new Error('ColdClient changed during regeneration')
        }
        const lockedDraft = await this.inspectSetup(request.appId, 'regenerate')
        validateReviewedRequest(request, lockedDraft)
        const currentDepots = depotSnapshot(this.database, request.appId)
        if (JSON.stringify(currentDepots) !== JSON.stringify(initialDepots)) {
          throw new Error('Installed depots changed during regeneration')
        }
        const gbe = await this.dependencies.validateArtifactSnapshot(
          'gbe',
          request.gbeAssetId,
        )
        await this.dependencies.validateArtifactSnapshot(
          'gse',
          request.gseAssetId,
        )
        const liveDirectory = join(installRoot, '_ColdClient')
        await assertSafeDirectory(liveDirectory, 'ColdClient directory')
        stagingDirectory = join(
          installRoot,
          `.Kalamata-coldclient-regeneration-staging-${randomUUID()}`,
        )
        // A full-directory transaction keeps settings, loader changes, and custom files atomic.
        await cp(liveDirectory, stagingDirectory, {
          recursive: true,
          errorOnExist: true,
          force: false,
        })
        const settings = join(stagingDirectory, 'steam_settings')
        await rm(settings, { recursive: true, force: true })
        await cp(generated.steamSettingsDirectory, settings, {
          recursive: true,
          errorOnExist: true,
          force: false,
        })
        if (request.steamApiRelativePath) {
          await assertSafeRelativeFile(
            installRoot,
            request.steamApiRelativePath,
          )
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
        }
        await updateColdClientLoaderIni(
          join(stagingDirectory, 'ColdClientLoader.ini'),
          {
            executableRelativePath: request.executableRelativePath,
            appId: request.appId,
            launchArguments: request.launchArguments,
          },
        )
        const managedCoreFiles = switchedLoaderInventory(
          previous.managedCoreFiles,
          request.loaderArchitecture,
        )
        if (request.loaderArchitecture !== previous.loaderArchitecture) {
          await rm(
            join(
              stagingDirectory,
              `steamclient_loader_${previous.loaderArchitecture}.exe`,
            ),
          )
          await cp(
            join(
              gbe.directory,
              'release',
              'steamclient_experimental',
              `steamclient_loader_${request.loaderArchitecture}.exe`,
            ),
            join(
              stagingDirectory,
              `steamclient_loader_${request.loaderArchitecture}.exe`,
            ),
            { errorOnExist: true, force: false },
          )
        }
        await validateRegeneratedInstallation(
          stagingDirectory,
          request,
          managedCoreFiles,
        )
        const target: ColdClientInstallation = {
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
        await this.replacement.replaceConfiguration({
          installRoot,
          stagingDirectory,
          previousInstallation: previous,
          targetInstallation: target,
          validateLive: async (live) => {
            context.setPhase('validating')
            await validateRegeneratedInstallation(
              live,
              request,
              managedCoreFiles,
            )
          },
        })
        stagingDirectory = undefined
      } finally {
        try {
          await cleanupGeneratedOperation(
            installRoot,
            generated,
            stagingDirectory,
          )
        } catch (error) {
          this.#reportCleanupError(asError(error))
        } finally {
          await release()
        }
      }
      return this.getStatus(request.appId)
    })
  }

  remove(appId: number): Promise<ColdClientStatus> {
    this.assertSupported()
    return this.operations.run('remove', appId, async (context) => {
      const previous = this.database.getColdClientInstallation(appId)
      if (!previous) return { status: 'not-configured' }
      const library = requireLibraryPath(this.database, appId)
      let installRoot: string
      try {
        installRoot = await realpath(library.installPath)
      } catch (error) {
        if (filesystemErrorCode(error) !== 'ENOENT') throw error
        if (
          !sameInstallation(
            this.database.getColdClientInstallation(appId),
            previous,
          )
        ) {
          throw new Error('ColdClient installation changed during removal')
        }
        context.beginReplacement()
        this.database.deleteColdClientInstallation(appId)
        this.database.clearUnusedInstallPath(appId)
        return { status: 'not-configured' }
      }
      const release = await this.#acquireLock(installRoot)
      try {
        if (
          !sameInstallation(
            this.database.getColdClientInstallation(appId),
            previous,
          )
        ) {
          throw new Error('ColdClient installation changed during removal')
        }
        const live = join(installRoot, '_ColdClient')
        let liveExists = true
        try {
          const metadata = await lstat(live)
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error('ColdClient directory is unsafe')
          }
        } catch (error) {
          if (filesystemErrorCode(error) !== 'ENOENT') throw error
          liveExists = false
        }
        context.beginReplacement()
        if (liveExists) await rm(live, { recursive: true })
        this.database.deleteColdClientInstallation(appId)
        this.database.clearUnusedInstallPath(appId)
        return { status: 'not-configured' }
      } finally {
        await release()
      }
    })
  }

  updateCore(appId: number): Promise<ColdClientStatus> {
    this.assertSupported()
    return this.operations.run('update-core', appId, async (context) => {
      const previous = this.database.getColdClientInstallation(appId)
      if (!previous) throw new Error('ColdClient is not configured')
      const library = requireInstalledLibrary(this.database, appId)
      const installRoot = await realpath(library.installPath)
      const activeGbe = this.dependencies.activeArtifact('gbe')
      if (!activeGbe || activeGbe.assetId === previous.gbeAssetId) {
        throw new Error('No ColdClient core update is available')
      }
      const gbe = await this.dependencies.validateArtifactSnapshot(
        'gbe',
        activeGbe.assetId,
      )
      const release = await this.#acquireLock(installRoot)
      let stagingDirectory: string | undefined
      try {
        const currentLibrary = requireInstalledLibrary(this.database, appId)
        if ((await realpath(currentLibrary.installPath)) !== installRoot) {
          throw new Error('The game install path changed during core update')
        }
        const current = this.database.getColdClientInstallation(appId)
        if (!sameInstallation(current, previous)) {
          throw new Error('ColdClient changed during core update')
        }
        if (
          this.dependencies.activeArtifact('gbe')?.assetId !== activeGbe.assetId
        ) {
          throw new Error(
            'The active GBE dependency changed during core update',
          )
        }
        await this.dependencies.validateArtifactSnapshot(
          'gbe',
          activeGbe.assetId,
        )
        context.signal.throwIfAborted()
        stagingDirectory = join(
          installRoot,
          `.Kalamata-coldclient-core-staging-${randomUUID()}`,
        )
        await copyGbeCore(
          join(gbe.directory, 'release', 'steamclient_experimental'),
          stagingDirectory,
          previous.loaderArchitecture,
          false,
        )
        const managedCoreFiles = await collectManagedCoreFiles(stagingDirectory)
        assertRequiredManagedCoreFiles(
          managedCoreFiles,
          previous.loaderArchitecture,
        )
        await assertCoreUpdateOwnership(
          join(installRoot, '_ColdClient'),
          previous.managedCoreFiles,
          managedCoreFiles,
        )
        const target: ColdClientInstallation = {
          ...previous,
          gbeAssetId: activeGbe.assetId,
          managedCoreFiles,
        }
        context.beginReplacement()
        await this.replacement.replaceCore({
          installRoot,
          stagingDirectory,
          previousInstallation: previous,
          targetInstallation: target,
          validateLive: async (live) => {
            context.setPhase('validating')
            await validateCoreUpdateLive(live, previous, target)
          },
        })
        stagingDirectory = undefined
      } finally {
        try {
          if (stagingDirectory) {
            await rm(stagingDirectory, { recursive: true, force: true })
          }
        } catch (error) {
          this.#reportCleanupError(asError(error))
        } finally {
          await release()
        }
      }
      return this.getStatus(appId)
    })
  }

  async getStatus(appId: number): Promise<ColdClientStatus> {
    if (this.#platform !== 'win32') {
      return { status: 'unsupported', reason: 'host-platform' }
    }
    const library = this.database.getLibraryEntry(appId)
    if (!library?.installPath) {
      return { status: 'unsupported', reason: 'not-installed' }
    }
    const installation = this.database.getColdClientInstallation(appId)
    if (!installation && this.database.getInstalls(appId).length === 0) {
      return { status: 'unsupported', reason: 'not-installed' }
    }
    if (!installation) return { status: 'not-configured' }
    try {
      if (
        await this.replacement.hasUnresolvedJournal(library.installPath, appId)
      ) {
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
    return this.replacement.recover(installRoot, appId, async () => {
      const installation = this.database.getColdClientInstallation(appId)
      if (!installation) {
        throw new Error('Committed ColdClient installation record is missing')
      }
      await validateInstalledCore(installRoot, installation)
    })
  }

  async hasRecoveryJournal(installRoot: string) {
    return hasColdClientRecoveryJournal(installRoot)
  }

  private assertSupported(): void {
    if (this.#platform !== 'win32') {
      throw new Error('ColdClient is available only on Windows')
    }
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
      await copyGbeCore(
        source,
        stagingDirectory,
        request.loaderArchitecture,
        true,
      )
      const settings = join(stagingDirectory, 'steam_settings')
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
      try {
        await cleanupGeneratedOperation(
          initialRoot,
          generated,
          stagingDirectory,
        )
      } catch (error) {
        this.#reportCleanupError(asError(error))
      } finally {
        await release()
      }
    }
  }
}

const CONFIG_TEMPORARY_DIRECTORY = '.Kalamata-coldclient-interfaces'

async function cleanupGeneratedOperation(
  installRoot: string,
  generated: GeneratedGseConfiguration,
  stagingDirectory: string | undefined,
): Promise<void> {
  if (stagingDirectory) {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
  await rm(generated.appDirectory, { recursive: true, force: true })
  await rm(join(installRoot, CONFIG_TEMPORARY_DIRECTORY), {
    recursive: true,
    force: true,
  })
}

function requireInstalledLibrary(database: ServiceDatabase, appId: number) {
  const library = database.getLibraryEntry(appId)
  if (!library?.installPath || database.getInstalls(appId).length === 0) {
    throw new Error('ColdClient setup requires an installed game')
  }
  return { installPath: library.installPath }
}

function requireLibraryPath(database: ServiceDatabase, appId: number) {
  const library = database.getLibraryEntry(appId)
  if (!library?.installPath) {
    throw new Error('ColdClient removal requires the original install path')
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

async function copyGbeCore(
  source: string,
  destination: string,
  architecture: 'x86' | 'x64',
  includeLoaderIni: boolean,
): Promise<void> {
  const files = [
    ...gbeSharedCoreFiles,
    `steamclient_loader_${architecture}.exe`,
    ...(includeLoaderIni ? ['ColdClientLoader.ini'] : []),
  ]
  await mkdir(destination)
  await mkdir(join(destination, 'extra_dlls'))
  await Promise.all(
    files.map((path) =>
      cp(
        join(source, ...path.split('/')),
        join(destination, ...path.split('/')),
        {
          errorOnExist: true,
          force: false,
        },
      ),
    ),
  )
}

async function validatePreparedInstallation(
  root: string,
  request: ColdClientSetupRequest,
): Promise<string[]> {
  await validateGeneratedSettings(
    join(root, 'steam_settings'),
    request.appId,
    request.steamApiRelativePath !== null,
  )
  await validateReviewedLoader(root, request)
  const files = await collectManagedCoreFiles(root)
  assertRequiredManagedCoreFiles(files, request.loaderArchitecture)
  return files
}

async function validateReviewedLoader(
  root: string,
  request: ColdClientSetupRequest,
): Promise<void> {
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
}

function switchedLoaderInventory(
  files: string[],
  architecture: 'x86' | 'x64',
): string[] {
  return [
    ...files.filter(
      (path) => !/^steamclient_loader_(?:x86|x64)\.exe$/iu.test(path),
    ),
    `steamclient_loader_${architecture}.exe`,
  ].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

async function validateRegeneratedInstallation(
  root: string,
  request: ColdClientSetupRequest,
  managedCoreFiles: string[],
): Promise<void> {
  await validateGeneratedSettings(
    join(root, 'steam_settings'),
    request.appId,
    request.steamApiRelativePath !== null,
  )
  await validateReviewedLoader(root, request)
  assertRequiredManagedCoreFiles(managedCoreFiles, request.loaderArchitecture)
  for (const path of managedCoreFiles) {
    await assertRegularFile(join(root, ...path.split('/')), path)
  }
  const unusedLoader =
    request.loaderArchitecture === 'x86'
      ? 'steamclient_loader_x64.exe'
      : 'steamclient_loader_x86.exe'
  if (await lstatOrNull(join(root, unusedLoader))) {
    throw new Error('ColdClient core contains the unused loader')
  }
}

async function validateGeneratedSettings(
  root: string,
  appId: number,
  requireInterfaces: boolean,
): Promise<void> {
  for (const path of requiredSettingsFiles) {
    await assertRegularFile(join(root, path), path)
  }
  if (requireInterfaces) {
    await assertRegularFile(
      join(root, 'steam_interfaces.txt'),
      'steam_interfaces.txt',
    )
  }
  if (
    (await readFile(join(root, 'steam_appid.txt'), 'utf8')).trim() !==
    String(appId)
  ) {
    throw new Error('Generated ColdClient settings contain a different AppID')
  }
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
  if (installation.steamApiRelativePath) {
    await assertRegularFile(
      join(root, 'steam_settings', 'steam_interfaces.txt'),
      'steam_interfaces.txt',
    )
  }
  for (const path of installation.managedCoreFiles) {
    await assertRegularFile(join(root, ...path.split('/')), path)
  }
}

async function validateCoreUpdateLive(
  root: string,
  previous: ColdClientInstallation,
  target: ColdClientInstallation,
): Promise<void> {
  for (const path of target.managedCoreFiles) {
    await assertRegularFile(join(root, ...path.split('/')), path)
  }
  const targetKeys = new Set(
    target.managedCoreFiles.map((path) => path.toLowerCase()),
  )
  for (const path of previous.managedCoreFiles) {
    if (targetKeys.has(path.toLowerCase())) continue
    if (await lstatOrNull(join(root, ...path.split('/')))) {
      throw new Error(`Removed ColdClient core file remains: ${path}`)
    }
  }
  await assertRegularFile(
    join(root, 'ColdClientLoader.ini'),
    'ColdClientLoader.ini',
  )
  for (const path of requiredSettingsFiles) {
    await assertRegularFile(join(root, 'steam_settings', path), path)
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`ColdClient installation is missing ${label}`)
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return null
    throw error
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

function applySavedConfiguration(
  draft: ColdClientSetupDraft,
  installation: ColdClientInstallation,
  gbe: ArtifactDescriptor,
): ColdClientSetupDraft {
  const selectedExecutable = draft.executableCandidates.includes(
    installation.executableRelativePath,
  )
    ? installation.executableRelativePath
    : null
  const selectedSteamApi =
    installation.steamApiRelativePath === null
      ? null
      : draft.steamApiCandidates.includes(installation.steamApiRelativePath)
        ? installation.steamApiRelativePath
        : null
  const warnings: ColdClientSetupWarning[] = draft.warnings.filter(
    (warning) =>
      warning !== 'multiple-shipping-executables' &&
      warning !== 'executable-choice-required' &&
      warning !== 'steam-api-choice-required' &&
      warning !== 'existing-cold-client-will-be-replaced',
  )
  if (!selectedExecutable) warnings.push('executable-choice-required')
  if (draft.steamApiCandidates.length > 0 && !selectedSteamApi) {
    warnings.push('steam-api-choice-required')
  }
  const launchSource = draft.launchOptions.some(
    ({ key }) => key === installation.launchArgumentSource,
  )
    ? installation.launchArgumentSource
    : null
  return {
    ...draft,
    selectedExecutableRelativePath: selectedExecutable,
    selectedSteamApiRelativePath: selectedSteamApi,
    loaderArchitecture: selectedSteamApi
      ? selectedSteamApi.toLowerCase().endsWith('steam_api.dll')
        ? 'x86'
        : 'x64'
      : installation.loaderArchitecture,
    launchArguments: installation.launchArguments,
    launchArgumentSource: launchSource,
    warnings,
    gbe: { assetId: gbe.assetId, tag: gbe.tag },
  }
}

function sameInstallation(
  left: ColdClientInstallation | null,
  right: ColdClientInstallation | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
