import { electroview } from '@/api/transport'

import type { StartDownloadRequest } from '@/types/rpc'

export function getDownloadState() {
  return electroview.rpc!.request.getDownloadState({})
}

export function startDownload(request: StartDownloadRequest) {
  return electroview.rpc!.request.startDownload(request)
}
