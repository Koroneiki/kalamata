import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type SteamUser from 'steam-user'
import { InstallDirectoryService } from '../../src/backend/downloads/install-directory.ts'
import { canonicalizeInstallDirectory } from '../../src/db/validation.ts'
import { removeTemporaryDirectory } from '../helpers/filesystem.ts'

let root: string
let games: string
let historyPath: string
let selection: string | null
let openedAt: string | null | undefined

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'kalamata-install-directory-')),
  )
  games = join(root, 'Games')
  historyPath = join(root, 'history', 'install-directory.json')
  await mkdir(games)
  selection = games
  openedAt = undefined
})

afterEach(async () => {
  await removeTemporaryDirectory(root)
})

function service(installdir?: unknown) {
  return new InstallDirectoryService(
    root,
    {
      getProductInfo: async (appId) => ({
        appId,
        changenumber: 1,
        missingToken: false,
        // SAFETY: deliberately partial or malformed provider data exercises our boundary.
        appinfo: { config: { installdir } } as SteamUser.AppInfoContent,
      }),
    },
    async (startingFolder) => {
      openedAt = startingFolder
      return selection
    },
  )
}

test('requires a manual choice without history and creates no game folder in previews', async () => {
  const directory = service('First Game')
  expect(await directory.get(10)).toBeNull()
  expect(await Bun.file(historyPath).exists()).toBe(false)
  expect(await directory.select(10)).toBe(join(games, 'First Game'))
  expect(openedAt).toBeNull()
  expect(JSON.parse(await readFile(historyPath, 'utf8'))).toEqual({
    baseDirectory: games,
  })
  expect(await readdir(games)).toEqual([])
})

test('restores only the base folder across restarts and successive games', async () => {
  await service('First Game').select(10)
  const restarted = service('Second Game')
  expect(await restarted.get(20)).toBe(join(games, 'Second Game'))
  expect(await restarted.select(20)).toBe(join(games, 'Second Game'))
  expect(openedAt).toBe(games)
  expect(await service('Third Game').get(30)).toBe(join(games, 'Third Game'))
  expect(await readdir(games)).toEqual([])
})

test('a confirmed choice is remembered even if app metadata is temporarily unavailable', async () => {
  const directory = new InstallDirectoryService(
    root,
    {
      getProductInfo: async () => {
        throw new Error('Offline')
      },
    },
    async () => games,
  )
  await expect(directory.select(10)).rejects.toThrow('Offline')
  expect(await service('Next Game').get(20)).toBe(join(games, 'Next Game'))
})

test('cancelling preserves the confirmed base folder and a new choice replaces it', async () => {
  await service('First Game').select(10)
  selection = null
  expect(await service('Second Game').select(20)).toBeNull()
  expect(await service('Second Game').get(20)).toBe(join(games, 'Second Game'))
  const other = join(root, 'Other Games')
  await mkdir(other)
  selection = other
  expect(await service('Second Game').select(20)).toBe(
    join(other, 'Second Game'),
  )
  expect(openedAt).toBe(games)
  expect(await service('Third Game').get(30)).toBe(join(other, 'Third Game'))
})

test('unavailable or damaged history requires a fresh choice instead of a fallback', async () => {
  await service('Game').select(10)
  await rm(games, { recursive: true })
  expect(await service('Game').get(10)).toBeNull()
  selection = null
  await service('Game').select(10)
  expect(openedAt).toBeNull()
  await writeFile(historyPath, '{broken')
  expect(await service('Game').get(10)).toBeNull()
})

test.each([
  undefined,
  '',
  '.',
  '..',
  '../escape',
  'nested/game',
  'nested\\game',
  'C:\\Game',
  '/outside',
  'CON',
  'NUL.txt',
  'trailing.',
  123,
])(
  'uses a safe app-specific folder for invalid installdir %j',
  async (name) => {
    expect(await service(name).select(10)).toBe(join(games, 'App 10'))
  },
)

test('validates a future game folder without creating it and preserves symlink checks', async () => {
  const alias = join(root, 'Games Alias')
  await symlink(games, alias)
  const target = join(alias, 'New Game')
  expect((await canonicalizeInstallDirectory(target, true)).path).toBe(
    join(games, 'New Game'),
  )
  expect(await readdir(games)).toEqual([])
  await expect(canonicalizeInstallDirectory(target)).rejects.toThrow()
  await expect(
    canonicalizeInstallDirectory(join(games, 'missing', 'nested'), true),
  ).rejects.toThrow()
  const dangling = join(games, 'Dangling')
  await symlink(join(root, 'absent'), dangling)
  await expect(canonicalizeInstallDirectory(dangling, true)).rejects.toThrow()
})
