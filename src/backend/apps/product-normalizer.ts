import type {
  AppDepot,
  AppDetails,
  AppSummary,
  DepotGroup,
  EligibleAppDepot,
} from '../../types/rpc.ts'
import type { KalamataDatabase } from '../../db/database.ts'
import { z } from 'zod'
import { validateManagedManifest } from '../../db/manifest-files.ts'
import { depotKeyFromHex } from '../../db/validation.ts'
import type { ProductInfo, ProductInfoResult } from '../steam/types.ts'
import { manifestIdSchema, steamIdStringSchema } from '../../types/schemas.ts'

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
): PublicDepot[] {
  const result: PublicDepot[] = []
  const seen = new Set<number>()
  const productNames = new Map(
    [products.baseProduct, ...products.dlcProducts].map((product) => [
      product.appId,
      stringValue(asRecord(product.appinfo.common).name),
    ]),
  )
  for (const product of [products.baseProduct, ...products.dlcProducts]) {
    const depots = asRecord(asRecord(product.appinfo).depots)
    const entries = Object.entries(depots)
      .flatMap(([rawDepotId, rawDepot]) => {
        const result = steamIdStringSchema.safeParse(rawDepotId)
        return result.success ? [{ depotId: result.data, rawDepot }] : []
      })
      .sort((left, right) => left.depotId - right.depotId)
    for (const { depotId, rawDepot } of entries) {
      if (seen.has(depotId)) continue
      seen.add(depotId)
      const depot = asRecord(rawDepot)
      const config = asRecord(depot.config)
      const publicManifest = asRecord(asRecord(depot.manifests).public)
      // Steam can list a DLC depot under the base app. In that case dlcappid is
      // the authoritative classification and download owner (for example 323320/353590).
      const dlcAppId = positiveId(depot.dlcappid)
      const group = classifyDepot(
        depotId,
        product.appId === products.baseProduct.appId,
        dlcAppId !== null,
        dlcAppId === null || productNames.has(dlcAppId),
        publicManifest,
      )
      const ownerAppId = dlcAppId ?? product.appId
      result.push({
        depotId,
        ownerAppId,
        ownerAppName:
          group === 'Unknown'
            ? `Unknown App ${ownerAppId}`
            : group === 'DLC'
              ? (productNames.get(ownerAppId) ?? null)
              : null,
        group,
        platform: restriction(config.oslist),
        language: restriction(config.language),
        manifestId: decimalString(publicManifest.gid),
        sizeBytes: decimalString(publicManifest.size),
        downloadBytes: decimalString(publicManifest.download),
        mountIndex: result.length,
      })
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
  const publicDepots = extractPublicDepots(products)
  const publicDepotIds = new Set(publicDepots.map(({ depotId }) => depotId))
  for (const depot of publicDepots) {
    const { group, ...depotFields } = depot
    if (!isEligibleGroup(group)) {
      depots.push({
        ...depotFields,
        installedManifestId: null,
        pinned: false,
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
        keyStatus = 'present'
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
      : installed.pinned || installed.installedManifestId === depot.manifestId
        ? 'current'
        : 'outdated'
    depots.push({
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
    })
  }
  // Missing Steam metadata must not hide installed depots from removal.
  for (const installed of installedRows) {
    if (publicDepotIds.has(installed.depotId)) continue
    const keyText = database.getDepotKey(installed.depotId)
    let key: Buffer | undefined
    let keyStatus: EligibleAppDepot['keyStatus'] = 'missing'
    if (keyText !== null) {
      try {
        key = depotKeyFromHex(keyText)
        keyStatus = 'present'
      } catch {
        keyStatus = 'invalid'
      }
    }
    const manifest = database
      .getManifestRows(installed.depotId)
      .find(({ manifestId }) => manifestId === installed.installedManifestId)
    let manifestStatus: EligibleAppDepot['manifestStatus'] = manifest
      ? 'invalid'
      : 'missing'
    if (manifest) {
      try {
        await validateManagedManifest(
          database.dataRoot,
          installed.depotId,
          installed.installedManifestId,
          manifest.relativePath,
          key,
        )
        manifestStatus = 'ready'
      } catch {
        manifestStatus = 'invalid'
      }
    }
    depots.push({
      depotId: installed.depotId,
      mountIndex: installed.mountIndex,
      ownerAppId: installed.ownerAppId ?? product.appId,
      ownerAppName: null,
      group:
        (installed.ownerAppId ?? product.appId) === product.appId
          ? 'Base Game'
          : 'DLC',
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
    })
  }
  const availableSelectionIds = new Set(
    depots.filter((depot) => depot.eligible).map(({ depotId }) => depotId),
  )
  return {
    ...normalizeAppSummary(product),
    inLibrary: library !== null,
    installPath: library?.installPath ?? null,
    selectedDepotIds: library
      ? database
          .getSelectedDepotIds(product.appId)
          .filter((depotId) => availableSelectionIds.has(depotId))
      : [],
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
  hasDlcOwner: boolean,
  ownerKnown: boolean,
  publicManifest: Record<string, unknown>,
): DepotGroup {
  if (isSteamworksDepot(depotId)) return 'Steamworks Common Redistributables'
  if (
    rawEmpty(publicManifest.gid) &&
    rawEmpty(publicManifest.size) &&
    rawEmpty(publicManifest.download)
  )
    return 'Unused'
  if (hasDlcOwner && !ownerKnown) return 'Unknown'
  // DLC is identified either explicitly by dlcappid or by the depot belonging
  // to a separately fetched DLC product.
  if (hasDlcOwner) return 'DLC'
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
  const result = recordSchema.safeParse(value)
  return result.success ? result.data : {}
}

function stringValue(value: unknown): string | null {
  return stringValueSchema.parse(value)
}

function associationNames(
  associations: unknown[],
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

function decimalString(value: unknown): string | null {
  return decimalStringSchema.parse(value)
}

function positiveId(value: unknown): number | null {
  return positiveIdSchema.parse(value)
}

function restriction(value: unknown): string | null {
  return restrictionSchema.parse(value)
}

const recordSchema = z.record(z.string(), z.unknown())
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
