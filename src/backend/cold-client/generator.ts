import { randomUUID } from 'node:crypto'
import {
  lstat,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import { steamIdSchema } from '../../types/schemas.ts'
import type { ArtifactDescriptor } from './dependency-schema.ts'

interface GseDependencyProvider {
  readonly loginFilename: string
  activeArtifact(dependencyId: 'gse'): ArtifactDescriptor | null
  validateArtifactSnapshot(
    dependencyId: 'gse',
    assetId: number,
  ): Promise<{ descriptor: ArtifactDescriptor; directory: string }>
}

interface ProcessHandle {
  pid: number
  exited: Promise<number>
}

interface ProcessOptions {
  cwd?: string
  env?: Record<string, string>
  windowsHide: boolean
  stdin: 'ignore' | 'inherit'
  stdout: 'ignore' | 'inherit'
  stderr: 'ignore' | 'inherit'
}

interface GseProcessRunner {
  (
    executable: string,
    arguments_: string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<number>
}

interface TopOwnersLoader {
  (signal: AbortSignal): Promise<string>
}

interface GeneratorOptions {
  platform?: NodeJS.Platform
  runProcess?: GseProcessRunner
  loadTopOwners?: TopOwnersLoader
}

interface ChildEnvironment {
  [key: string]: string
}

const filesystemErrorSchema = z.object({ code: z.string() }).loose()
const topOwnersUrl = 'https://steamladder.com/ladder/games/'
const topOwnersUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/123.0.0.0 Safari/537.36'

export interface GeneratedGseConfiguration {
  gseAssetId: number
  appDirectory: string
  steamSettingsDirectory: string
}

const requiredSteamSettingsFiles = [
  'configs.app.ini',
  'configs.main.ini',
  'configs.overlay.ini',
  'configs.user.ini',
  'steam_appid.txt',
]

export class ColdClientGenerator {
  readonly #dependencies: GseDependencyProvider
  readonly #platform: NodeJS.Platform
  readonly #runProcess: GseProcessRunner
  readonly #loadTopOwners: TopOwnersLoader

  constructor(
    dependencies: GseDependencyProvider,
    options: GeneratorOptions = {},
  ) {
    this.#dependencies = dependencies
    this.#platform = options.platform ?? process.platform
    this.#runProcess = options.runProcess ?? runVisibleWindowsProcess
    this.#loadTopOwners = options.loadTopOwners ?? loadTopOwners
  }

  async generate(
    appIdInput: number,
    signal: AbortSignal,
  ): Promise<GeneratedGseConfiguration> {
    if (this.#platform !== 'win32')
      throw new Error('ColdClient setup is available only on Windows')
    const appId = steamIdSchema.parse(appIdInput)
    signal.throwIfAborted()

    const artifact = this.#dependencies.activeArtifact('gse')
    if (!artifact) throw new Error('GSE Tools is not installed')
    const snapshot = await this.#dependencies.validateArtifactSnapshot(
      'gse',
      artifact.assetId,
    )
    signal.throwIfAborted()
    const artifactRoot = snapshot.directory
    const workingDirectory = join(artifactRoot, 'generate_emu_config')
    const executable = join(workingDirectory, 'generate_emu_config.exe')
    const loginPath = join(workingDirectory, this.#dependencies.loginFilename)
    await assertRegularFile(executable, 'GSE Tools executable is missing')
    // Login data is user-owned. Existence and filesystem copy are its only APIs.
    await assertRegularFile(loginPath, 'GSE Tools login file is missing')
    await refreshTopOwners(this.#loadTopOwners, workingDirectory, signal)

    const outputRoot = join(workingDirectory, '_OUTPUT')
    const appDirectory = join(outputRoot, String(appId))
    await removeStaleAppOutput(outputRoot, appDirectory)
    signal.throwIfAborted()

    const exitCode = await this.#runProcess(
      executable,
      ['-acw', String(appId)],
      workingDirectory,
      signal,
    )
    signal.throwIfAborted()
    if (exitCode !== 0)
      throw new Error(`GSE Tools exited with code ${exitCode}`)

    const steamSettingsDirectory = await validateGeneratedOutput(
      outputRoot,
      appDirectory,
      appId,
    )
    return {
      gseAssetId: artifact.assetId,
      appDirectory,
      steamSettingsDirectory,
    }
  }
}

async function refreshTopOwners(
  load: TopOwnersLoader,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<void> {
  const destination = join(workingDirectory, 'top_owners_ids.txt')
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    const ids = [
      ...new Set(
        [...(await load(signal)).matchAll(/\/profile\/(\d{17})\//g)].map(
          (match) => match[1]!,
        ),
      ),
    ].slice(0, 250)
    if (ids.length < 10) throw new Error('SteamLadder returned too few IDs')
    await writeFile(temporary, `${ids.join('\n')}\n`, { flag: 'wx' })
    await rename(temporary, destination)
  } catch {
    signal.throwIfAborted()
    // GSE ships a fallback list, so refresh failure must not block generation.
  } finally {
    await rm(temporary, { force: true })
  }
}

async function loadTopOwners(signal: AbortSignal): Promise<string> {
  const systemRoot = windowsEnvironmentValue('SystemRoot') ?? 'C:\\Windows'
  const request = Bun.spawn({
    cmd: [
      join(systemRoot, 'System32', 'curl.exe'),
      '--http1.1',
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--header',
      'Accept-Encoding: identity',
      '--header',
      'Connection: close',
      '--user-agent',
      topOwnersUserAgent,
      topOwnersUrl,
    ],
    signal,
    timeout: 30_000,
    windowsHide: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [exitCode, html] = await Promise.all([
    request.exited,
    request.stdout.text(),
  ])
  signal.throwIfAborted()
  if (exitCode !== 0)
    throw new Error(`SteamLadder request exited with ${exitCode}`)
  return html
}

export async function runVisibleWindowsProcess(
  executable: string,
  arguments_: string[],
  cwd: string,
  signal: AbortSignal,
  spawnProcess: (
    command: string[],
    options: ProcessOptions,
  ) => ProcessHandle = defaultSpawnProcess,
): Promise<number> {
  signal.throwIfAborted()
  const processHandle = spawnProcess([executable, ...arguments_], {
    cwd,
    env: minimalWindowsEnvironment(),
    windowsHide: false,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  let termination: Promise<void> | undefined
  const terminate = () => {
    termination ??= terminateWindowsProcessTree(processHandle.pid, spawnProcess)
  }
  signal.addEventListener('abort', terminate, { once: true })
  if (signal.aborted) terminate()
  try {
    const exitCode = await processHandle.exited
    if (termination) await termination
    signal.throwIfAborted()
    return exitCode
  } finally {
    signal.removeEventListener('abort', terminate)
  }
}

async function terminateWindowsProcessTree(
  pid: number,
  spawnProcess: (command: string[], options: ProcessOptions) => ProcessHandle,
): Promise<void> {
  const systemRoot = windowsEnvironmentValue('SystemRoot') ?? 'C:\\Windows'
  const taskkill = spawnProcess(
    [
      join(systemRoot, 'System32', 'taskkill.exe'),
      '/PID',
      String(pid),
      '/T',
      '/F',
    ],
    {
      windowsHide: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
  const exitCode = await taskkill.exited
  if (exitCode !== 0)
    throw new Error('Could not terminate the GSE Tools process tree')
}

function defaultSpawnProcess(
  command: string[],
  options: ProcessOptions,
): ProcessHandle {
  return Bun.spawn(command, options)
}

function minimalWindowsEnvironment(): ChildEnvironment {
  const environment: ChildEnvironment = {}
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERNAME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
  ]) {
    const value = windowsEnvironmentValue(key)
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function windowsEnvironmentValue(key: string): string | undefined {
  const match = Object.entries(process.env).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
  )
  return match?.[1]
}

async function removeStaleAppOutput(
  outputRoot: string,
  appDirectory: string,
): Promise<void> {
  const outputRootStats = await lstatOrNull(outputRoot)
  if (
    outputRootStats &&
    (!outputRootStats.isDirectory() || outputRootStats.isSymbolicLink())
  ) {
    throw new Error('GSE Tools output root is not a safe directory')
  }
  const appStats = await lstatOrNull(appDirectory)
  if (!appStats) return
  if (!appStats.isDirectory() || appStats.isSymbolicLink())
    throw new Error('Stale GSE Tools output is not a safe directory')
  await rm(appDirectory, { recursive: true })
}

async function validateGeneratedOutput(
  outputRoot: string,
  appDirectory: string,
  appId: number,
): Promise<string> {
  await assertSafeTree(appDirectory)
  const canonicalRoot = await realpath(outputRoot)
  const canonicalApp = await realpath(appDirectory)
  const relativeApp = relative(canonicalRoot, canonicalApp)
  if (
    relativeApp !== String(appId) ||
    isAbsolute(relativeApp) ||
    relativeApp.startsWith('..')
  ) {
    throw new Error('GSE Tools output escaped the expected AppID directory')
  }

  const steamSettingsDirectory = join(appDirectory, 'steam_settings')
  const settingsStats = await lstatOrNull(steamSettingsDirectory)
  if (!settingsStats?.isDirectory() || settingsStats.isSymbolicLink())
    throw new Error('GSE Tools did not generate steam_settings')
  for (const relativePath of requiredSteamSettingsFiles)
    await assertRegularFile(
      join(steamSettingsDirectory, relativePath),
      `GSE Tools output is missing ${relativePath}`,
    )
  const generatedAppId = await readFile(
    join(steamSettingsDirectory, 'steam_appid.txt'),
    'utf8',
  )
  if (generatedAppId.trim() !== String(appId))
    throw new Error('GSE Tools generated output for a different AppID')
  return steamSettingsDirectory
}

async function assertSafeTree(root: string): Promise<void> {
  const stats = await lstatOrNull(root)
  if (!stats?.isDirectory() || stats.isSymbolicLink())
    throw new Error('GSE Tools did not generate the expected AppID directory')
  const directory = await opendir(root)
  for await (const entry of directory) {
    const path = join(root, entry.name)
    const entryStats = await lstat(path)
    if (entryStats.isSymbolicLink())
      throw new Error('GSE Tools output contains a link or reparse point')
    if (entryStats.isDirectory()) await assertSafeTree(path)
    else if (!entryStats.isFile())
      throw new Error('GSE Tools output contains an unsupported file type')
  }
}

async function assertRegularFile(path: string, message: string): Promise<void> {
  const stats = await lstatOrNull(path)
  if (!stats?.isFile() || stats.isSymbolicLink()) throw new Error(message)
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    const parsed = filesystemErrorSchema.safeParse(error)
    if (parsed.success && parsed.data.code === 'ENOENT') return null
    throw error
  }
}
