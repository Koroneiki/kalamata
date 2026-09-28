import type { AppDetails, AppSettings } from '../types/rpc.ts'
import { matchesDepotPlatform } from '../utils/depots.ts'

interface Acquisition {
  acquireKeysAutomatically: (
    appId: number,
    depotIds: number[],
  ) => Promise<{ fetched: boolean }>
  acquireManifestAutomatically: (
    ownerAppId: number,
    depotId: number,
    manifestId: string,
    parentAppId: number,
  ) => Promise<{ fetched: boolean }>
}

// Tracks resource attempts across batch preparation and detail navigation.
// The acquisition adapter itself owns quota approval, feedback and resource deduplication.
export class LibraryResourcePreparation {
  private readonly attemptedKeys = new Set<string>()
  private readonly attemptedManifests = new Set<string>()

  constructor(
    private readonly acquisition: Acquisition,
    private readonly onError: (error: Error) => void,
  ) {}

  forget(appId: number): void {
    const prefix = `${appId}:`
    for (const key of this.attemptedKeys)
      if (key.startsWith(prefix)) this.attemptedKeys.delete(key)
    for (const key of this.attemptedManifests)
      if (key.startsWith(prefix)) this.attemptedManifests.delete(key)
  }

  async prepare(
    app: AppDetails,
    settings: AppSettings | undefined,
  ): Promise<boolean> {
    if (!settings?.automaticManifestAcquisition) return false
    const eligible = app.depots.filter(
      (depot) =>
        depot.eligible && matchesDepotPlatform(depot, settings.platforms),
    )
    const keys = eligible.filter(
      (depot) =>
        depot.keyStatus !== 'present' &&
        !this.attemptedKeys.has(`${app.appId}:${depot.depotId}`),
    )
    const manifests = eligible.filter(
      (depot) =>
        depot.manifestId &&
        depot.manifestStatus !== 'ready' &&
        !this.attemptedManifests.has(
          `${app.appId}:${depot.depotId}:${depot.manifestId}`,
        ),
    )
    for (const depot of keys)
      this.attemptedKeys.add(`${app.appId}:${depot.depotId}`)
    for (const depot of manifests)
      this.attemptedManifests.add(
        `${app.appId}:${depot.depotId}:${depot.manifestId}`,
      )

    // Key acquisition checks the saved manifest, so finish manifest jobs first.
    const manifestResults = await Promise.all(
      manifests.map((depot) =>
        this.run(() =>
          this.acquisition.acquireManifestAutomatically(
            depot.ownerAppId,
            depot.depotId,
            depot.manifestId!,
            app.appId,
          ),
        ),
      ),
    )
    const keyFetched = keys.length
      ? await this.run(() =>
          this.acquisition.acquireKeysAutomatically(
            app.appId,
            keys.map(({ depotId }) => depotId),
          ),
        )
      : false
    return manifestResults.some(Boolean) || keyFetched
  }

  private async run(
    request: () => Promise<{ fetched: boolean }>,
  ): Promise<boolean> {
    try {
      return (await request()).fetched
    } catch (cause) {
      this.onError(cause instanceof Error ? cause : new Error(String(cause)))
      return false
    }
  }
}
