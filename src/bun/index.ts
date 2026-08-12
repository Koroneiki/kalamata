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
  getResumableApplicationTransaction,
  hasRepairFallback,
  recoverApplicationTransaction,
} from '../backend/depot/install/transaction/recovery.ts'
import { openKalamataDatabase } from '../db/index.ts'
import { canonicalizeInstallDirectory } from '../db/validation.ts'
import type { AppRpc, AppSettings, DepotPlatform } from '../types/rpc.ts'

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
const steam = createSteamService()
// Warm the shared fallback without delaying the main window.
void steam.initializeDepotKeyCache(database).catch(() => {})
const appService = new AppService(steam, database)
let queue: DownloadQueueCoordinator
// Recovery runs before BrowserWindow attaches the RPC transport.
let rpcReady = false
const systemPlatform: DepotPlatform =
  process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : 'linux'
const defaultSettings: AppSettings = {
  automaticManifestAcquisition: true,
  hideRedistributables: true,
  hideUnknownDepots: true,
  hideUnusedDepots: true,
  platforms: [systemPlatform],
}
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
      acquireManifest(request) {
        return steam.acquireManifest(database, request)
      },
      acquireDepotKeys(request) {
        return steam.acquireDepotKeys(database, request)
      },
      getLibrary() {
        return database.getLibrary()
      },
      getSettings() {
        return database.getSettings(defaultSettings)
      },
      updateSettings(settings) {
        return database.updateSettings(settings)
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
      setDepotPinned({ appId, depotId, pinned }) {
        if (queue.isBusyForApp(appId))
          throw new Error('A depot cannot be pinned while it is downloading')
        return database.setDepotPinned(appId, depotId, pinned)
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
      startDownload(request) {
        return queue.start(request)
      },
      queueDepotUpdate(request) {
        return queue.queueDepotUpdate(request)
      },
      previewApplicationOperation(request) {
        return queue.previewApplicationOperation(request)
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

queue = new DownloadQueueCoordinator(steam, database, (state) => {
  if (rpcReady) rpc.send.operationStateChanged(state)
})

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
        await steam.shutdownManifestAcquisitions()
        await steam.shutdownDepotKeyAcquisitions()
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
            desired.map(
              ({ depotId, manifestId, pinned, mountIndex, ownerAppId }) => ({
                depotId,
                manifestId,
                pinned,
                mountIndex,
                ownerAppId,
              }),
            ),
          ),
      })
      const resumable = await getResumableApplicationTransaction(
        entry.installPath,
        entry.appId,
      )
      const repairFallback = await hasRepairFallback(entry.installPath)
      if (repairFallback) {
        recoveryFailures.push({
          appId: entry.appId,
          installPath: entry.installPath,
        })
      }
      // Pending staging and repair evidence keep first-install paths reserved.
      if (!resumable && !repairFallback)
        database.clearUnusedInstallPath(entry.appId)
    } catch {
      recoveryFailures.push({
        appId: entry.appId,
        installPath: entry.installPath,
      })
    }
  }
  await queue.restoreInterrupted()
  for (const recoveryFailure of recoveryFailures)
    queue.markRepairRequired(recoveryFailure.appId, recoveryFailure.installPath)
})()
await startup

new BrowserWindow({
  title: 'Kalamata',
  url: await getMainViewUrl(),
  rpc,
})
rpcReady = true
