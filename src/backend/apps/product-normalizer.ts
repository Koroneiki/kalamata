import type {
  AppDepot,
  AppDetails,
  AppSummary,
  DepotGroup,
  EligibleAppDepot,
} from '../../types/rpc.ts'
import type { InstallRow, KalamataDatabase } from '../../db/database.ts'
import { z } from 'zod'
import { validateManagedManifest } from '../../db/manifest-files.ts'
import { depotKeyFromHex } from '../../db/validation.ts'
import type { ProductInfo, ProductInfoResult } from '../steam/types.ts'
import { manifestIdSchema, steamIdStringSchema } from '../../types/schemas.ts'

type SteamValue = z.infer<typeof steamValueSchema>
type SteamRecord = z.infer<typeof recordSchema>

export interface PublicDepot {
  depotId: number
  ownerAppId: number
  ownerAppName: string | null
  group: DepotGroup
  platform: string | null
  language: string | null
  manifestId: string | null
  sizeBytes: string | null
  downloadBytes: string | null
  mountIndex: number
}

export function normalizeAppSummary(product: ProductInfo): AppSummary {
  const common = asRecord(product.appinfo.common)
  const associations = Object.values(asRecord(common.associations))
  const developers = associationNames(associations, 'developer')
  const publishers = associationNames(associations, 'publisher')
  const releaseSeconds = decimalString(common.steam_release_date)
  const releaseDate = releaseSeconds ? Number(releaseSeconds) * 1000 : NaN
  const headerImages = asRecord(common.header_image)
  const header =
    stringValue(headerImages.english) ??
    Object.values(headerImages)
      .map(stringValue)
      .find((value) => value !== null) ??
    null
  const clientIcon = stringValue(common.clienticon)
  const icon = stringValue(common.icon)

  return {
    appId: product.appId,
    name: stringValue(common.name) ?? `App ${product.appId}`,
    developers,
    publishers,
    releaseDate: Number.isSafeInteger(releaseDate) ? releaseDate : null,
    iconUrls: [
      ...(clientIcon
        ? [steamCommunityImageUrl(product.appId, clientIcon, 'ico')]
        : []),
      ...(icon ? [steamCommunityImageUrl(product.appId, icon, 'jpg')] : []),
    ],
    artworkUrl: header
      ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${product.appId}/${header}`
      : null,
  }
}

export function extractPublicDepots(
  products: ProductInfoResult,
  installedDepotIds: ReadonlySet<number> = new Set(),
): PublicDepot[] {
  const result: PublicDepot[] = []
  const seen = new Set<number>()
  const allProducts = [products.baseProduct, ...products.dlcProducts]
  // The base app's DLC list remains authoritative when PICS omits DLC product details.
  const productNames = new Map<number, string | null>(
    products.listedDlcAppIds.map((appId) => [appId, null]),
  )
  for (const product of allProducts) {
    productNames.set(
      product.appId,
      stringValue(asRecord(product.appinfo.common).name),
    )
  }
  for (const product of allProducts) {
    for (const { depotId, rawDepot } of publicDepotEntries(product)) {
      if (seen.has(depotId)) continue
      seen.add(depotId)
      result.push(
        normalizePublicDepot(
          depotId,
          rawDepot,
          product.appId,
          products.baseProduct.appId,
          productNames,
          result.length,
          products.eligibleBaseDepotIds,
          products.eligibleDlcDepotIds,
          installedDepotIds.has(depotId),
        ),
      )
    }
  }
  return result
}

export async function normalizeAppDetails(
  products: ProductInfoResult,
  database: KalamataDatabase,
): Promise<AppDetails> {
  const product = products.baseProduct
  const library = database.getLibraryEntry(product.appId)
  const installedRows = database.getInstalls(product.appId)
  const installs = new Map(installedRows.map((row) => [row.depotId, row]))
  const depots: AppDepot[] = []
  const publicDepots = extractPublicDepots(products, new Set(installs.keys()))
  const publicDepotIds = new Set(publicDepots.map(({ depotId }) => depotId))
  for (const depot of publicDepots) {
    depots.push(
      await normalizePublicAppDepot(
        depot,
        installs.get(depot.depotId),
        database,
      ),
    )
  }
  // Missing Steam metadata must not hide installed depots from removal.
  for (const installed of installedRows) {
    if (publicDepotIds.has(installed.depotId)) continue
    depots.push(
      await normalizeHiddenInstall(installed, product.appId, database),
    )
  }
  return {
    ...normalizeAppSummary(product),
    inLibrary: library !== null,
    installPath: library?.installPath ?? null,
    installedDepotIds: installedRows.map(({ depotId }) => depotId),
    depots,
  }
}

function publicDepotEntries(product: ProductInfo) {
  const depots = asRecord(asRecord(product.appinfo).depots)
  return Object.entries(depots)
    .flatMap(([rawDepotId, rawDepot]) => {
      const result = steamIdStringSchema.safeParse(rawDepotId)
      return result.success ? [{ depotId: result.data, rawDepot }] : []
    })
    .sort((left, right) => left.depotId - right.depotId)
}

function normalizePublicDepot(
  depotId: number,
  rawDepot: SteamValue,
  productAppId: number,
  baseAppId: number,
  productNames: Map<number, string | null>,
  mountIndex: number,
  eligibleBaseDepotIds: ReadonlySet<number> | null,
  eligibleDlcDepotIds: ReadonlyMap<number, ReadonlySet<number>>,
  installed: boolean,
): PublicDepot {
  const depot = asRecord(rawDepot)
  const config = asRecord(depot.config)
  const publicManifest = asRecord(asRecord(depot.manifests).public)
  // Steam can list a DLC depot under the base app. In that case dlcappid is
  // the authoritative classification and download owner (for example 323320/353590).
  const dlcAppId = positiveId(depot.dlcappid)
  const ownerAppId = dlcAppId ?? productAppId
  const eligibleDlcDepots = eligibleDlcDepotIds.get(ownerAppId)
  const shared =
    positiveId(depot.depotfromapp) !== null || booleanValue(depot.sharedinstall)
  const group = classifyDepot(
    depotId,
    productAppId === baseAppId,
    dlcAppId !== null,
    dlcAppId === null || productNames.has(dlcAppId),
    publicManifest,
    shared,
    installed,
    eligibleBaseDepotIds?.has(depotId) ?? true,
    eligibleDlcDepots?.has(depotId) ?? true,
  )
  return {
    depotId,
    ownerAppId,
    ownerAppName: depotOwnerName(group, ownerAppId, productNames),
    group,
    platform: restriction(config.oslist),
    language: restriction(config.language),
    manifestId: decimalString(publicManifest.gid),
    sizeBytes: decimalString(publicManifest.size),
    downloadBytes: decimalString(publicManifest.download),
    mountIndex,
  }
}

function depotOwnerName(
  group: DepotGroup,
  ownerAppId: number,
  productNames: Map<number, string | null>,
): string | null {
  if (group === 'Unknown') return `Unknown App ${ownerAppId}`
  if (group === 'DLC') return productNames.get(ownerAppId) ?? null
  return null
}

async function normalizePublicAppDepot(
  depot: PublicDepot,
  installed: InstallRow | undefined,
  database: KalamataDatabase,
): Promise<AppDepot> {
  const { group, ...depotFields } = depot
  if (!isEligibleGroup(group)) {
    return {
      ...depotFields,
      installedManifestId: null,
      pinned: false,
      group,
      eligible: false,
      manifestStatus: null,
      keyStatus: null,
      installStatus: null,
      selectable: false,
    }
  }

  const { key, keyStatus } = readDepotKey(database, depot.depotId)
  const manifestStatus = await publicManifestStatus(database, depot, key)
  const installStatus = getInstallStatus(installed, depot.manifestId)
  return {
    ...depotFields,
    installedManifestId: installed?.installedManifestId ?? null,
    pinned: installed?.pinned ?? false,
    group,
    eligible: true,
    manifestStatus,
    keyStatus,
    installStatus,
    selectable:
      manifestStatus === 'ready' &&
      keyStatus === 'present' &&
      installStatus !== 'current',
  }
}

async function normalizeHiddenInstall(
  installed: InstallRow,
  productAppId: number,
  database: KalamataDatabase,
): Promise<EligibleAppDepot> {
  const { key, keyStatus } = readDepotKey(database, installed.depotId)
  const manifest = database
    .getManifestRows(installed.depotId)
    .find(({ manifestId }) => manifestId === installed.installedManifestId)
  const manifestStatus = manifest
    ? await validateManifest(
        database,
        installed.depotId,
        installed.installedManifestId,
        manifest.relativePath,
        key,
      )
    : 'missing'
  const ownerAppId = installed.ownerAppId ?? productAppId
  return {
    depotId: installed.depotId,
    mountIndex: installed.mountIndex,
    ownerAppId,
    ownerAppName: null,
    group: ownerAppId === productAppId ? 'Base Game' : 'DLC',
    platform: null,
    language: null,
    manifestId: installed.installedManifestId,
    installedManifestId: installed.installedManifestId,
    pinned: installed.pinned,
    sizeBytes: null,
    downloadBytes: null,
    eligible: true,
    manifestStatus,
    keyStatus,
    installStatus: 'current',
    selectable: false,
  }
}

function readDepotKey(database: KalamataDatabase, depotId: number) {
  const keyText = database.getDepotKey(depotId)
  if (keyText === null) {
    return {
      key: undefined,
      keyStatus: 'missing' as const,
    }
  }
  try {
    return {
      key: depotKeyFromHex(keyText),
      keyStatus: 'present' as const,
    }
  } catch {
    return {
      key: undefined,
      keyStatus: 'invalid' as const,
    }
  }
}

async function publicManifestStatus(
  database: KalamataDatabase,
  depot: PublicDepot,
  key: Buffer | undefined,
): Promise<EligibleAppDepot['manifestStatus']> {
  const rows = database.getManifestRows(depot.depotId)
  const current = depot.manifestId
    ? rows.find((row) => row.manifestId === depot.manifestId)
    : undefined
  if (!current || !depot.manifestId) return rows.length ? 'outdated' : 'missing'
  return validateManifest(
    database,
    depot.depotId,
    depot.manifestId,
    current.relativePath,
    key,
  )
}

async function validateManifest(
  database: KalamataDatabase,
  depotId: number,
  manifestId: string,
  relativePath: string,
  key: Buffer | undefined,
): Promise<'ready' | 'invalid'> {
  try {
    await validateManagedManifest(
      database.dataRoot,
      depotId,
      manifestId,
      relativePath,
      key,
    )
    return 'ready'
  } catch {
    return 'invalid'
  }
}

function getInstallStatus(
  installed: InstallRow | undefined,
  manifestId: string | null,
): EligibleAppDepot['installStatus'] {
  if (!installed) return 'not-installed'
  if (installed.pinned || installed.installedManifestId === manifestId)
    return 'current'
  return 'outdated'
}

function isEligibleGroup(
  group: DepotGroup,
): group is EligibleAppDepot['group'] {
  return group === 'Base Game' || group === 'DLC'
}

function classifyDepot(
  depotId: number,
  ownedByBase: boolean,
  hasDlcOwner: boolean,
  ownerKnown: boolean,
  publicManifest: SteamRecord,
  shared: boolean,
  installed: boolean,
  inBasePackage: boolean,
  inDlcPackage: boolean,
): DepotGroup {
  if (isSteamworksDepot(depotId)) return 'Steamworks Common Redistributables'
  if (!hasPublicContent(publicManifest)) return 'Unused'
  if (hasDlcOwner && !ownerKnown) return 'Unknown'
  // DLC comes from dlcappid or from a depot owned by a separately fetched DLC product.
  if (!ownedByBase || hasDlcOwner)
    return packageExcludesDepot(shared, installed, inDlcPackage)
      ? 'Unavailable'
      : 'DLC'
  if (packageExcludesDepot(shared, installed, inBasePackage))
    return 'Unavailable'
  return 'Base Game'
}

function hasPublicContent(publicManifest: SteamRecord): boolean {
  return !(
    rawEmpty(publicManifest.gid) &&
    rawEmpty(publicManifest.size) &&
    rawEmpty(publicManifest.download)
  )
}

function packageExcludesDepot(
  shared: boolean,
  installed: boolean,
  inPublicPackage: boolean,
): boolean {
  return !shared && !installed && !inPublicPackage
}

function isSteamworksDepot(depotId: number): boolean {
  return (
    (depotId >= 228981 && depotId <= 228990) ||
    (depotId >= 229000 && depotId <= 229007) ||
    (depotId >= 229010 && depotId <= 229012) ||
    depotId === 229020 ||
    (depotId >= 229030 && depotId <= 229033)
  )
}

function rawEmpty(value: SteamValue | undefined): boolean {
  return value === undefined || value === null || value === ''
}

function asRecord(cause: unknown): SteamRecord {
  const result = recordSchema.safeParse(cause)
  return result.success ? result.data : {}
}

function stringValue(value: SteamValue | undefined): string | null {
  return stringValueSchema.parse(value)
}

function associationNames(
  associations: SteamValue[],
  type: 'developer' | 'publisher',
): string[] {
  return associations.flatMap((association) => {
    const value = asRecord(association)
    const result = associationSchema.safeParse(value)
    return result.success && result.data.type === type ? [result.data.name] : []
  })
}

function steamCommunityImageUrl(
  appId: number,
  hash: string,
  extension: 'ico' | 'jpg',
): string {
  return `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appId}/${hash}.${extension}`
}

function decimalString(value: SteamValue | undefined): string | null {
  return decimalStringSchema.parse(value)
}

function positiveId(value: SteamValue | undefined): number | null {
  return positiveIdSchema.parse(value)
}

function booleanValue(value: SteamValue | undefined): boolean {
  return value === true || value === 1 || value === '1'
}

function restriction(value: SteamValue | undefined): string | null {
  return restrictionSchema.parse(value)
}

const steamValueSchema = z.json()
const recordSchema = z.record(z.string(), steamValueSchema)
const stringValueSchema = z.string().min(1).nullable().catch(null)
const associationSchema = z.object({ type: z.string(), name: z.string() })
const decimalStringSchema = manifestIdSchema.nullable().catch(null)
const positiveIdSchema = steamIdStringSchema.nullable().catch(null)
const restrictionSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .join(', '),
  )
  .transform((value) => value || null)
  .catch(null)
