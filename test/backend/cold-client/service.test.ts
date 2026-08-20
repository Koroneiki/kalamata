import { afterEach, expect, test } from 'bun:test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ColdClientMutationMutex } from '../../../src/backend/cold-client/mutation-mutex.ts'
import { ColdClientOperationCoordinator } from '../../../src/backend/cold-client/operation-coordinator.ts'
import { ColdClientReplacementService } from '../../../src/backend/cold-client/replacement.ts'
import { ColdClientService } from '../../../src/backend/cold-client/service.ts'
import type { ArtifactDescriptor } from '../../../src/backend/cold-client/dependency-schema.ts'
import type {
  ColdClientInstallation,
  ColdClientSetupDraft,
  ColdClientSetupRequest,
} from '../../../src/types/cold-client.ts'
import { removeTemporaryDirectory } from '../../helpers/filesystem.ts'

let root: string | undefined

afterEach(async () => {
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

test('configures a complete reviewed ColdClient installation', async () => {
  const fixture = await createFixture()
  const service = createService(fixture)

  const status = await service.configure(fixture.request)

  expect(status).toMatchObject({
    status: 'configured',
    installedGbeTag: 'gbe-v1',
    installedGseTag: 'gse-v1',
    recommendationReasons: [],
  })
  const live = join(fixture.installRoot, '_ColdClient')
  expect(
    await readFile(join(live, 'extra_dlls', 'nested', 'extra.dll'), 'utf8'),
  ).toBe('extra')
  expect(
    await readFile(join(live, 'steam_settings', 'configs.overlay.ini'), 'utf8'),
  ).toBe('generated-overlay-default')
  expect(
    await readFile(
      join(live, 'steam_settings', 'steam_interfaces.txt'),
      'utf8',
    ),
  ).toBe('interfaces')
  await expect(
    access(join(live, 'steamclient_loader_x86.exe')),
  ).rejects.toThrow()
  await expect(
    access(join(live, 'steamclient_loader_x64.exe')),
  ).resolves.toBeNull()
  expect(await readFile(join(live, 'ColdClientLoader.ini'), 'utf8')).toContain(
    'Exe=..\\Game\\Binaries\\Game.exe\r\n',
  )
  expect(fixture.database.current).toMatchObject({
    appId: 10,
    loaderArchitecture: 'x64',
    steamApiRelativePath: 'Game/Binaries/steam_api64.dll',
    gbeAssetId: 101,
    gseAssetId: 201,
  })
  expect(fixture.database.current?.managedCoreFiles).toContain(
    'extra_dlls/nested/extra.dll',
  )
})

test('reports configured installations with missing interfaces as invalid', async () => {
  const fixture = await createFixture()
  const service = createService(fixture)
  await service.configure(fixture.request)
  await rm(
    join(
      fixture.installRoot,
      '_ColdClient',
      'steam_settings',
      'steam_interfaces.txt',
    ),
  )

  await expect(service.getStatus(10)).resolves.toMatchObject({
    status: 'invalid',
  })
})

test('releases the install-path lock when post-commit cleanup fails', async () => {
  const fixture = await createFixture()
  fixture.generatedApp = '\0'
  let released = false
  const cleanupErrors: Error[] = []
  const service = createService(fixture, () => fixture.draft, {
    acquireLock: async () => async () => {
      released = true
    },
    reportCleanupError: (error) => cleanupErrors.push(error),
  })

  await expect(service.configure(fixture.request)).resolves.toMatchObject({
    status: 'configured',
  })
  expect(released).toBe(true)
  expect(cleanupErrors).toHaveLength(1)
})

test('rejects a dependency change after review before replacing game files', async () => {
  const fixture = await createFixture()
  let inspections = 0
  const service = createService(fixture, () => {
    inspections += 1
    return inspections === 1
      ? fixture.draft
      : { ...fixture.draft, gbe: { assetId: 999, tag: 'changed' } }
  })

  await expect(service.configure(fixture.request)).rejects.toThrow(
    'dependencies changed',
  )

  expect(
    await readFile(join(fixture.installRoot, '_ColdClient', 'old.txt'), 'utf8'),
  ).toBe('old')
  expect(fixture.database.current).toBeNull()
})

test('regenerates only steam_settings and preserves the configured core', async () => {
  const fixture = await createFixture()
  const service = createService(fixture)
  await service.configure(fixture.request)
  const live = join(fixture.installRoot, '_ColdClient')
  const loaderBefore = await readFile(join(live, 'ColdClientLoader.ini'))
  const coreBefore = await readFile(join(live, 'steamclient64.dll'))
  await writeFile(
    join(live, 'steam_settings', 'custom-user-file.txt'),
    'remove me',
  )
  await writeGeneratedSettings(fixture.generatedSettings, 'regenerated-overlay')

  const status = await service.regenerate(10)

  expect(status).toMatchObject({
    status: 'configured',
    recommendationReasons: [],
  })
  expect(await readFile(join(live, 'ColdClientLoader.ini'))).toEqual(
    loaderBefore,
  )
  expect(await readFile(join(live, 'steamclient64.dll'))).toEqual(coreBefore)
  expect(
    await readFile(join(live, 'steam_settings', 'configs.overlay.ini'), 'utf8'),
  ).toBe('regenerated-overlay')
  await expect(
    access(join(live, 'steam_settings', 'custom-user-file.txt')),
  ).rejects.toThrow()
  expect(fixture.database.current?.configuredAt).toBe(3000)
})

test('updates only managed core files and preserves custom configuration', async () => {
  const fixture = await createFixture()
  const service = createService(fixture)
  await service.configure(fixture.request)
  const live = join(fixture.installRoot, '_ColdClient')
  const loaderBefore = await readFile(join(live, 'ColdClientLoader.ini'))
  const settingsBefore = await readFile(
    join(live, 'steam_settings', 'configs.overlay.ini'),
  )
  const previousFingerprint =
    fixture.database.current?.generatedDepotFingerprint
  await mkdir(join(live, 'extra_dlls', 'custom'), { recursive: true })
  await writeFile(join(live, 'extra_dlls', 'custom', 'user.dll'), 'custom')
  await writeFile(join(live, 'steamclient.dll'), 'damaged')
  fixture.activateGbeV2()

  const status = await service.updateCore(10)

  expect(status).toMatchObject({
    status: 'configured',
    installedGbeTag: 'gbe-v2',
    coreUpdateAvailable: false,
  })
  expect(await readFile(join(live, 'steamclient.dll'), 'utf8')).toBe(
    'client x86 v2',
  )
  expect(await readFile(join(live, 'new-core.dll'), 'utf8')).toBe('new core')
  await expect(access(join(live, 'GameOverlayRenderer.dll'))).rejects.toThrow()
  expect(
    await readFile(join(live, 'extra_dlls', 'custom', 'user.dll'), 'utf8'),
  ).toBe('custom')
  expect(await readFile(join(live, 'ColdClientLoader.ini'))).toEqual(
    loaderBefore,
  )
  expect(
    await readFile(join(live, 'steam_settings', 'configs.overlay.ini')),
  ).toEqual(settingsBefore)
  expect(fixture.database.current).toMatchObject({
    gbeAssetId: 102,
    gseAssetId: 201,
    generatedDepotFingerprint: previousFingerprint,
    configuredAt: 3000,
  })
})

function createService(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  inspect: () => ColdClientSetupDraft = () => fixture.draft,
  options: {
    acquireLock?: () => Promise<() => Promise<void>>
    reportCleanupError?: (error: Error) => void
  } = {},
): ColdClientService {
  const operations = new ColdClientOperationCoordinator(
    new ColdClientMutationMutex(),
  )
  const replacement = new ColdClientReplacementService(fixture.database, {
    acquireLock: async () => async () => {},
  })
  return new ColdClientService(
    fixture.database,
    fixture.dependencies,
    { inspect: async () => inspect() },
    {
      generate: async () => ({
        gseAssetId: 201,
        appDirectory: fixture.generatedApp,
        steamSettingsDirectory: fixture.generatedSettings,
      }),
    },
    {
      generate: async (_executable, _dll, _temporary, destination) => {
        await writeFile(destination, 'interfaces')
      },
    },
    operations,
    replacement,
    {
      platform: 'win32',
      now: () => 3000,
      acquireLock: options.acquireLock ?? (async () => async () => {}),
      reportCleanupError: options.reportCleanupError,
    },
  )
}

async function createFixture() {
  root = await mkdtemp(join(tmpdir(), 'kalamata-coldclient-service-'))
  const installRoot = join(root, 'game')
  const gbeRoot = join(root, 'gbe')
  const gbeV2Root = join(root, 'gbe-v2')
  const core = join(gbeRoot, 'release', 'steamclient_experimental')
  const coreV2 = join(gbeV2Root, 'release', 'steamclient_experimental')
  const generatedApp = join(root, 'gse-output', '10')
  const generatedSettings = join(generatedApp, 'steam_settings')
  await Promise.all([
    mkdir(join(installRoot, 'Game', 'Binaries'), { recursive: true }),
    mkdir(join(installRoot, '_ColdClient'), { recursive: true }),
    mkdir(join(core, 'extra_dlls', 'nested'), { recursive: true }),
    mkdir(join(coreV2, 'extra_dlls', 'nested'), { recursive: true }),
    mkdir(join(gbeRoot, 'release', 'tools', 'generate_interfaces'), {
      recursive: true,
    }),
    mkdir(generatedSettings, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(installRoot, 'Game', 'Binaries', 'Game.exe'), 'game'),
    writeFile(
      join(installRoot, 'Game', 'Binaries', 'steam_api64.dll'),
      'steam api',
    ),
    writeFile(join(installRoot, '_ColdClient', 'old.txt'), 'old'),
    writeFile(join(core, 'ColdClientLoader.ini'), loaderIni()),
    writeFile(join(core, 'steamclient.dll'), 'client x86'),
    writeFile(join(core, 'steamclient64.dll'), 'client x64'),
    writeFile(join(core, 'steamclient_loader_x86.exe'), 'loader x86'),
    writeFile(join(core, 'steamclient_loader_x64.exe'), 'loader x64'),
    writeFile(join(core, 'GameOverlayRenderer.dll'), 'overlay x86'),
    writeFile(join(core, 'GameOverlayRenderer64.dll'), 'overlay x64'),
    writeFile(join(core, 'extra_dlls', 'nested', 'extra.dll'), 'extra'),
    writeFile(join(coreV2, 'ColdClientLoader.ini'), loaderIni()),
    writeFile(join(coreV2, 'steamclient.dll'), 'client x86 v2'),
    writeFile(join(coreV2, 'steamclient64.dll'), 'client x64 v2'),
    writeFile(join(coreV2, 'steamclient_loader_x86.exe'), 'loader x86 v2'),
    writeFile(join(coreV2, 'steamclient_loader_x64.exe'), 'loader x64 v2'),
    writeFile(join(coreV2, 'new-core.dll'), 'new core'),
    writeFile(join(coreV2, 'extra_dlls', 'nested', 'extra.dll'), 'extra v2'),
    writeFile(
      join(
        gbeRoot,
        'release',
        'tools',
        'generate_interfaces',
        'generate_interfaces_x64.exe',
      ),
      'generator',
    ),
  ])
  await writeGeneratedSettings(generatedSettings, 'generated-overlay-default')

  const gbe = artifact('gbe', 101, 'gbe-v1')
  const gbeV2 = artifact('gbe', 102, 'gbe-v2')
  const gse = artifact('gse', 201, 'gse-v1')
  const artifacts = new Map([
    ['gbe:101', gbe],
    ['gbe:102', gbeV2],
    ['gse:201', gse],
  ])
  let activeGbe = gbe
  const dependencies = {
    activeArtifact: (dependencyId: 'gbe' | 'gse') =>
      dependencyId === 'gbe' ? activeGbe : gse,
    artifact: (dependencyId: 'gbe' | 'gse', assetId: number) =>
      artifacts.get(`${dependencyId}:${assetId}`) ?? null,
    validateArtifactSnapshot: async (
      dependencyId: 'gbe' | 'gse',
      assetId: number,
    ) => ({
      descriptor: artifacts.get(`${dependencyId}:${assetId}`)!,
      directory:
        dependencyId === 'gse'
          ? join(root!, 'gse')
          : assetId === 102
            ? gbeV2Root
            : gbeRoot,
    }),
  }
  const database = new FakeDatabase(installRoot)
  const draft: ColdClientSetupDraft = {
    appId: 10,
    targetRelativePath: '_ColdClient',
    executableCandidates: ['Game/Binaries/Game.exe'],
    selectedExecutableRelativePath: 'Game/Binaries/Game.exe',
    executableDetectionSource: 'sole-executable',
    steamApiCandidates: ['Game/Binaries/steam_api64.dll'],
    selectedSteamApiRelativePath: 'Game/Binaries/steam_api64.dll',
    steamApiDetectionSource: 'binary-directory',
    loaderArchitecture: 'x64',
    launchOptions: [
      {
        key: '0',
        executable: 'Game/Binaries/Game.exe',
        matchedExecutableRelativePath: 'Game/Binaries/Game.exe',
        arguments: '-windowed',
        description: null,
      },
    ],
    launchArguments: '-windowed',
    launchArgumentSource: '0',
    warnings: ['existing-cold-client-will-be-replaced'],
    existingColdClient: true,
    gbe: { assetId: 101, tag: 'gbe-v1' },
    gse: { assetId: 201, tag: 'gse-v1' },
  }
  const request: ColdClientSetupRequest = {
    appId: 10,
    executableRelativePath: 'Game/Binaries/Game.exe',
    steamApiRelativePath: 'Game/Binaries/steam_api64.dll',
    loaderArchitecture: 'x64',
    launchArguments: '-windowed',
    launchArgumentSource: '0',
    gbeAssetId: 101,
    gseAssetId: 201,
  }
  return {
    installRoot,
    generatedApp,
    generatedSettings,
    dependencies,
    database,
    draft,
    request,
    activateGbeV2: () => {
      activeGbe = gbeV2
    },
  }
}

class FakeDatabase {
  current: ColdClientInstallation | null = null
  installs = [{ depotId: 11, installedManifestId: '1000' }]

  constructor(private readonly installPath: string) {}

  getLibraryEntry() {
    return { installPath: this.installPath }
  }

  getInstalls() {
    return this.installs
  }

  getColdClientInstallation() {
    return this.current
  }

  replaceColdClientInstallationIfCurrent(
    previous: ColdClientInstallation | null,
    target: ColdClientInstallation,
  ) {
    if (JSON.stringify(previous) !== JSON.stringify(this.current)) {
      throw new Error('record changed')
    }
    this.current = target
  }
}

function artifact(
  dependencyId: 'gbe' | 'gse',
  assetId: number,
  tag: string,
): ArtifactDescriptor {
  return {
    dependencyId,
    repository: 'owner/repository',
    assetId,
    releaseId: assetId,
    tag,
    publishedAt: '2026-08-19T00:00:00.000Z',
    assetName: 'asset.7z',
    sourceUrl:
      'https://github.com/owner/repository/releases/download/v1/asset.7z',
    sha256: 'a'.repeat(64),
    verificationMode: 'github-digest',
    validatedAt: 1,
  }
}

function loaderIni(): string {
  return [
    '[SteamClient]',
    'Exe=old.exe',
    'ExeCommandLine=',
    'AppId=',
    '[Injection]',
    'DllsToInjectFolder=',
    '',
  ].join('\r\n')
}

async function writeGeneratedSettings(
  directory: string,
  overlay: string,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await Promise.all([
    ...['configs.app.ini', 'configs.main.ini', 'configs.user.ini'].map((name) =>
      writeFile(join(directory, name), name),
    ),
    writeFile(join(directory, 'configs.overlay.ini'), overlay),
    writeFile(join(directory, 'steam_appid.txt'), '10'),
  ])
}
