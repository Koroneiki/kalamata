import type {
  DownloadQueueSnapshot,
  OperationState,
  PendingDownload,
} from '../types/rpc.ts'

export function acceptedIntentAppIds(snapshot: DownloadQueueSnapshot) {
  const appIds = new Set([
    ...snapshot.pending.map(({ appId }) => appId),
    ...snapshot.repairRequiredAppIds,
  ])
  const operation = snapshot.operation
  if (
    operation.status === 'active' ||
    operation.status === 'paused' ||
    operation.status === 'resumable' ||
    operation.status === 'repair-required'
  )
    appIds.add(operation.appId)
  return appIds
}

export function isAppInDownloads(
  state: OperationState,
  pending: PendingDownload[],
  repairRequiredAppIds: number[],
  appId: number,
) {
  return (
    repairRequiredAppIds.includes(appId) ||
    pending.some((item) => item.appId === appId) ||
    (state.status !== 'idle' &&
      'appId' in state &&
      state.appId === appId &&
      ['active', 'paused', 'resumable', 'failed', 'repair-required'].includes(
        state.status,
      ))
  )
}

export function resolveAcceptedDesiredDepotIds(
  state: OperationState,
  pending: PendingDownload[],
  appId: number,
): number[] | null {
  const queued = pending.find(
    (item) => item.appId === appId && item.kind !== 'repair',
  )
  if (queued) return [...queued.desiredDepotIds]
  if (
    (state.status === 'active' ||
      state.status === 'paused' ||
      state.status === 'resumable') &&
    state.appId === appId &&
    state.kind !== 'repair'
  )
    return [...state.desiredDepotIds]
  return null
}
