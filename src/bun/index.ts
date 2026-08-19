import Electrobun, {
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from 'electrobun/bun'

import { createSteamService } from '../backend/index.ts'
import { AppService } from '../backend/apps/app-service.ts'
import { ColdClientDependencyService } from '../backend/cold-client/dependency-service.ts'
import { ColdClientMutationMutex } from '../backend/cold-client/mutation-mutex.ts'
import { ColdClientOperationCoordinator } from '../backend/cold-client/operation-coordinator.ts'
import { ColdClientGameInspector } from '../backend/cold-client/game-inspector.ts'
import { ColdClientGenerator } from '../backend/cold-client/generator.ts'
import { ColdClientInterfaceGenerator } from '../backend/cold-client/interface-generator.ts'
import { ColdClientReplacementService } from '../backend/cold-client/replacement.ts'
import { ColdClientService } from '../backend/cold-client/service.ts'
import { DownloadQueueCoordinator } from '../backend/operations/download-queue.ts'
import {
  getResumableApplicationTransaction,
  hasRepairFallback,
  recoverApplicationTransaction,
} from '../backend/depot/install/transaction/recovery.ts'
import { openKalamataDatabase } from '../db/index.ts'
import { canonicalizeInstallDirectory } from '../db/validation.ts'
import type { AppRpc, AppSettings, DepotPlatform } from '../types/rpc.ts'
import { validatedRpcHandlers } from '../types/rpc-schemas.ts'
import packageJson from '../../package.json' with { type: 'json' }
import { Diagnostics } from './diagnostics.ts'

const DEV_SERVER_URL = 'http://localhost:5173'
const diagnostics = new Diagnostics(Utils.paths.userData)
diagnostics.info({
  event: 'app.started',
  version: packageJson.version,
  platform: process.platform,
  architecture: process.arch,
})

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
const steam = createSteamService((appIds, countryCode, error) => {
  diagnostics.error({
    event: 'product-info.package-discovery-failed',
    appIds,
    countryCode,
    error,
  })
})
// Warm the shared fallback without delaying the main window.
void steam.initializeDepotKeyCache(database).catch((error) => {
  diagnostics.error({
    event: 'depot-key-cache.initialization-failed',
    error: error instanceof Error ? error : new Error(String(error)),
  })
})
const appService = new AppService(steam, database)
const coldClientMutex = new ColdClientMutationMutex()
const coldClientOperations = new ColdClientOperationCoordinator(
  coldClientMutex,
  (snapshot) => {
    if (rpcReady) rpc.send.coldClientOperationChanged(snapshot)
  },
)
const coldClientDependencies = new ColdClientDependencyService(
  Utils.paths.userData,
  {
    mutex: coldClientMutex,
    reportCleanupError: (error) =>
      diagnostics.error({
        event: 'cold-client-dependencies.cleanup-failed',
        error,
      }),
  },
)
const coldClientInspector = new ColdClientGameInspector(
  database,
  steam,
  coldClientDependencies,
)
const coldClientGenerator = new ColdClientGenerator(coldClientDependencies)
const coldClientInterfaceGenerator = new ColdClientInterfaceGenerator()
const coldClientReplacement = new ColdClientReplacementService(database, {
  reportCleanupError: (error) =>
    diagnostics.error({
      event: 'cold-client-replacement.cleanup-failed',
      error,
    }),
})
const coldClient = new ColdClientService(
  database,
  coldClientDependencies,
  coldClientInspector,
  coldClientGenerator,
  coldClientInterfaceGenerator,
  coldClientOperations,
  coldClientReplacement,
)
let coldClientDependenciesReady = false
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
  hubcapApiKey: '',
  hideRedistributables: true,
  hideUnknownDepots: true,
  hideUnusedDepots: true,
  hideUnavailableDepots: true,
  platforms: [systemPlatform],
}
const rpc = BrowserView.defineRPC<AppRpc>({
  handlers: {
    requests: validatedRpcHandlers({
      async getAppSummary({ appId }) {
        return appService.getAppSummary(appId)
      },
      async getAppDetails({ appId }) {
        return appService.getAppDetails(appId)
      },
      async checkAvailableUpdate({ appId }) {
        return appService.checkAvailableUpdate(appId)
      },
      async checkAvailableUpdates({ appIds }) {
        return appService.checkAvailableUpdates(appIds)
      },
      openInstallDirectory({ appId }) {
        const installPath = database.getLibraryEntry(appId)?.installPath
        if (!installPath || !Utils.openPath(installPath))
          throw new Error('The local files folder could not be opened')
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
      getHubcapUsage() {
        return steam.getHubcapUsage(database)
      },
      openUserDataFolder() {
        if (!Utils.openPath(Utils.paths.userData))
          throw new Error('The user data folder could not be opened')
      },
      getColdClientDependencies() {
        return coldClientDependencies.getStatus()
      },
      checkColdClientDependencyUpdates() {
        return coldClientDependencies.checkForUpdates()
      },
      updateColdClientDependencies({ dependencyIds }) {
        return coldClientDependencies.updateDependencies(dependencyIds)
      },
      async openColdClientLoginDirectory() {
        const directory = (await coldClientDependencies.getStatus())
          .loginDirectory
        if (!directory || !Utils.openPath(directory)) {
          throw new Error('The GSE Tools login folder could not be opened')
        }
      },
      inspectColdClientSetup({ appId }) {
        return coldClientInspector.inspect(appId)
      },
      getColdClientStatus({ appId }) {
        return coldClient.getStatus(appId)
      },
      configureColdClient(request) {
        return coldClient.configure(request)
      },
      getColdClientOperation() {
        return coldClientOperations.getSnapshot()
      },
      cancelColdClientOperation({ appId }) {
        return coldClientOperations.cancel(appId)
      },
      addLibraryEntry({ appId }) {
        return database.addLibraryEntry(appId)
      },
      removeLibraryEntry({ appId }) {
        const coldClientOperation = coldClientOperations.getSnapshot()
        if (
          queue.isBusyForApp(appId) ||
          (coldClientOperation.status === 'active' &&
            coldClientOperation.appId === appId)
        ) {
          throw new Error(
            'Wait for the download to finish before removing this game',
          )
        }
        database.removeLibraryEntry(appId)
      },
      setDepotPinned({ appId, depotId, pinned }) {
        if (queue.isBusyForApp(appId))
          throw new Error(
            'Wait for the download to finish before pinning a depot',
          )
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
      getDownloadQueue() {
        return queue.getDownloadQueue()
      },
      removeQueuedOperation({ id }) {
        return queue.removeQueuedOperation(id)
      },
      prioritizeQueuedOperation({ id }) {
        return queue.prioritizeQueuedOperation(id)
      },
    }),
  },
})

let lastOperationEvent = 'idle'
queue = new DownloadQueueCoordinator(
  steam,
  database,
  (snapshot) => {
    if (rpcReady) rpc.send.downloadQueueChanged(snapshot)
    const state = snapshot.operation
    const operationEvent =
      state.status === 'active'
        ? `${state.status}:${state.phase}`
        : state.status
    if (operationEvent === lastOperationEvent) return
    lastOperationEvent = operationEvent
    diagnostics.info({
      event: 'operation.state-changed',
      status: state.status,
      phase: 'phase' in state ? state.phase : undefined,
      kind: 'kind' in state ? state.kind : undefined,
      appId: 'appId' in state ? state.appId : undefined,
      operationError: 'error' in state ? state.error : undefined,
    })
  },
  (error, context) =>
    diagnostics.error({ event: 'operation.failed', error, ...context }),
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
    diagnostics.info({ event: 'app.shutdown-started' })
    void (async () => {
      try {
        await startup.catch(() => {})
        const results = await Promise.allSettled([
          queue.shutdown(),
          coldClientOperations.shutdown(),
          coldClientDependencies.shutdown(),
          steam.shutdownManifestAcquisitions(),
          steam.shutdownDepotKeyAcquisitions(),
        ])
        const failures = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length > 0)
          throw new AggregateError(failures, 'Service shutdown failed')
      } finally {
        try {
          steam.dispose()
        } finally {
          database.close()
        }
      }
      diagnostics.info({ event: 'app.shutdown-completed' })
      allowQuit = true
      Utils.quit()
    })().catch((error) => {
      diagnostics.error({
        event: 'app.shutdown-failed',
        error: error instanceof Error ? error : new Error(String(error)),
      })
      allowQuit = true
      Utils.quit()
    })
  },
)

