import type SteamUser from 'steam-user'

export interface ContentServer {
  Host: string
  vhost?: string
  https_support?: string
  usetokenauth?: number
  weightedload?: number
  NumEntriesInClientList?: number
  [key: string]: unknown
}

export interface SteamContentUser extends SteamUser {
  getContentServers(appId: number): Promise<{ servers: ContentServer[] }>
  getCDNAuthToken(
    appId: number,
    depotId: number,
    hostname: string,
  ): Promise<{ token: string }>
}

export interface ProductInfo {
  appId: number
  changenumber: number
  missingToken: boolean
  appinfo: SteamUser.AppInfoContent
}

export interface ProductInfoResult {
  baseProduct: ProductInfo
  dlcProducts: ProductInfo[]
}
