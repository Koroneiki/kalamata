import type { AppDepot, AppDetails, AppSummary } from '../../types/rpc.ts'
import type { KalamataDatabase } from '../../db/database.ts'
import { validateManagedManifest } from '../../db/manifest-files.ts'
import { depotKeyFromHex } from '../../db/validation.ts'
import type { ProductInfo } from './types.ts'

export interface PublicDepot {
  depotId: number
  platform: string | null
  language: string | null
  manifestId: string | null
  sizeBytes: string | null
  downloadBytes: string | null
}

export function normalizeAppSummary(product: ProductInfo): AppSummary {
  const common = asRecord(product.appinfo.common)
  const associations = Object.values(asRecord(common.associations))
  const developers = associations.flatMap((association) => {
    const value = asRecord(association)
    return value.type === 'developer' && typeof value.name === 'string'
      ? [value.name]
      : []
  })
  const releaseSeconds = decimalString(common.steam_release_date)
  const releaseDate = releaseSeconds ? Number(releaseSeconds) * 1000 : NaN
  const headerImages = asRecord(common.header_image)
  const header =
    stringValue(headerImages.english) ??
    Object.values(headerImages).find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ) ??
    null

  return {
    appId: product.appId,
    name: stringValue(common.name) ?? `App ${product.appId}`,
    developers,
    releaseDate: Number.isSafeInteger(releaseDate) ? releaseDate : null,
    artworkUrl: header
      ? `https://cdn.akamai.steamstatic.com/steam/apps/${product.appId}/${header}`
      : null,
  }
}

export function extractPublicDepots(product: ProductInfo): PublicDepot[] {
  const depots = asRecord(asRecord(product.appinfo).depots)
  const result: PublicDepot[] = []
  for (const [rawDepotId, rawDepot] of Object.entries(depots)) {
    if (!/^[1-9]\d*$/u.test(rawDepotId)) continue
    const depotId = Number(rawDepotId)
    if (!Number.isInteger(depotId) || depotId > 0xffffffff) continue
    const depot = asRecord(rawDepot)
    const config = asRecord(depot.config)
    const publicManifest = asRecord(asRecord(depot.manifests).public)
    result.push({
      depotId,
      platform: restriction(config.oslist),
      language: restriction(config.language),
      manifestId: decimalString(publicManifest.gid),
      sizeBytes: decimalString(publicManifest.size),
      downloadBytes: decimalString(publicManifest.download),
    })
  }
  return result.sort((left, right) => left.depotId - right.depotId)
}

export async function normalizeAppDetails(
  product: ProductInfo,
  database: KalamataDatabase,
): Promise<AppDetails> {
  const library = database.getLibraryEntry(product.appId)
  const installs = new Map(
    database
      .getInstalls(product.appId)
      .map((row) => [row.depotId, row.installedManifestId]),
  )
  const depots: AppDepot[] = []
  for (const depot of extractPublicDepots(product)) {
    const keyText = database.getDepotKey(depot.depotId)
    let key: Buffer | undefined
    let keyStatus: AppDepot['keyStatus'] = 'missing'
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
    let manifestStatus: AppDepot['manifestStatus'] = rows.length
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
    const installStatus: AppDepot['installStatus'] = !installed
      ? 'not-installed'
      : installed === depot.manifestId
        ? 'current'
        : 'outdated'
    depots.push({
      ...depot,
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
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
