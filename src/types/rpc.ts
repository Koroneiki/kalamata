export interface AppDetails {
  appId: number
  name: string
  developers: string[]
  publishers: string[]
}

export type AppRpc = {
  bun: {
    requests: {
      getAppDetails: {
        params: { appId: number }
        response: AppDetails
      }
    }
    messages: Record<never, never>
  }
  webview: {
    requests: Record<never, never>
    messages: Record<never, never>
  }
}
