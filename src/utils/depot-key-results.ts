import type { AcquiredDepotKeys, HubcapDepotKeyOutcome } from '../types/rpc.ts'

export function acquiredDepotKeysResult(
  depotIds: number[],
  acquiredDepotIds: Iterable<number>,
  hubcap?: HubcapDepotKeyOutcome,
): AcquiredDepotKeys {
  const acquired = new Set(acquiredDepotIds)
  const result: AcquiredDepotKeys = {
    acquiredDepotIds: depotIds.filter((depotId) => acquired.has(depotId)),
    missingDepotIds: depotIds.filter((depotId) => !acquired.has(depotId)),
  }
  if (hubcap) result.hubcap = hubcap
  return result
}
