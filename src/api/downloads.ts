import { request as rpcRequest } from '@/api/transport'

import type { StartDownloadRequest } from '@/types/rpc'

export function startDownload(request: StartDownloadRequest) {
  return rpcRequest('startDownload', request)
}
