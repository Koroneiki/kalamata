import { BrowserView, BrowserWindow, Updater } from 'electrobun/bun'

import { createSteamService } from '../backend/index.ts'
import type { AppRpc } from '../types/rpc.ts'

const DEV_SERVER_URL = 'http://localhost:5173'

async function getMainViewUrl(): Promise<string> {
  if ((await Updater.localInfo.channel()) === 'dev') {
    try {
      await fetch(DEV_SERVER_URL, { method: 'HEAD' })
      return DEV_SERVER_URL
    } catch {
      // Fall back to the bundled view when the optional Vite server is not running.
    }
  }

  return 'views://mainview/index.html'
}

const steam = createSteamService()
const rpc = BrowserView.defineRPC<AppRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      async getAppDetails({ appId }) {
        const product = await steam.getProductInfo(appId)
        const associations = Object.values(
          product.appinfo.common?.associations ?? {},
        )

        return {
          appId,
          name: product.appinfo.common?.name ?? `App ${appId}`,
          developers: associations
            .filter(({ type }) => type === 'developer')
            .map(({ name }) => name),
          publishers: associations
            .filter(({ type }) => type === 'publisher')
            .map(({ name }) => name),
        }
      },
    },
  },
})

new BrowserWindow({
  title: 'Kalamata',
  url: await getMainViewUrl(),
  rpc,
})
