import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ProductInfo } from '../steam/types.ts'
import { canonicalManifestPath } from '../depot/manifests/manifest-utils.ts'
import { filesystemErrorCode } from '../depot/install/transaction/types.ts'
import type {
  ColdClientDetectionSource,
  ColdClientLaunchOption,
  ColdClientLoaderArchitecture,
  ColdClientSetupDependency,
  ColdClientSetupDraft,
  ColdClientSetupWarning,
} from '../../types/cold-client.ts'

interface InspectionDatabase {
  getLibraryEntry(appId: number): { installPath: string | null } | null
  getInstalls(appId: number): unknown[]
}

interface ProductInfoProvider {
  getProductInfo(appId: number): Promise<ProductInfo>
}

interface DependencyProvider {
  activeArtifact(
    dependencyId: 'gbe' | 'gse',
  ): { assetId: number; tag: string } | null
}

interface GameInspectorOptions {
  platform?: NodeJS.Platform
}

const launchSchema = z
  .object({
    executable: z.string().min(1),
    type: z.string().optional(),
    arguments: z.string().optional(),
    description: z.string().optional(),
    config: z
      .object({ oslist: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
const appInfoLaunchSchema = z
  .object({
    common: z.object({ type: z.string() }).passthrough(),
    config: z
      .object({
        launch: z
          .record(z.string(), launchSchema.nullable().catch(null))
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
type LaunchSource = Record<string, z.infer<typeof launchSchema> | null>

interface ExecutableSelection {
  selected: string | null
  candidates: string[]
  source: ColdClientDetectionSource
  warnings: ColdClientSetupWarning[]
}

interface SteamApiSelection {
  selected: string | null
  source: ColdClientDetectionSource
  warning?: ColdClientSetupWarning
}

interface DraftInput {
  appId: number
  files: string[]
  executableArchitectures: Record<string, ColdClientLoaderArchitecture | null>
  launchSource: LaunchSource
  existingColdClient: boolean
  gbe: { assetId: number; tag: string }
  gse: { assetId: number; tag: string }
}

export class ColdClientGameInspector {
  readonly #platform: NodeJS.Platform

  constructor(
    private readonly database: InspectionDatabase,
    private readonly products: ProductInfoProvider,
    private readonly dependencies: DependencyProvider,
    options: GameInspectorOptions = {},
  ) {
    this.#platform = options.platform ?? process.platform
  }

  async inspect(appId: number): Promise<ColdClientSetupDraft> {
    if (this.#platform !== 'win32') {
      throw new Error('ColdClient setup is available only on Windows')
    }
    const library = this.database.getLibraryEntry(appId)
    if (
      !library?.installPath ||
      this.database.getInstalls(appId).length === 0
    ) {
      throw new Error('ColdClient setup requires an installed game')
    }
    const gbe = requireActiveDependency(this.dependencies, 'gbe')
    const gse = requireActiveDependency(this.dependencies, 'gse')

    const installRoot = await canonicalInstallRoot(library.installPath)
    const product = await this.products.getProductInfo(appId)
    const appInfo = appInfoLaunchSchema.parse(product.appinfo)
    if (appInfo.common.type.toLowerCase() !== 'game') {
      throw new Error('ColdClient setup requires a Steam game')
    }
    const files = await collectGameFiles(installRoot)
    const executableArchitectures = await inspectExecutableArchitectures(
      installRoot,
      files,
    )
    const existingColdClient = await pathExists(
      join(installRoot, '_ColdClient'),
    )
    return buildDraft({
      appId,
      files,
      executableArchitectures,
      launchSource: appInfo.config?.launch ?? {},
      existingColdClient,
      gbe,
      gse,
    })
  }
}

function requireActiveDependency(
  dependencies: DependencyProvider,
  dependencyId: 'gbe' | 'gse',
): ColdClientSetupDependency {
  const artifact = dependencies.activeArtifact(dependencyId)
  if (!artifact) {
    throw new Error('Download the ColdClient dependencies before setup')
  }
  return { assetId: artifact.assetId, tag: artifact.tag }
}

function buildDraft(input: DraftInput): ColdClientSetupDraft {
  const executableCandidates = input.files.filter((path) =>
    path.toLowerCase().endsWith('.exe'),
  )
  if (executableCandidates.length === 0) {
    throw new Error('No Windows executable was found in the game directory')
  }
  const steamApiCandidates = input.files.filter((path) =>
    ['steam_api.dll', 'steam_api64.dll'].includes(basename(path).toLowerCase()),
  )
  const launchOptions = normalizeLaunchOptions(
    input.launchSource,
    executableCandidates,
  )
  const executable = selectExecutable(executableCandidates, launchOptions)
  const steamApi = selectSteamApi(steamApiCandidates)
  const argumentOption = preferredArgumentOption(launchOptions)

  return {
    appId: input.appId,
    targetRelativePath: '_ColdClient',
    executableCandidates: executable.candidates,
    executableArchitectures: Object.fromEntries(
      executable.candidates.map((path) => [
        path,
        input.executableArchitectures[path] ?? null,
      ]),
    ),
    selectedExecutableRelativePath: executable.selected,
    executableDetectionSource: executable.source,
    steamApiCandidates,
    selectedSteamApiRelativePath: steamApi.selected,
    steamApiDetectionSource: steamApi.source,
    loaderArchitecture: loaderArchitecture(steamApi.selected),
    launchOptions,
    launchArguments: argumentOption?.arguments ?? '',
    launchArgumentSource: argumentOption?.key ?? null,
    warnings: setupWarnings(
      executable,
      steamApi,
      argumentOption,
      input.existingColdClient,
    ),
    existingColdClient: input.existingColdClient,
    gbe: input.gbe,
    gse: input.gse,
  }
}

function preferredArgumentOption(
  launchOptions: ColdClientLaunchOption[],
): ColdClientLaunchOption | null {
  return (
    launchOptions.find((option) => option.arguments.trim().length > 0) ??
    launchOptions[0] ??
    null
  )
}

function setupWarnings(
  executable: ExecutableSelection,
  steamApi: SteamApiSelection,
  argumentOption: ColdClientLaunchOption | null,
  existingColdClient: boolean,
): ColdClientSetupWarning[] {
  const warnings = [...executable.warnings]
  if (steamApi.warning) warnings.push(steamApi.warning)
  if (
    argumentOption &&
    executable.selected &&
    !sameWindowsPath(argumentOption.executable, executable.selected)
  ) {
    warnings.push('launch-executable-mismatch')
  }
  if (existingColdClient) {
    warnings.push('existing-cold-client-will-be-replaced')
  }
  return warnings
}

function loaderArchitecture(path: string | null): 'x86' | 'x64' {
  return path?.toLowerCase().endsWith('steam_api.dll') ? 'x86' : 'x64'
}

async function canonicalInstallRoot(installPath: string): Promise<string> {
  const lexicalRoot = resolve(installPath)
  const metadata = await lstat(lexicalRoot)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The game install path is not a regular directory')
  }
  return realpath(lexicalRoot)
}

async function collectGameFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => comparePaths(left.name, right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolutePath = join(directory, entry.name)
      const relativePath = relative(root, absolutePath).split(sep).join('/')
      if (entry.isDirectory()) {
        if (isExcludedDirectory(relativePath)) continue
        await visit(absolutePath)
      } else if (entry.isFile()) {
        files.push(canonicalManifestPath(relativePath, 'win32'))
      }
    }
  }
  await visit(root)
  return files.sort(comparePaths)
}

async function inspectExecutableArchitectures(
  root: string,
  files: string[],
): Promise<Record<string, ColdClientLoaderArchitecture | null>> {
  const architectures: Record<string, ColdClientLoaderArchitecture | null> = {}
  for (const path of files) {
    if (!path.toLowerCase().endsWith('.exe')) continue
    architectures[path] = await readPortableExecutableArchitecture(
      join(root, ...path.split('/')),
    )
  }
  return architectures
}

async function readPortableExecutableArchitecture(
  path: string,
): Promise<ColdClientLoaderArchitecture | null> {
  try {
    const file = await open(path, 'r')
    try {
      const dosHeader = Buffer.alloc(64)
      const dosRead = await file.read(dosHeader, 0, dosHeader.length, 0)
      if (
        dosRead.bytesRead < dosHeader.length ||
        dosHeader.readUInt16LE(0) !== 0x5a4d
      ) {
        return null
      }

      const peHeader = Buffer.alloc(6)
      const peRead = await file.read(
        peHeader,
        0,
        peHeader.length,
        dosHeader.readUInt32LE(0x3c),
      )
      if (
        peRead.bytesRead < peHeader.length ||
        peHeader.readUInt32LE(0) !== 0x4550
      ) {
        return null
      }

      const machine = peHeader.readUInt16LE(4)
      if (machine === 0x014c) return 'x86'
      if (machine === 0x8664) return 'x64'
      return null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

function isExcludedDirectory(path: string): boolean {
  const name = basename(path).toLowerCase()
  return (
    name === '.kalamata' ||
    name === '_coldclient' ||
    name.startsWith('.kalamata-coldclient-')
  )
}

function normalizeLaunchOptions(
  launchSource: LaunchSource,
  executableCandidates: string[],
): ColdClientLaunchOption[] {
  const candidateByPath = new Map(
    executableCandidates.map((path) => [path.toLowerCase(), path]),
  )
  const candidatesByFilename = new Map<string, string[]>()
  for (const candidate of executableCandidates) {
    const name = basename(candidate).toLowerCase()
    const matches = candidatesByFilename.get(name) ?? []
    matches.push(candidate)
    candidatesByFilename.set(name, matches)
  }

  return Object.entries(launchSource)
    .filter(([key]) => /^\d+$/u.test(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .flatMap(([key, source]) => {
      if (!source || !eligibleLaunch(source)) return []
      let metadataPath: string
      try {
        metadataPath = canonicalManifestPath(source.executable, 'win32')
      } catch {
        return []
      }
      if (!metadataPath.toLowerCase().endsWith('.exe')) return []
      const exact = candidateByPath.get(metadataPath.toLowerCase())
      const sameFilename =
        candidatesByFilename.get(basename(metadataPath).toLowerCase()) ?? []
      const matches = [...new Set([...(exact ? [exact] : []), ...sameFilename])]
      const executable =
        matches.find((path) => pathHasBinaryDirectory(path)) ??
        exact ??
        matches[0] ??
        null
      return [
        {
          key,
          executable: metadataPath,
          matchedExecutableRelativePath: executable,
          arguments: source.arguments ?? '',
          description: source.description ?? null,
        },
      ]
    })
}

function eligibleLaunch(launch: z.infer<typeof launchSchema>): boolean {
  const oslist = launch.config?.oslist?.toLowerCase()
  return (
    (!oslist || oslist.includes('windows')) &&
    (!launch.type || launch.type.toLowerCase() === 'default')
  )
}

function selectExecutable(
  candidates: string[],
  launchOptions: ColdClientLaunchOption[],
): ExecutableSelection {
  const shipping = candidates.filter((path) =>
    basename(path).toLowerCase().includes('shipping'),
  )
  if (shipping.length === 1) {
    return {
      selected: shipping[0]!,
      candidates,
      source: 'shipping-executable',
      warnings: [],
    }
  }
  if (shipping.length > 1) {
    return {
      selected: null,
      candidates: shipping,
      source: 'manual-choice',
      warnings: ['multiple-shipping-executables'],
    }
  }
  if (candidates.length === 1) {
    return {
      selected: candidates[0]!,
      candidates,
      source: 'sole-executable',
      warnings: [],
    }
  }
  const matchedLaunch = launchOptions.find(
    ({ matchedExecutableRelativePath }) => matchedExecutableRelativePath,
  )
  if (matchedLaunch?.matchedExecutableRelativePath) {
    return {
      selected: matchedLaunch.matchedExecutableRelativePath,
      candidates,
      source: 'steam-launch',
      warnings: [],
    }
  }
  return {
    selected: null,
    candidates,
    source: 'manual-choice',
    warnings: ['executable-choice-required'],
  }
}

function selectSteamApi(candidates: string[]): SteamApiSelection {
  const binaryCandidate = candidates.find(pathHasBinaryDirectory)
  if (binaryCandidate) {
    return { selected: binaryCandidate, source: 'binary-directory' }
  }
  if (candidates.length === 1) {
    return { selected: candidates[0]!, source: 'sole-steam-api' }
  }
  if (candidates.length > 1) {
    return {
      selected: null,
      source: 'manual-choice',
      warning: 'steam-api-choice-required',
    }
  }
  return {
    selected: null,
    source: 'missing-dll-fallback',
    warning: 'x64-assumed-without-steam-api',
  }
}

function pathHasBinaryDirectory(path: string): boolean {
  return dirname(path)
    .split(/[\\/]/u)
    .some((segment) => /binar(?:y|ies)/iu.test(segment))
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function comparePaths(left: string, right: string): number {
  return (
    left.localeCompare(right, 'en', { sensitivity: 'base' }) ||
    left.localeCompare(right, 'en')
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return false
    throw error
  }
}
