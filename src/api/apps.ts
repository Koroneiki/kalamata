import { Electroview } from 'electrobun/view'

import type { AppRpc } from '@/types/rpc'

const rpc = Electroview.defineRPC<AppRpc>({
  maxRequestTime: 30_000,
  handlers: {},
})
const electroview = new Electroview({ rpc })

export function getAppDetails(appId: number) {
  return electroview.rpc!.request.getAppDetails({ appId })
}
