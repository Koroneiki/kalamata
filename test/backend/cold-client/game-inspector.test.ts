import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ColdClientGameInspector } from '../../../src/backend/cold-client/game-inspector.ts'
import type { ProductInfo } from '../../../src/backend/steam/types.ts'
import { removeTemporaryDirectory } from '../../helpers/filesystem.ts'

let root: string | undefined

afterEach(async () => {
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

test('rejects unsupported hosts and games without installed depots', async () => {
  let productRequests = 0
  const unsupported = inspector({
    platform: 'darwin',
    installPath: '/unused',
    installs: [{}],
    onProductRequest: () => productRequests++,
  })
  await expect(unsupported.inspect(10)).rejects.toThrow('only on Windows')
  expect(productRequests).toBe(0)

  const notInstalled = inspector({
    installPath: 'C:/reserved',
    installs: [],
    onProductRequest: () => productRequests++,
  })
  await expect(notInstalled.inspect(10)).rejects.toThrow('installed game')
  expect(productRequests).toBe(0)
})

test('prefers a unique Shipping executable and a Steam API DLL in Binaries', async () => {
  const directory = await gameDirectory()
  await portableExecutable(directory, 'Alpha.exe', 'x86')
  await portableExecutable(
    directory,
    'Game/Binaries/Win64/MyGame-Win64-Shipping.exe',
    'x64',
  )
  await file(directory, 'Game/Binaries/Win64/steam_api.dll')
  await file(directory, 'Other/steam_api64.dll')

  const draft = await inspector({
    installPath: directory,
    launch: {
      '0': {
        executable: 'Alpha.exe',
        arguments: '-windowed',
        description: 'Standard',
      },
    },
  }).inspect(10)

  expect(draft.selectedExecutableRelativePath).toBe(
    'Game/Binaries/Win64/MyGame-Win64-Shipping.exe',
  )
  expect(draft.executableDetectionSource).toBe('shipping-executable')
  expect(draft.executableArchitectures).toEqual({
    'Alpha.exe': 'x86',
    'Game/Binaries/Win64/MyGame-Win64-Shipping.exe': 'x64',
  })
  expect(draft.selectedSteamApiRelativePath).toBe(
    'Game/Binaries/Win64/steam_api.dll',
  )
  expect(draft.loaderArchitecture).toBe('x86')
  expect(draft.launchArguments).toBe('-windowed')
  expect(draft.warnings).toContain('launch-executable-mismatch')
  expect(draft.gbe).toEqual({ assetId: 201, tag: 'gbe-one' })
  expect(draft.gse).toEqual({ assetId: 301, tag: 'gse-one' })
})

test('leaves multiple Shipping executables and ambiguous DLLs unresolved', async () => {
  const directory = await gameDirectory()
  await file(directory, 'A/GameShipping.exe')
  await file(directory, 'B/OtherShipping.exe')
  await file(directory, 'Launcher.exe')
  await file(directory, 'A/steam_api.dll')
  await file(directory, 'B/steam_api64.dll')

  const draft = await inspector({ installPath: directory }).inspect(10)

  expect(draft.selectedExecutableRelativePath).toBeNull()
  expect(draft.executableCandidates).toEqual([
    'A/GameShipping.exe',
    'B/OtherShipping.exe',
  ])
  expect(draft.executableArchitectures).toEqual({
    'A/GameShipping.exe': null,
    'B/OtherShipping.exe': null,
  })
  expect(draft.selectedSteamApiRelativePath).toBeNull()
  expect(draft.loaderArchitecture).toBe('x64')
  expect(draft.warnings).toEqual([
    'multiple-shipping-executables',
    'steam-api-choice-required',
  ])
})

test('uses numbered default Windows launch metadata deterministically', async () => {
  const directory = await gameDirectory()
  await file(directory, 'Exact/Game.exe')
  await file(directory, 'Other/Binaries/Game.exe')
  await file(directory, 'Fallback.exe')

  const draft = await inspector({
    installPath: directory,
    launch: {
      '10': {
        executable: 'Fallback.exe',
        arguments: '-later',
      },
      '2': {
        executable: 'Exact\\Game.exe',
        arguments: '',
        description: 'Default Windows',
        config: { oslist: 'windows,linux' },
      },
      '3': {
        executable: 'Fallback.exe',
        arguments: '-first-arguments',
      },
      '4': { executable: '../Game.exe' },
      '5': { executable: 'C:\\Games\\Game.exe' },
      '1': {
        executable: 'Fallback.exe',
        type: 'server',
      },
      '0': {
        executable: 'Fallback.exe',
        config: { oslist: 'linux' },
      },
    },
  }).inspect(10)

  expect(draft.launchOptions.map(({ key }) => key)).toEqual(['2', '3', '10'])
  expect(draft.launchOptions[0]).toMatchObject({
    executable: 'Exact/Game.exe',
    matchedExecutableRelativePath: 'Other/Binaries/Game.exe',
  })
  expect(draft.selectedExecutableRelativePath).toBe('Other/Binaries/Game.exe')
  expect(draft.launchArgumentSource).toBe('3')
  expect(draft.launchArguments).toBe('-first-arguments')
})

test('keeps arguments from an eligible entry whose executable is absent', async () => {
  const directory = await gameDirectory()
  await file(directory, 'Game.exe')
  await file(directory, 'Other.exe')

  const draft = await inspector({
    installPath: directory,
    launch: {
      '0': { executable: 'Missing.exe', arguments: '-from-metadata' },
      '1': { executable: 'Game.exe', arguments: '-later' },
    },
  }).inspect(10)

  expect(draft.selectedExecutableRelativePath).toBe('Game.exe')
  expect(draft.launchArgumentSource).toBe('0')
  expect(draft.launchArguments).toBe('-from-metadata')
  expect(draft.launchOptions[0]).toMatchObject({
    executable: 'Missing.exe',
    matchedExecutableRelativePath: null,
  })
  expect(draft.warnings).toContain('launch-executable-mismatch')
})

test('falls back to x64 without a Steam API DLL and detects replacement', async () => {
  const directory = await gameDirectory()
  await file(directory, 'Spaced ünicode/Game.exe')
  await mkdir(join(directory, '_ColdClient'))

  const draft = await inspector({ installPath: directory }).inspect(10)

  expect(draft.selectedExecutableRelativePath).toBe('Spaced ünicode/Game.exe')
  expect(draft.loaderArchitecture).toBe('x64')
  expect(draft.warnings).toEqual([
    'x64-assumed-without-steam-api',
    'existing-cold-client-will-be-replaced',
  ])
})

test('does not inspect state, staging, ColdClient, or symlinked trees', async () => {
  const directory = await gameDirectory()
  const outside = await mkdtemp(join(tmpdir(), 'cold-client-outside-'))
  await file(directory, 'Valid.exe')
  await file(directory, '.Kalamata/Hidden.exe')
  await file(directory, '.Kalamata-coldclient-stage/Staged.exe')
  await file(directory, '_ColdClient/Installed.exe')
  await file(outside, 'Linked.exe')
  await symlink(outside, join(directory, 'Linked'))

  const draft = await inspector({ installPath: directory }).inspect(10)

  expect(draft.executableCandidates).toEqual(['Valid.exe'])
  await removeTemporaryDirectory(outside)
})

interface InspectorFixture {
  platform?: NodeJS.Platform
  installPath: string | null
  installs?: unknown[]
  launch?: Record<string, unknown>
  onProductRequest?: () => void
}

function inspector(fixture: InspectorFixture): ColdClientGameInspector {
  return new ColdClientGameInspector(
    {
      getLibraryEntry: () =>
        fixture.installPath === null
          ? null
          : { installPath: fixture.installPath },
      getInstalls: () => fixture.installs ?? [{}],
    },
    {
      getProductInfo: async () => {
        fixture.onProductRequest?.()
        return {
          appId: 10,
          changenumber: 1,
          missingToken: false,
          appinfo: {
            common: { name: 'Fixture', type: 'game' },
            config: { installdir: 'Fixture', launch: fixture.launch },
            depots: {},
          },
        } as ProductInfo
      },
    },
    {
      activeArtifact: (dependencyId) => ({
        dependencyId,
        repository: 'owner/repository',
        assetId: dependencyId === 'gbe' ? 201 : 301,
        releaseId: dependencyId === 'gbe' ? 200 : 300,
        tag: dependencyId === 'gbe' ? 'gbe-one' : 'gse-one',
        publishedAt: '2026-08-20T10:00:00Z',
        assetName: 'dependency.7z',
        sourceUrl: 'https://example.com/dependency.7z',
        sha256: 'a'.repeat(64),
        verificationMode: 'github-digest',
        validatedAt: 1,
      }),
    },
    { platform: fixture.platform ?? 'win32' },
  )
}

async function gameDirectory(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'cold-client-game-'))
  return root
}

async function file(directory: string, relativePath: string): Promise<void> {
  const path = join(directory, ...relativePath.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'fixture')
}

async function portableExecutable(
  directory: string,
  relativePath: string,
  architecture: 'x86' | 'x64',
): Promise<void> {
  const contents = Buffer.alloc(134)
  contents.writeUInt16LE(0x5a4d, 0)
  contents.writeUInt32LE(128, 0x3c)
  contents.writeUInt32LE(0x4550, 128)
  contents.writeUInt16LE(architecture === 'x86' ? 0x014c : 0x8664, 132)
  const path = join(directory, ...relativePath.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
}
