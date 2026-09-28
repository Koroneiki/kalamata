import { describe, expect, mock, test } from 'bun:test'
import { ProductInfoService } from '../src/backend/steam/product-info-service.ts'
import { AvailableUpdateService } from '../src/backend/apps/available-update-service.ts'

describe('ProductInfoService', () => {
  test.each([0, -1, 1.5, 0x100000000])(
    'rejects invalid app ID %s before connecting',
    async (appId) => {
      const getClient = mock(async () => {
        throw new Error('should not connect')
      })
      const service = new ProductInfoService({ getClient })

      await expect(service.getProductInfo(appId)).rejects.toThrow(
        'appId must be a positive 32-bit integer',
      )
      expect(getClient).not.toHaveBeenCalled()
    },
  )

  test('limits package discovery failure to one request and retries later', async () => {
    const getProductInfo = mock(
      async (appIds: number[], packageIds: number[]) =>
        appIds.length
          ? {
              apps: {
                440: {
                  changenumber: 1,
                  missingToken: false,
                  appinfo: { depots: { '441': {} } },
                },
              },
              packages: {},
              unknownApps: [],
              unknownPackages: [],
            }
          : {
              apps: {},
              packages: Object.fromEntries(
                packageIds.map((packageId) => [
                  packageId,
                  {
                    missingToken: false,
                    packageinfo: { appids: [440], depotids: [441] },
                  },
                ]),
              ),
              unknownApps: [],
              unknownPackages: [],
            },
    )
    let packageRequest = 0
    const getPackageIds = mock(async () => {
      if (packageRequest++ === 0)
        throw new Error('temporary StoreBrowse failure')
      return new Map([[440, [10]]])
    })
    const failures: Error[] = []
    const service = new ProductInfoService(
      { getClient: async () => ({ getProductInfo }) as never },
      { getPackageIds },
      (_appIds, _countryCode, error) => failures.push(error),
    )

    const degraded = await service.getProductInfoWithDlc(440)
    const recovered = await service.getProductInfoWithDlc(440)

    expect(degraded.eligibleBaseDepotIds).toBeNull()
    expect(recovered.eligibleBaseDepotIds).toEqual(new Set([441]))
    expect(getPackageIds).toHaveBeenCalledTimes(2)
    expect(failures).toHaveLength(1)
  })

  test('coalesces single and batch metadata, while refreshing changed manifest targets', async () => {
    let manifest = '10'
    const calls: number[][] = []
    const getProductInfo = mock(
      async (appIds: number[], packageIds: number[]) => {
        if (packageIds.length)
          return {
            apps: {},
            packages: {},
            unknownApps: [],
            unknownPackages: [],
          }
        calls.push(appIds)
        return {
          apps: Object.fromEntries(
            appIds.map((id) => [
              id,
              {
                changenumber: Number(manifest),
                missingToken: false,
                appinfo: {
                  depots: {
                    [id]: { manifests: { public: { gid: manifest } } },
                  },
                },
              },
            ]),
          ),
          packages: {},
          unknownApps: [],
          unknownPackages: [],
        }
      },
    )
    const service = new ProductInfoService(
      { getClient: async () => ({ getProductInfo }) as never },
      { getPackageIds: async () => new Map() },
    )
    const [single, batch, base] = await Promise.all([
      service.getProductInfoWithDlc(440),
      service.getProductInfoWithDlcBatch([440, 570]),
      service.getProductInfo(570),
    ])
    expect(single).toBe(batch.get(440)!)
    expect(base).toBe(batch.get(570)!.baseProduct)
    expect(calls).toHaveLength(1)
    expect(new Set(calls[0])).toEqual(new Set([440, 570]))
    await service.getProductInfoWithDlc(440)
    expect(calls).toHaveLength(1)
    manifest = '11'
    const updated = await service.getProductInfoWithDlc(440, true)
    expect(updated.baseProduct.changenumber).toBe(11)
    expect(await service.getProductInfoWithDlc(440)).toBe(updated)
    expect(calls[1]).toEqual([440])
  })

  test('isolates a missing package to affected apps and retries its eligibility', async () => {
    let missing = true
    const failures: number[][] = []
    const getProductInfo = mock(
      async (appIds: number[], packageIds: number[]) =>
        appIds.length
          ? {
              apps: Object.fromEntries(
                appIds.map((id) => [
                  id,
                  {
                    changenumber: 1,
                    missingToken: false,
                    appinfo: { depots: {} },
                  },
                ]),
              ),
              packages: {},
              unknownApps: [],
              unknownPackages: [],
            }
          : {
              apps: {},
              packages: Object.fromEntries(
                packageIds.flatMap((id) =>
                  id === 1 && missing
                    ? []
                    : [
                        [
                          id,
                          {
                            missingToken: false,
                            packageinfo: {
                              appids: [id === 1 ? 440 : 570],
                              depotids: [id],
                            },
                          },
                        ],
                      ],
                ),
              ),
              unknownApps: [],
              unknownPackages: missing ? [1] : [],
            },
    )
    const service = new ProductInfoService(
      { getClient: async () => ({ getProductInfo }) as never },
      {
        getPackageIds: async (ids) =>
          new Map(ids.map((id) => [id, [id === 440 ? 1 : 2]])),
      },
      (ids) => failures.push(ids),
    )
    const first = await service.getProductInfoWithDlcBatch([440, 570])
    expect(first.get(440)?.eligibleBaseDepotIds).toBeNull()
    expect(first.get(570)?.eligibleBaseDepotIds).toEqual(new Set([2]))
    expect(failures).toEqual([[440]])
    missing = false
    expect(
      (await service.getProductInfoWithDlc(440)).eligibleBaseDepotIds,
    ).toEqual(new Set([1]))
  })

  test('keeps valid base apps when another app or DLC has no PICS data', async () => {
    let dlcAvailable = false
    const getProductInfo = mock(
      async (appIds: number[], _packageIds: number[]) => ({
        apps: Object.fromEntries(
          appIds.flatMap((id) =>
            id === 440 || (id === 441 && dlcAvailable)
              ? [
                  [
                    id,
                    {
                      changenumber: 1,
                      missingToken: false,
                      appinfo:
                        id === 440
                          ? { extended: { listofdlc: '441' }, depots: {} }
                          : { depots: {} },
                    },
                  ],
                ]
              : [],
          ),
        ),
        packages: {},
        unknownApps: appIds.filter(
          (id) => id !== 440 && !(id === 441 && dlcAvailable),
        ),
        unknownPackages: [],
      }),
    )
    const service = new ProductInfoService(
      { getClient: async () => ({ getProductInfo }) as never },
      { getPackageIds: async () => new Map() },
    )
    const first = await service.getProductInfoWithDlcBatch([440, 570])
    expect([...first.keys()]).toEqual([440])
    expect(first.get(440)?.listedDlcAppIds).toEqual([441])
    expect(first.get(440)?.dlcProducts).toEqual([])
    dlcAvailable = true
    expect(
      (await service.getProductInfoWithDlc(440)).dlcProducts.map(
        ({ appId }) => appId,
      ),
    ).toEqual([441])
  })

  test('a new update scan sees a changed public manifest despite cached details', async () => {
    let target = '10'
    const getProductInfo = mock(async (appIds: number[]) => ({
      apps: Object.fromEntries(
        appIds.map((appId) => [
          appId,
          {
            changenumber: Number(target),
            missingToken: false,
            appinfo: {
              depots: { '441': { manifests: { public: { gid: target } } } },
            },
          },
        ]),
      ),
      packages: {},
      unknownApps: [],
      unknownPackages: [],
    }))
    const products = new ProductInfoService(
      { getClient: async () => ({ getProductInfo }) as never },
      { getPackageIds: async () => new Map() },
    )
    const updates = new AvailableUpdateService(products, {
      getInstalls: () => [
        {
          depotId: 441,
          installedManifestId: '9',
          pinned: false,
          mountIndex: 0,
          ownerAppId: 440,
        },
      ],
    })
    await products.getProductInfoWithDlc(440)
    target = '11'
    const [result] = await updates.checkBatch([440])
    expect(result?.status).toBe('available')
    if (result?.status === 'available')
      expect(result.candidate.outdatedDepots[0]?.targetManifestId).toBe('11')
  })

  test('discarding an app ignores an older in-flight response', async () => {
    let finishOld!: (value: object) => void
    let requests = 0
    const response = (change: number) => ({
      apps: {
        440: {
          changenumber: change,
          missingToken: false,
          appinfo: { depots: {} },
        },
      },
      packages: {},
      unknownApps: [],
      unknownPackages: [],
    })
    const service = new ProductInfoService({
      getClient: async () =>
        ({
          getProductInfo: () => {
            if (++requests === 1)
              return new Promise((resolve) => {
                finishOld = resolve
              })
            return Promise.resolve(response(2))
          },
        }) as never,
    })
    const older = service.getProductInfo(440)
    await Promise.resolve()
    await Promise.resolve()
    service.clear(440)
    const current = await service.getProductInfo(440)
    finishOld(response(1))
    await older
    expect(current.changenumber).toBe(2)
    expect((await service.getProductInfo(440)).changenumber).toBe(2)
    expect(requests).toBe(2)
  })

  test('discarding one app preserves other pending requests and their cache', async () => {
    let finish!: (value: object) => void
    const getProductInfo = mock(
      (appIds: number[]) =>
        new Promise<object>((resolve) => {
          finish = resolve
        }),
    )
    const service = new ProductInfoService({
      getClient: async () => ({ getProductInfo }) as never,
    })
    const other = service.getProductInfo(570)
    await Promise.resolve()
    await Promise.resolve()
    service.clear(440)
    finish({
      apps: {
        570: {
          changenumber: 1,
          missingToken: false,
          appinfo: { depots: {} },
        },
      },
      packages: {},
      unknownApps: [],
      unknownPackages: [],
    })
    expect((await other).changenumber).toBe(1)
    expect((await service.getProductInfo(570)).changenumber).toBe(1)
    expect(getProductInfo).toHaveBeenCalledTimes(1)
  })

  test('an old completion cannot remove a replacement request for the same app', async () => {
    const finish: Array<(value: object) => void> = []
    const getProductInfo = mock(
      () =>
        new Promise<object>((resolve) => {
          finish.push(resolve)
        }),
    )
    const service = new ProductInfoService({
      getClient: async () => ({ getProductInfo }) as never,
    })
    const old = service.getProductInfo(440)
    await Promise.resolve()
    await Promise.resolve()
    service.clear(440)
    const current = service.getProductInfo(440)
    await Promise.resolve()
    await Promise.resolve()
    finish[0]!({
      apps: { 440: { changenumber: 1, missingToken: false, appinfo: {} } },
      packages: {},
      unknownApps: [],
      unknownPackages: [],
    })
    await old
    const shared = service.getProductInfo(440)
    finish[1]!({
      apps: { 440: { changenumber: 2, missingToken: false, appinfo: {} } },
      packages: {},
      unknownApps: [],
      unknownPackages: [],
    })
    expect((await current).changenumber).toBe(2)
    expect((await shared).changenumber).toBe(2)
    expect(getProductInfo).toHaveBeenCalledTimes(2)
  })
})
