import type {
  AppDepot,
  AppDetails,
  AppSummary,
  DepotGroup,
  EligibleAppDepot,
} from '../../types/rpc.ts'
import type { KalamataDatabase } from '../../db/database.ts'
import { validateManagedManifest } from '../../db/manifest-files.ts'
import { depotKeyFromHex } from '../../db/validation.ts'
import type { ProductInfo, ProductInfoResult } from './types.ts'

export interface PublicDepot {
  depotId: number
  ownerAppId: number
  group: DepotGroup
  platform: string | null
  language: string | null
  manifestId: string | null
  sizeBytes: string | null
  downloadBytes: string | null
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
    Object.values(headerImages).find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ) ??
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
): PublicDepot[] {
  const result: PublicDepot[] = []
  const seen = new Set<number>()
  for (const product of [products.baseProduct, ...products.dlcProducts]) {
    const depots = asRecord(asRecord(product.appinfo).depots)
    for (const [rawDepotId, rawDepot] of Object.entries(depots)) {
      if (!/^[1-9]\d*$/u.test(rawDepotId)) continue
      const depotId = Number(rawDepotId)
      if (
        !Number.isInteger(depotId) ||
        depotId > 0xffffffff ||
        seen.has(depotId)
      )
        continue
      seen.add(depotId)
      const depot = asRecord(rawDepot)
      const config = asRecord(depot.config)
      const publicManifest = asRecord(asRecord(depot.manifests).public)
      const group = classifyDepot(
        depotId,
        product.appId === products.baseProduct.appId,
        config.oslist,
        publicManifest,
      )
      result.push({
        depotId,
        ownerAppId: product.appId,
        group,
        platform: restriction(config.oslist),
        language: restriction(config.language),
        manifestId: decimalString(publicManifest.gid),
        sizeBytes: decimalString(publicManifest.size),
        downloadBytes: decimalString(publicManifest.download),
      })
    }
  }
  return result.sort((left, right) => left.depotId - right.depotId)
}

export async function normalizeAppDetails(
  products: ProductInfoResult,
  database: KalamataDatabase,
): Promise<AppDetails> {
  const product = products.baseProduct
  const library = database.getLibraryEntry(product.appId)
  const installs = new Map(
    database
      .getInstalls(product.appId)
      .map((row) => [row.depotId, row.installedManifestId]),
  )
  const depots: AppDepot[] = []
  for (const depot of extractPublicDepots(products)) {
    const { group, ...depotFields } = depot
    if (!isEligibleGroup(group)) {
      depots.push({
        ...depotFields,
        group,
        eligible: false,
        manifestStatus: null,
        keyStatus: null,
        installStatus: null,
        selectable: false,
      })
      continue
    }

    const keyText = database.getDepotKey(depot.depotId)
    let key: Buffer | undefined
    let keyStatus: EligibleAppDepot['keyStatus'] = 'missing'
    if (keyText !== null) {
      try {
        key = depotKeyFromHex(keyText)
        keyStatus = 'ready'
      } catch {
        keyStatus = 'invalid'
      }
    }

    const rows = database.getManifestRows(depot.depotId)
    const current = depot.manifestId
      ? rows.find((row) => row.manifestId === depot.manifestId)
      : undefined
    let manifestStatus: EligibleAppDepot['manifestStatus'] = rows.length
      ? 'outdated'
      : 'missing'
    if (current && depot.manifestId) {
      try {
        await validateManagedManifest(
          database.dataRoot,
          depot.depotId,
          depot.manifestId,
          current.relativePath,
          key,
        )
        manifestStatus = 'ready'
      } catch {
        manifestStatus = 'invalid'
      }
    }

    const installed = installs.get(depot.depotId)
    const installStatus: EligibleAppDepot['installStatus'] = !installed
      ? 'not-installed'
      : installed === depot.manifestId
        ? 'current'
        : 'outdated'
    depots.push({
      ...depotFields,
      group,
      eligible: true,
      manifestStatus,
      keyStatus,
      installStatus,
      selectable:
        manifestStatus === 'ready' &&
        keyStatus === 'ready' &&
        installStatus !== 'current',
    })
  }
  return {
    ...normalizeAppSummary(product),
    installPath: library?.installPath ?? null,
    depots,
  }
}

function isEligibleGroup(
  group: DepotGroup,
): group is EligibleAppDepot['group'] {
  return group === 'Base Game' || group === 'DLC'
}

function classifyDepot(
  depotId: number,
  ownedByBase: boolean,
  oslist: unknown,
  publicManifest: Record<string, unknown>,
): DepotGroup {
  if (isSteamworksDepot(depotId)) return 'Steamworks Common Redistributables'
  if (
    rawEmpty(oslist) &&
    rawEmpty(publicManifest.gid) &&
    rawEmpty(publicManifest.size) &&
    rawEmpty(publicManifest.download)
  )
    return 'Unused'
  return ownedByBase ? 'Base Game' : 'DLC'
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

function rawEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function associationNames(
  associations: unknown[],
  type: 'developer' | 'publisher',
): string[] {
  return associations.flatMap((association) => {
    const value = asRecord(association)
    return value.type === type && typeof value.name === 'string'
      ? [value.name]
      : []
  })
}

function steamCommunityImageUrl(
  appId: number,
  hash: string,
  extension: 'ico' | 'jpg',
): string {
  return `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appId}/${hash}.${extension}`
}

function decimalString(value: unknown): string | null {
  return typeof value === 'string' && /^\d+$/u.test(value) ? value : null
}

function restriction(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(', ')
  return normalized || null
}
