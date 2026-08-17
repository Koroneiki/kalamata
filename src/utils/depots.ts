import type {
  AppDepot,
  DepotGroup,
  DepotPlatform,
  EligibleAppDepot,
} from '../types/rpc.ts'

export type { DepotPlatform } from '../types/rpc.ts'

export type InstallableDepotGroup = Extract<DepotGroup, 'Base Game' | 'DLC'>
export interface DepotBadgeItem {
  label: string
  variant: 'outline' | 'destructive'
}

export interface DepotSelectionSummary {
  selected: number
  total: number
  sizeBytes: string | null
  missing: boolean
}

export const installableDepotGroups: InstallableDepotGroup[] = [
  'Base Game',
  'DLC',
]
export const depotPlatforms: DepotPlatform[] = ['windows', 'macos', 'linux']

function isDepotPlatform(value: string): value is DepotPlatform {
  return value === 'windows' || value === 'macos' || value === 'linux'
}

export function filterDepots(
  depots: AppDepot[],
  hideRedistributables: boolean,
  hideUnknownDepots: boolean,
  hideUnusedDepots: boolean,
  hideUnavailableDepots: boolean,
  platforms: readonly DepotPlatform[],
  preservedDepotIds: ReadonlySet<number> = new Set(),
): AppDepot[] {
  const visiblePlatforms = new Set(platforms)
  const hiddenGroups = {
    'Base Game': false,
    DLC: false,
    'Steamworks Common Redistributables': hideRedistributables,
    Unknown: hideUnknownDepots,
    Unused: hideUnusedDepots,
    Unavailable: hideUnavailableDepots,
  } satisfies Record<DepotGroup, boolean>

  return depots.filter((depot) => {
    if (
      preservedDepotIds.has(depot.depotId) ||
      (depot.eligible && depot.installStatus !== 'not-installed')
    )
      return true
    if (hiddenGroups[depot.group]) return false
    return matchesDepotPlatform(depot, visiblePlatforms)
  })
}

export function matchesDepotPlatform(
  depot: AppDepot,
  platforms: ReadonlySet<DepotPlatform> | readonly DepotPlatform[],
): boolean {
  if (!depot.platform) return true
  const visiblePlatforms =
    platforms instanceof Set ? platforms : new Set(platforms)
  return depot.platform.split(',').some((platform) => {
    const normalized = platform.trim().toLowerCase()
    return isDepotPlatform(normalized) && visiblePlatforms.has(normalized)
  })
}

export function installableDepots(depots: AppDepot[]): EligibleAppDepot[] {
  return depots.filter((depot): depot is EligibleAppDepot => depot.eligible)
}

export function depotsInGroup(
  depots: AppDepot[],
  group: InstallableDepotGroup,
): EligibleAppDepot[] {
  return installableDepots(depots).filter((depot) => depot.group === group)
}

export function depotBadges(depot: AppDepot): DepotBadgeItem[] {
  const badges: DepotBadgeItem[] = []

  if (depot.platform) {
    for (const platform of depot.platform.split(',')) {
      const label = platform.trim()
      if (label) badges.push({ label, variant: 'outline' })
    }
  }
  if (depot.language) {
    badges.push({ label: depot.language, variant: 'outline' })
  }
  if (!depot.eligible) return badges

  if (depot.manifestStatus !== 'ready') {
    badges.push({
      label: `Manifest ${depot.manifestStatus}`,
      variant: depot.manifestStatus === 'invalid' ? 'destructive' : 'outline',
    })
  }
  if (depot.keyStatus !== 'present') {
    badges.push({
      label: `Key ${depot.keyStatus}`,
      variant: depot.keyStatus === 'invalid' ? 'destructive' : 'outline',
    })
  }
  if (depot.installStatus === 'current') {
    badges.push({ label: 'Installed', variant: 'outline' })
  } else if (depot.installStatus === 'outdated') {
    badges.push({ label: 'Update available', variant: 'outline' })
  }

  return badges
}

export function summarizeDepots(
  depots: EligibleAppDepot[],
  selectedDepotIds: ReadonlySet<number>,
): DepotSelectionSummary {
  const selected = depots.filter((depot) => selectedDepotIds.has(depot.depotId))
  const hasUnknownSize = selected.some((depot) => depot.sizeBytes === null)
  const sizeBytes = hasUnknownSize
    ? null
    : selected
        .reduce((total, depot) => total + BigInt(depot.sizeBytes ?? '0'), 0n)
        .toString()

  return {
    selected: selected.length,
    total: depots.length,
    sizeBytes,
    missing: depots.some(
      (depot) =>
        depot.manifestStatus !== 'ready' || depot.keyStatus !== 'present',
    ),
  }
}
