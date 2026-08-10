import { BrowserView, BrowserWindow, Updater, Utils } from 'electrobun/bun'

import { createSteamService } from '../backend/index.ts'
import { FoundationService } from '../backend/foundation-service.ts'
import { openKalamataDatabase } from '../db/index.ts'
import { syncManifestFiles } from '../db/manifest-files.ts'
import { canonicalizeInstallDirectory } from '../db/validation.ts'
import type { AppRpc } from '../types/rpc.ts'
import { DownloadQueueCoordinator } from './download-queue.ts'

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

const database = await openKalamataDatabase(Utils.paths.userData)
await syncManifestFiles(database)
const steam = createSteamService()
const foundation = new FoundationService(steam, database)
let queue: DownloadQueueCoordinator
const rpc = BrowserView.defineRPC<AppRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      async getAppSummary({ appId }) {
        return foundation.getAppSummary(appId)
      },
      async getAppDetails({ appId }) {
        return foundation.getAppDetails(appId)
      },
      getLibrary() {
        return database.getLibrary()
      },
      addLibraryEntry({ appId }) {
        return database.addLibraryEntry(appId)
      },
      removeLibraryEntry({ appId }) {
        const state = queue.getState()
        if (state.status === 'running' && state.appId === appId) {
          throw new Error('A game cannot be removed while it is downloading')
        }
        database.removeLibraryEntry(appId)
      },
      setSelectedDepots({ appId, depotIds }) {
        return database.replaceSelectedDepotIds(appId, depotIds)
      },
      async selectInstallDirectory({ startingPath }) {
        const selected = await Utils.openFileDialog({
          startingFolder: startingPath ?? Utils.paths.home,
          allowedFileTypes: '*',
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        })
        const path = selected[0]
        return path ? (await canonicalizeInstallDirectory(path)).path : null
      },
      getDownloadState() {
        return queue.getState()
      },
      startDownload(request) {
        return queue.start(request)
      },
    },
  },
})

queue = new DownloadQueueCoordinator(steam, database, (state) => {
  rpc.send.downloadStateChanged(state)
})

new BrowserWindow({
  title: 'Kalamata',
  url: await getMainViewUrl(),
  rpc,
})
