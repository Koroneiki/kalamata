import { electroview } from '@/api/transport'

export function getAppSummary(appId: number) {
  return electroview.rpc!.request.getAppSummary({ appId })
}

export function getAppDetails(appId: number) {
  return electroview.rpc!.request.getAppDetails({ appId })
}

export function acquireManifest(
  appId: number,
  depotId: number,
  manifestId: string,
) {
  return electroview.rpc!.request.acquireManifest({
    appId,
    depotId,
    manifestId,
  })
}