startup = (async () => {
  try {
    await coldClientDependencies.initialize(
      new Set(
        database
          .getColdClientInstallations()
          .map((installation) => installation.gbeAssetId),
      ),
    )
    coldClientDependenciesReady = true
  } catch (error) {
    diagnostics.error({
      event: 'cold-client-dependencies.initialization-failed',
      error: error instanceof Error ? error : new Error(String(error)),
    })
  }
  // Recover commits before restoring one staging operation; surface any repair
  // requirements only after resumable work has claimed the singleton queue.
  const recoveryFailures: Array<{ appId: number; installPath: string }> = []
  for (const entry of database.getLibrary()) {
    if (!entry.installPath) continue
    try {
      const result = await coldClient.recover(entry.appId, entry.installPath)
      if (result.status === 'invalid') {
        recoveryFailures.push({
          appId: entry.appId,
          installPath: entry.installPath,
        })
      }
    } catch (error) {
      diagnostics.error({
        event: 'recovery.failed',
        error: error instanceof Error ? error : new Error(String(error)),
        appId: entry.appId,
      })
      recoveryFailures.push({
        appId: entry.appId,
        installPath: entry.installPath,
      })
    }
  }
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
      if (
        !resumable &&
        !repairFallback &&
        !database.hasQueuedApplication(entry.appId)
      )
        database.clearUnusedInstallPath(entry.appId)
    } catch (error) {
      diagnostics.error({
        event: 'recovery.failed',
        error: error instanceof Error ? error : new Error(String(error)),
        appId: entry.appId,
      })
      recoveryFailures.push({
        appId: entry.appId,
        installPath: entry.installPath,
      })
    }
  }
  await queue.restoreInterrupted()
  for (const recoveryFailure of recoveryFailures)
    queue.markRepairRequired(recoveryFailure.appId, recoveryFailure.installPath)
  await queue.startPending()
  if (process.platform === 'win32' && coldClientDependenciesReady) {
    // Release discovery updates Settings state but never downloads assets.
    void coldClientDependencies.checkForUpdates()
  }
})()
await startup

new BrowserWindow({
  title: 'Kalamata',
  frame: {
    x: 0,
    y: 0,
    width: 1000,
    height: 800,
  },
  url: await getMainViewUrl(),
  rpc,
})
rpcReady = true
diagnostics.info({ event: 'app.ready' })
