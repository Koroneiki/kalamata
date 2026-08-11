import Electrobun, {
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from 'electrobun/bun'

import { createSteamService } from '../backend/index.ts'
import { AppService } from '../backend/apps/app-service.ts'
import { DownloadQueueCoordinator } from '../backend/operations/download-queue.ts'
import {
  recoverApplicationTransaction,
} from '../backend/depot/install/transaction/recovery.ts'
import { openKalamataDatabase } from '../db/index.ts'
import { syncManifestFiles } from '../db/manifest-files.ts'
import { canonicalizeInstallDirectory } from '../db/validation.ts'
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

const database = await openKalamataDatabase(Utils.paths.userData)
await syncManifestFiles(database)
const steam = createSteamService()
const appService = new AppService(steam, database)
let queue: DownloadQueueCoordinator
const rpc = BrowserView.defineRPC<AppRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      async getAppSummary({ appId }) {
        return appService.getAppSummary(appId)
      },
      async getAppDetails({ appId }) {
        return appService.getAppDetails(appId)
      },
      getLibrary() {
        return database.getLibrary()
      },
      addLibraryEntry({ appId }) {
        return database.addLibraryEntry(appId)
      },
      removeLibraryEntry({ appId }) {
        if (queue.isBusyForApp(appId)) {
          throw new Error('A game cannot be removed while it is downloading')
        }
        database.removeLibraryEntry(appId)
      },
      setSelectedDepots({ appId, depotIds }) {
        return appService.setSelectedDepots(appId, depotIds)
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
      queueDepotUpdate(request) {
        return queue.queueDepotUpdate(request)
      },
      repairApplication(request) {
        return queue.repairApplication(request)
      },
      cancelOperation() {
        return queue.cancel()
      },
      pauseOperation() {
        return queue.pause()
      },
      resumeOperation() {
        return queue.resume()
      },
      getOperationState() {
        return queue.getOperationState()
      },
    },
  },
})

queue = new DownloadQueueCoordinator(
  steam,
  database,
  (state) => {
    rpc.send.downloadStateChanged(state)
  },
  (state) => {
    rpc.send.operationStateChanged(state)
  },
)

let shutdownStarted = false
let allowQuit = false
let startup = Promise.resolve()
Electrobun.events.on(
  'before-quit',
  (event: { response: { allow: boolean } | undefined }) => {
    if (allowQuit) {
      event.response = { allow: true }
      return
    }
    event.response = { allow: false }
    if (shutdownStarted) return
    shutdownStarted = true
    void (async () => {
      try {
        await startup.catch(() => {})
        await queue.shutdown()
      } finally {
        steam.dispose()
        try {
          database.close()
        } finally {
          allowQuit = true
          Utils.quit()
        }
      }
    })().catch(() => {})
  },
)

startup = (async () => {
  // Recover commits before restoring one staging operation; surface any repair
  // requirements only after resumable work has claimed the singleton queue.
  const recoveryFailures: Array<{ appId: number; installPath: string }> = []
  for (const entry of database.getLibrary()) {
    if (!entry.installPath) continue
    try {
      await recoverApplicationTransaction(entry.installPath, {
        appId: entry.appId,
        reconcile: async (desired) =>
          database.reconcileInstalledDepots(
            entry.appId,
            entry.installPath!,
            desired.map(({ depotId, manifestId, mountIndex, ownerAppId }) => ({
              depotId,
              manifestId,
              mountIndex,
              ownerAppId,
            })),
          ),
      })
    } catch {
      recoveryFailures.push({
        appId: entry.appId,
        installPath: entry.installPath,
      })
    }
  }
  await queue.restoreInterrupted()
  for (const recoveryFailure of recoveryFailures)
    queue.markRepairRequired(
      recoveryFailure.appId,
      recoveryFailure.installPath,
    )
})()
await startup

new BrowserWindow({
  title: 'Kalamata',
  url: await getMainViewUrl(),
  rpc,
})
