import type SteamUser from 'steam-user'

export interface ContentServer {
  Host: string
  vhost?: string
  https_support?: string
  usetokenauth?: number
  weightedload?: number
  NumEntriesInClientList?: number
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
  listedDlcAppIds: number[]
  dlcProducts: ProductInfo[]
  eligibleBaseDepotIds: ReadonlySet<number> | null
  eligibleDlcDepotIds: ReadonlyMap<number, ReadonlySet<number>>
}
