import { expect, mock, test } from 'bun:test'
import { LibraryResourcePreparation } from '../src/composables/library-resource-preparation.ts'
import type {
  AppDetails,
  AppSettings,
  EligibleAppDepot,
} from '../src/types/rpc.ts'

const settings: AppSettings = {
  automaticManifestAcquisition: true,
  hubcapApiKey: '',
  hideRedistributables: false,
  hideUnknownDepots: false,
  hideUnusedDepots: false,
  hideUnavailableDepots: false,
  platforms: ['windows'],
}

function depot(
  id: number,
  platform: string,
  manifestId = '100',
): EligibleAppDepot {
  return {
    depotId: id,
    mountIndex: 0,
    ownerAppId: 440,
    ownerAppName: null,
    group: 'Base Game',
    platform,
    language: null,
    manifestId,
    sizeBytes: null,
    downloadBytes: null,
    eligible: true,
    manifestStatus: 'missing',
    keyStatus: 'missing',
    installStatus: 'not-installed',
    selectable: true,
  }
}

const app: AppDetails = {
  appId: 440,
  name: 'Game',
  developers: [],
  publishers: [],
  releaseDate: null,
  iconUrls: [],
  artworkUrl: null,
  inLibrary: true,
  installPath: null,
  installedDepotIds: [],
  depots: [depot(441, 'windows'), depot(442, 'linux')],
}

test('prepares eligible missing resources only when enabled and avoids duplicate jobs', async () => {
  const keys = mock(async () => ({ fetched: true }))
  const manifests = mock(async () => ({ fetched: true }))
  const prepare = new LibraryResourcePreparation(
    {
      acquireKeysAutomatically: keys,
      acquireManifestAutomatically: manifests,
    },
    () => {},
  )

  expect(
    await prepare.prepare(app, {
      ...settings,
      automaticManifestAcquisition: false,
    }),
  ).toBe(false)
  expect(keys).not.toHaveBeenCalled()
  const [first, duplicate] = await Promise.all([
    prepare.prepare(app, settings),
    prepare.prepare(app, settings),
  ])
  expect(first).toBe(true)
  expect(duplicate).toBe(false)
  expect(keys).toHaveBeenCalledTimes(1)
  expect(keys).toHaveBeenCalledWith(440, [441])
  expect(manifests).toHaveBeenCalledTimes(1)
  expect(manifests).toHaveBeenCalledWith(440, 441, '100', 440)

  const changed = { ...app, depots: [depot(441, 'windows', '101')] }
  expect(await prepare.prepare(changed, settings)).toBe(true)
  expect(keys).toHaveBeenCalledTimes(1)
  expect(manifests).toHaveBeenCalledWith(440, 441, '101', 440)
  prepare.forget(440)
  expect(await prepare.prepare(changed, settings)).toBe(true)
  expect(keys).toHaveBeenCalledTimes(2)
})

test('waits for the manifest before attempting to acquire its key', async () => {
  let finishManifest!: () => void
  const manifestReady = new Promise<void>((resolve) => {
    finishManifest = resolve
  })
  const keys = mock(async () => ({ fetched: true }))
  const prepare = new LibraryResourcePreparation(
    {
      acquireKeysAutomatically: keys,
      acquireManifestAutomatically: async () => {
        await manifestReady
        return { fetched: true }
      },
    },
    () => {},
  )

  const result = prepare.prepare(app, settings)
  expect(keys).not.toHaveBeenCalled()
  finishManifest()
  expect(await result).toBe(true)
  expect(keys).toHaveBeenCalledWith(440, [441])
})
