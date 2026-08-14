import { request } from '@/api/transport'

export function getAppSummary(appId: number) {
  return request('getAppSummary', { appId })
}

export function getAppDetails(appId: number) {
  return request('getAppDetails', { appId })
}

export function openInstallDirectory(appId: number) {
  return request('openInstallDirectory', { appId })
}

export function acquireManifest(
  appId: number,
  depotId: number,
  manifestId: string,
) {
  return request('acquireManifest', {
    appId,
    depotId,
    manifestId,
  })
}

export function acquireDepotKeys(appId: number, depotIds: number[]) {
  return request('acquireDepotKeys', { appId, depotIds })
}
