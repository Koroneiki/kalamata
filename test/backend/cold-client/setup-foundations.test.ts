import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coldClientDepotFingerprint } from '../../../src/backend/cold-client/depot-fingerprint.ts'
import { updateColdClientLoaderIni } from '../../../src/backend/cold-client/ini.ts'
import { ColdClientInterfaceGenerator } from '../../../src/backend/cold-client/interface-generator.ts'
import {
  assertRequiredManagedCoreFiles,
  collectManagedCoreFiles,
} from '../../../src/backend/cold-client/managed-inventory.ts'
import { removeTemporaryDirectory } from '../../helpers/filesystem.ts'

let root: string | undefined

afterEach(async () => {
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

test('fingerprints installed depots in depot ID order', () => {
  expect(
    coldClientDepotFingerprint([
      { depotId: 20, installedManifestId: '300' },
      { depotId: 10, installedManifestId: '200' },
    ]),
  ).toBe('b1163520d7a9bf78f61417bbeebaa21c58b58990eaa4394075ef3c9fc05429ad')
})

describe('ColdClient loader INI', () => {
  test('updates required values while preserving UTF-16LE and CRLF', async () => {
    root = await mkdtemp(join(tmpdir(), 'kalamata-coldclient-ini-'))
    const path = join(root, 'ColdClientLoader.ini')
    const source = [
      '[SteamClient]',
      'Exe=old.exe',
      'ExeCommandLine=',
      'AppId=',
      '',
      '[Injection]',
      'DllsToInjectFolder=',
      '# unchanged',
      '',
    ].join('\r\n')
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(source, 'utf16le'),
      ]),
    )

    await updateColdClientLoaderIni(path, {
      executableRelativePath: 'Game Files/Binaries/Game.exe',
      appId: 10,
      launchArguments: '-windowed "wide screen"',
    })

    const result = await readFile(path)
    expect(result.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    const text = result.subarray(2).toString('utf16le')
    expect(text).toContain('Exe=..\\Game Files\\Binaries\\Game.exe\r\n')
    expect(text).toContain('ExeCommandLine=-windowed "wide screen"\r\n')
    expect(text).toContain('AppId=10\r\n')
    expect(text).toContain('DllsToInjectFolder=extra_dlls\r\n')
    expect(text).toEndWith('# unchanged\r\n')
    expect(text).not.toContain('\n# unchanged\n')
  })

  test('rejects line injection and malformed templates', async () => {
    root = await mkdtemp(join(tmpdir(), 'kalamata-coldclient-ini-'))
    const path = join(root, 'ColdClientLoader.ini')
    await writeFile(
      path,
      'Exe=x\nExeCommandLine=\nAppId=\nDllsToInjectFolder=\n',
    )
    await expect(
      updateColdClientLoaderIni(path, {
        executableRelativePath: 'Game.exe',
        appId: 10,
        launchArguments: '-safe\nAppId=20',
      }),
    ).rejects.toThrow('one line')

    await writeFile(path, 'Exe=x\nExeCommandLine=\nAppId=\n')
    await expect(
      updateColdClientLoaderIni(path, {
        executableRelativePath: 'Game.exe',
        appId: 10,
        launchArguments: '',
      }),
    ).rejects.toThrow('DllsToInjectFolder')
  })
})

describe('managed core inventory', () => {
  test('records regular core files but excludes settings and loader INI', async () => {
    root = await mkdtemp(join(tmpdir(), 'kalamata-coldclient-core-'))
    await writeCoreFixture(root)

    const files = await collectManagedCoreFiles(root)

    expect(files).toEqual([
      'extra_dlls/nested/extra.dll',
      'steamclient.dll',
      'steamclient64.dll',
      'steamclient_loader_x64.exe',
    ])
    expect(() => assertRequiredManagedCoreFiles(files, 'x64')).not.toThrow()
  })

  test('rejects links and the unused loader', async () => {
    root = await mkdtemp(join(tmpdir(), 'kalamata-coldclient-core-'))
    await writeCoreFixture(root)
    await symlink(
      join(root, 'steamclient.dll'),
      join(root, 'extra_dlls', 'linked.dll'),
    )
    await expect(collectManagedCoreFiles(root)).rejects.toThrow('link')

    expect(() =>
      assertRequiredManagedCoreFiles(
        [
          'steamclient.dll',
          'steamclient64.dll',
          'steamclient_loader_x64.exe',
          'steamclient_loader_x86.exe',
          'extra_dlls/extra.dll',
        ],
        'x64',
      ),
    ).toThrow('unused loader')
  })
})

test('runs the interface generator in an isolated directory', async () => {
  root = await mkdtemp(join(tmpdir(), 'kalamata-coldclient-interfaces-'))
  const destination = join(root, 'steam_settings', 'steam_interfaces.txt')
  const calls: string[][] = []
  const generator = new ColdClientInterfaceGenerator(
    async (executable, steamApiPath, workingDirectory) => {
      calls.push([executable, steamApiPath, workingDirectory])
      await writeFile(
        join(workingDirectory, 'steam_interfaces.txt'),
        'SteamClient020',
      )
      return 0
    },
  )

  await generator.generate(
    'C:\\gbe\\generate_interfaces_x64.exe',
    'C:\\game\\steam_api.dll',
    join(root, 'temporary'),
    destination,
    new AbortController().signal,
  )

  expect(calls).toHaveLength(1)
  expect(calls[0]?.slice(0, 2)).toEqual([
    'C:\\gbe\\generate_interfaces_x64.exe',
    'C:\\game\\steam_api.dll',
  ])
  expect(await readFile(destination, 'utf8')).toBe('SteamClient020')
})

async function writeCoreFixture(directory: string): Promise<void> {
  await mkdir(join(directory, 'extra_dlls', 'nested'), { recursive: true })
  await mkdir(join(directory, 'steam_settings'), { recursive: true })
  await Promise.all([
    writeFile(join(directory, 'ColdClientLoader.ini'), 'template'),
    writeFile(join(directory, 'steamclient.dll'), 'x86'),
    writeFile(join(directory, 'steamclient64.dll'), 'x64'),
    writeFile(join(directory, 'steamclient_loader_x64.exe'), 'loader'),
    writeFile(join(directory, 'extra_dlls', 'nested', 'extra.dll'), 'extra'),
    writeFile(
      join(directory, 'steam_settings', 'configs.main.ini'),
      'settings',
    ),
  ])
}
