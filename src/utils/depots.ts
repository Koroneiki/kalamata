import type { AppDepot, DepotGroup, EligibleAppDepot } from '../types/rpc.ts'

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

export function installableDepots(depots: AppDepot[]): EligibleAppDepot[] {
  return depots.filter((depot): depot is EligibleAppDepot => depot.eligible)
}

export function depotsInGroup(
  depots: AppDepot[],
  group: InstallableDepotGroup,
): EligibleAppDepot[] {
  return installableDepots(depots)
    .filter((depot) => depot.group === group)
    .sort((left, right) => left.depotId - right.depotId)
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
  if (depot.keyStatus !== 'ready') {
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
        depot.manifestStatus !== 'ready' || depot.keyStatus !== 'ready',
    ),
  }
}
