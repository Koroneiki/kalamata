import { afterEach, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ColdClientGenerator,
  runVisibleWindowsProcess,
} from '../../../src/backend/cold-client/generator.ts'
import type { ArtifactDescriptor } from '../../../src/backend/cold-client/dependency-schema.ts'
import { removeTemporaryDirectory } from '../../helpers/filesystem.ts'

let root: string | undefined

afterEach(async () => {
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

test('runs GSE directly and validates only the expected AppID output', async () => {
  const fixture = await createFixture()
  const staleFile = join(fixture.workingDirectory, '_OUTPUT', '10', 'stale.txt')
  await mkdir(join(fixture.workingDirectory, '_OUTPUT', '10'), {
    recursive: true,
  })
  await writeFile(staleFile, 'stale')
  const invocations: Array<{
    executable: string
    arguments_: string[]
    cwd: string
  }> = []
  const generator = new ColdClientGenerator(fixture.dependencies, {
    platform: 'win32',
    runProcess: async (executable, arguments_, cwd) => {
      await expect(access(staleFile)).rejects.toThrow()
      invocations.push({ executable, arguments_, cwd })
      await writeGeneratedOutput(cwd, 10)
      return 0
    },
  })

  const result = await generator.generate(10, new AbortController().signal)

  expect(invocations).toEqual([
    {
      executable: join(fixture.workingDirectory, 'generate_emu_config.exe'),
      arguments_: ['-acw', '10'],
      cwd: fixture.workingDirectory,
    },
  ])
  expect(result).toEqual({
    gseAssetId: 301,
    appDirectory: join(fixture.workingDirectory, '_OUTPUT', '10'),
    steamSettingsDirectory: join(
      fixture.workingDirectory,
      '_OUTPUT',
      '10',
      'steam_settings',
    ),
  })
})

test('requires login existence without passing credential environment variables', async () => {
  const fixture = await createFixture(false)
  const generator = new ColdClientGenerator(fixture.dependencies, {
    platform: 'win32',
    runProcess: async () => {
      throw new Error('should not run')
    },
  })

  await expect(
    generator.generate(10, new AbortController().signal),
  ).rejects.toThrow('login file is missing')

  const originalUsername = process.env.GSE_CFG_USERNAME
  const originalPassword = process.env.GSE_CFG_PASSWORD
  process.env.GSE_CFG_USERNAME = 'secret-user'
  process.env.GSE_CFG_PASSWORD = 'secret-password'
  let environment: Record<string, string> | undefined
  try {
    const processRun = runVisibleWindowsProcess(
      'generator.exe',
      ['-acw', '10'],
      fixture.workingDirectory,
      new AbortController().signal,
      (_command, options) => {
        environment = options.env
        return { pid: 1, exited: Promise.resolve(0) }
      },
    )
    await processRun
  } finally {
    restoreEnvironment('GSE_CFG_USERNAME', originalUsername)
    restoreEnvironment('GSE_CFG_PASSWORD', originalPassword)
  }
  expect(environment).not.toHaveProperty('GSE_CFG_USERNAME')
  expect(environment).not.toHaveProperty('GSE_CFG_PASSWORD')
})

test('rejects incomplete generated settings after a successful process exit', async () => {
  const fixture = await createFixture()
  const generator = new ColdClientGenerator(fixture.dependencies, {
    platform: 'win32',
    runProcess: async (_executable, _arguments, cwd) => {
      const settings = join(cwd, '_OUTPUT', '10', 'steam_settings')
      await mkdir(settings, { recursive: true })
      await writeFile(join(settings, 'steam_appid.txt'), '10')
      return 0
    },
  })

  await expect(
    generator.generate(10, new AbortController().signal),
  ).rejects.toThrow('configs.app.ini')
})

test('cancellation terminates and reaps the Windows process tree', async () => {
  const controller = new AbortController()
  const childExit = deferred<number>()
  const taskkillExit = deferred<number>()
  const commands: string[][] = []
  const run = runVisibleWindowsProcess(
    'generator.exe',
    ['-acw', '10'],
    'C:\\gse',
    controller.signal,
    (command) => {
      commands.push(command)
      return command[0] === 'generator.exe'
        ? { pid: 42, exited: childExit.promise }
        : { pid: 43, exited: taskkillExit.promise }
    },
  )

  controller.abort(new Error('cancelled'))
  expect(commands[1]).toEqual([
    expect.stringContaining('taskkill.exe'),
    '/PID',
    '42',
    '/T',
    '/F',
  ])
  childExit.resolve(1)
  let settled = false
  void run.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await Bun.sleep(1)
  expect(settled).toBe(false)
  taskkillExit.resolve(0)
  await expect(run).rejects.toThrow('cancelled')
  expect(settled).toBe(true)
})

async function createFixture(login = true) {
  root = await mkdtemp(join(tmpdir(), 'cold-client-generator-'))
  const artifactRoot = join(root, 'dependencies', 'gse', '301')
  const workingDirectory = join(artifactRoot, 'generate_emu_config')
  await mkdir(workingDirectory, { recursive: true })
  await writeFile(join(workingDirectory, 'generate_emu_config.exe'), 'exe')
  if (login) await writeFile(join(workingDirectory, 'my_login.txt'), 'opaque')
  const descriptor: ArtifactDescriptor = {
    dependencyId: 'gse',
    repository: 'test/gse',
    assetId: 301,
    releaseId: 300,
    tag: 'gse-one',
    publishedAt: '2026-08-19T00:00:00.000Z',
    assetName: 'gse.7z',
    sourceUrl: 'https://github.com/test/gse.7z',
    sha256: '0'.repeat(64),
    verificationMode: 'github-digest',
    validatedAt: 1,
  }
  return {
    workingDirectory,
    dependencies: {
      loginFilename: 'my_login.txt',
      activeArtifact: () => descriptor,
      artifactDirectory: () => artifactRoot,
    },
  }
}

async function writeGeneratedOutput(cwd: string, appId: number) {
  const settings = join(cwd, '_OUTPUT', String(appId), 'steam_settings')
  await mkdir(settings, { recursive: true })
  for (const filename of [
    'configs.app.ini',
    'configs.main.ini',
    'configs.overlay.ini',
    'configs.user.ini',
  ])
    await writeFile(join(settings, filename), filename)
  await writeFile(join(settings, 'steam_appid.txt'), String(appId))
  await writeFile(join(settings, 'custom-generated-file.json'), '{}')
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function restoreEnvironment(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
