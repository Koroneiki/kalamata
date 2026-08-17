import type { AvailableUpdateResult, LibraryEntry } from '../types/rpc.ts'
import { AVAILABLE_UPDATE_BATCH_SIZE } from '../types/available-updates.ts'

interface AvailableUpdateScanDependencies {
  getLibrary: () => Promise<LibraryEntry[]>
  check: (appId: number) => Promise<AvailableUpdateResult>
  checkBatch: (appIds: number[]) => Promise<AvailableUpdateResult[]>
  commit: (appId: number, result: AvailableUpdateResult) => void
  clear: (appId: number) => void
  remove: (appId: number) => void
  scanError: (message: string | null) => void
  progress: (state: {
    running: boolean
    checked: number
    total: number
  }) => void
}

export class AvailableUpdateScan {
  private appIds: number[] = []
  private generation = 0
  private fullScan: Promise<void> | undefined
  private serial = Promise.resolve()
  private readonly inFlight = new Map<number, Promise<AvailableUpdateResult>>()

  constructor(private readonly dependencies: AvailableUpdateScanDependencies) {}

  refreshAll() {
    if (this.fullScan) return this.fullScan
    const scanGeneration = ++this.generation
    for (const appId of this.appIds) this.dependencies.clear(appId)
    this.dependencies.scanError(null)
    this.dependencies.progress({ running: true, checked: 0, total: 0 })
    this.fullScan = (async () => {
      let scanAppIds: number[] = []
      let checked = 0
      try {
        let library: LibraryEntry[]
        try {
          library = await this.dependencies.getLibrary()
        } catch {
          if (scanGeneration === this.generation) {
            this.dependencies.scanError(
              'Could not load the library to check for updates.',
            )
          }
          return
        }
        if (scanGeneration !== this.generation) return
        this.appIds = library.flatMap(({ appId, hasInstalledDepots }) =>
          hasInstalledDepots ? [appId] : [],
        )
        scanAppIds = [...this.appIds]
        this.dependencies.progress({
          running: true,
          checked: 0,
          total: scanAppIds.length,
        })
        for (
          let offset = 0;
          offset < scanAppIds.length;
          offset += AVAILABLE_UPDATE_BATCH_SIZE
        ) {
          const batch = scanAppIds.slice(
            offset,
            offset + AVAILABLE_UPDATE_BATCH_SIZE,
          )
          for (const request of this.checkApps(batch, scanGeneration)) {
            try {
              await request
            } catch {
              // Request failures are normally converted to app results by the API.
            }
            if (scanGeneration !== this.generation) return
            checked += 1
            this.dependencies.progress({
              running: true,
              checked,
              total: scanAppIds.length,
            })
          }
        }
      } finally {
        if (scanGeneration === this.generation) {
          this.dependencies.progress({
            running: false,
            checked,
            total: scanAppIds.length,
          })
        }
        this.fullScan = undefined
      }
    })()
    return this.fullScan
  }

  async retry(appIds: number[]) {
    this.dependencies.progress({
      running: true,
      checked: 0,
      total: appIds.length,
    })
    let checked = 0
    try {
      for (const appId of appIds) {
        await this.checkApp(appId)
        checked += 1
        this.dependencies.progress({
          running: true,
          checked,
          total: appIds.length,
        })
      }
    } finally {
      this.dependencies.progress({
        running: false,
        checked,
        total: appIds.length,
      })
    }
  }

  refreshApp(appId: number) {
    if (!this.appIds.includes(appId)) return Promise.resolve()
    const existing = this.inFlight.get(appId)
    const checkFresh = () => {
      if (!this.appIds.includes(appId)) return Promise.resolve()
      return this.checkApp(appId).then(() => undefined)
    }
    return existing ? existing.then(checkFresh, checkFresh) : checkFresh()
  }

  // The shared composable calls this through its module-level scanner instance.
  // fallow-ignore-next-line unused-class-member
  addApp(appId: number) {
    if (!this.appIds.includes(appId)) this.appIds.push(appId)
  }

  removeApp(appId: number) {
    this.appIds = this.appIds.filter((id) => id !== appId)
    this.dependencies.remove(appId)
  }

  private checkApp(appId: number, scanGeneration = this.generation) {
    const existing = this.inFlight.get(appId)
    const request = existing ?? this.startSingleCheck(appId)
    return request.then((result) => {
      this.commit(appId, result, scanGeneration)
      return result
    })
  }

  private checkApps(appIds: number[], scanGeneration: number) {
    const requests = new Map<number, Promise<AvailableUpdateResult>>()
    const pending = appIds.filter((appId) => {
      const existing = this.inFlight.get(appId)
      if (existing) requests.set(appId, existing)
      return !existing
    })

    if (pending.length) {
      for (const appId of pending) this.dependencies.clear(appId)
      const batch = this.serial.then(() =>
        this.dependencies.checkBatch(pending),
      )
      this.serial = batch.then(
        () => undefined,
        () => undefined,
      )
      for (const [index, appId] of pending.entries()) {
        const request = batch.then((results) => {
          const result = results[index]
          if (!result) throw new Error(`Missing update result for app ${appId}`)
          return result
        })
        this.track(appId, request)
        requests.set(appId, request)
      }
    }

    return appIds.map((appId) =>
      requests.get(appId)!.then((result) => {
        this.commit(appId, result, scanGeneration)
        return result
      }),
    )
  }

  private startSingleCheck(appId: number) {
    this.dependencies.clear(appId)
    const request = this.serial.then(() => this.dependencies.check(appId))
    this.serial = request.then(
      () => undefined,
      () => undefined,
    )
    this.track(appId, request)
    return request
  }

  private track(appId: number, request: Promise<AvailableUpdateResult>) {
    this.inFlight.set(appId, request)
    const clear = () => {
      if (this.inFlight.get(appId) === request) this.inFlight.delete(appId)
    }
    void request.then(clear, clear)
  }

  private commit(
    appId: number,
    result: AvailableUpdateResult,
    scanGeneration: number,
  ) {
    if (scanGeneration === this.generation && this.appIds.includes(appId))
      this.dependencies.commit(appId, result)
  }
}
