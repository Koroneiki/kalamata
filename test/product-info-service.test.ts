import { describe, expect, mock, test } from 'bun:test'
import type SteamUser from 'steam-user'
import { ProductInfoService } from '../src/backend/steam/product-info-service.ts'
import type { SteamContentUser } from '../src/backend/steam/types.ts'

describe('ProductInfoService', () => {
  test('returns the full product information for an app', async () => {
    const appinfo = {
      appid: '440',
      common: { name: 'Team Fortress 2', type: 'game', gameid: '440' },
      depots: { branches: { public: { buildid: '123' } } },
    } as unknown as SteamUser.AppInfoContent
    const { service, getProductInfo } = createService({
      apps: {
        440: { changenumber: 42, missingToken: false, appinfo },
      },
      packages: {},
      unknownApps: [],
      unknownPackages: [],
    })

    await expect(service.getProductInfo(440)).resolves.toEqual({
      appId: 440,
      changenumber: 42,
      missingToken: false,
      appinfo,
    })
    expect(getProductInfo).toHaveBeenCalledWith([440], [], true)
  })

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

  test('rejects apps Steam reports as unknown', async () => {
    const { service } = createService({
      apps: {},
      packages: {},
      unknownApps: [999999],
      unknownPackages: [],
    })

    await expect(service.getProductInfo(999999)).rejects.toThrow(
      'Steam app 999999 does not exist',
    )
  })

  test('rejects a response that omits the requested app', async () => {
    const { service } = createService({
      apps: {},
      packages: {},
      unknownApps: [],
      unknownPackages: [],
    })

    await expect(service.getProductInfo(440)).rejects.toThrow(
      'Steam returned no product information for app 440',
    )
  })

  test('rejects product information returned without an access token', async () => {
    const { service } = createService({
      apps: {
        440: {
          changenumber: 42,
          missingToken: true,
          appinfo: appInfo(),
        },
      },
      packages: {},
      unknownApps: [],
      unknownPackages: [],
    })

    await expect(service.getProductInfo(440)).rejects.toThrow(
      'Steam returned incomplete product information for app 440',
    )
  })

  test('propagates Steam request errors', async () => {
    const error = new Error('PICS unavailable')
    const getProductInfo = mock(async () => {
      throw error
    })
    const client = { getProductInfo } as unknown as SteamContentUser
    const service = new ProductInfoService({
      getClient: async () => client,
    })

    await expect(service.getProductInfo(440)).rejects.toBe(error)
  })

  test('fetches only valid unique directly listed DLCs without recursion', async () => {
    const base = appInfo({
      extended: {
        listofdlc: '20, nope, 30, 20, 0, 4294967296, 40.5',
      },
    })
    const dlc20 = appInfo({ extended: { listofdlc: '40' } })
    const dlc30 = appInfo()
    const getProductInfo = mock(
      async (
        appIds: number[],
        _packageIds: number[],
        _metaDataOnly: boolean,
      ) =>
        appIds[0] === 10
          ? productResult({ 10: product(base) })
          : productResult({ 20: product(dlc20), 30: product(dlc30) }),
    )
    const client = { getProductInfo } as unknown as SteamContentUser
    const service = new ProductInfoService(
      { getClient: async () => client },
      emptyStore,
    )

    const result = await service.getProductInfoWithDlc(10)

    expect(result.baseProduct).toMatchObject({ appId: 10, appinfo: base })
    expect(result.listedDlcAppIds).toEqual([20, 30])
    expect(result.dlcProducts.map(({ appId }) => appId)).toEqual([20, 30])
    expect(getProductInfo.mock.calls).toEqual([
      [[10], [], true],
      [[20, 30], [], true],
    ])
  })

  test('keeps base apps when a direct DLC is unavailable', async () => {
    const base10 = appInfo({ extended: { listofdlc: '20' } })
    const base11 = appInfo({ extended: { listofdlc: '30' } })
    const dlc30 = appInfo()
    const getProductInfo = mock(async (appIds: number[]) =>
      appIds.includes(10)
        ? productResult({ 10: product(base10), 11: product(base11) })
        : {
            ...productResult({ 30: product(dlc30) }),
            unknownApps: [20],
          },
    )
    const client = { getProductInfo } as unknown as SteamContentUser
    const service = new ProductInfoService(
      { getClient: async () => client },
      emptyStore,
    )

    const result = await service.getProductInfoWithDlcBatch([10, 11])

    expect(result.get(10)?.dlcProducts).toEqual([])
    expect(result.get(11)?.dlcProducts.map(({ appId }) => appId)).toEqual([30])
  })

  test('keeps a base app when a direct DLC has incomplete product information', async () => {
    const base = appInfo({ extended: { listofdlc: '920569' } })
    const getProductInfo = mock(async (appIds: number[]) =>
      appIds.includes(10)
        ? productResult({ 10: product(base) })
        : productResult({
            920569: {
              changenumber: 1,
              missingToken: true,
              appinfo: appInfo(),
            },
          }),
    )
    const client = { getProductInfo } as unknown as SteamContentUser
    const service = new ProductInfoService(
      { getClient: async () => client },
      emptyStore,
    )

    await expect(service.getProductInfoWithDlc(10)).resolves.toMatchObject({
      baseProduct: { appId: 10 },
      listedDlcAppIds: [920569],
      dlcProducts: [],
    })
  })

  test('unions depots from packages that contain the base app', async () => {
    const getProductInfo = mock(async (appIds: number[]) =>
      appIds.length
        ? productResult({ 10: product(appInfo()) })
        : packageResult({
            100: packageInfo([10], [11, 12]),
            101: packageInfo([20], [13]),
            102: packageInfo([10], [12, 14]),
          }),
    )
    const client = { getProductInfo } as unknown as SteamContentUser
    const store = {
      getPackageIds: async () => new Map([[10, [100, 101, 102]]]),
    }
    const service = new ProductInfoService(
      { getClient: async () => client },
      store,
    )

    const result = await service.getProductInfoWithDlc(10)

    expect(result.eligibleBaseDepotIds).toEqual(new Set([11, 12, 14]))
    expect(getProductInfo).toHaveBeenCalledWith([], [100, 101, 102], true)
  })

  test('falls back and reports package discovery failures', async () => {
    const error = new Error('Store unavailable')
    const report = mock(() => {})
    const client = {
      getProductInfo: mock(async () =>
        productResult({ 10: product(appInfo()) }),
      ),
    } as unknown as SteamContentUser
    const service = new ProductInfoService(
      { getClient: async () => client },
      { getPackageIds: async () => Promise.reject(error) },
      report,
    )

    const result = await service.getProductInfoWithDlc(10)

    expect(result.eligibleBaseDepotIds).toBeNull()
    expect(report).toHaveBeenCalledWith([10], 'US', error)
  })

  test('falls back when package PICS fails', async () => {
    const error = new Error('Package PICS unavailable')
    const report = mock(() => {})
    const client = {
      getProductInfo: mock(async (appIds: number[]) => {
        if (!appIds.length) throw error
        return productResult({ 10: product(appInfo()) })
      }),
    } as unknown as SteamContentUser
    const service = new ProductInfoService(
      { getClient: async () => client },
      { getPackageIds: async () => new Map([[10, [100]]]) },
      report,
    )

    expect(
      (await service.getProductInfoWithDlc(10)).eligibleBaseDepotIds,
    ).toBeNull()
    expect(report).toHaveBeenCalledWith([10], 'US', error)
  })

  test('falls back when one of several package results is incomplete', async () => {
    const report = mock(() => {})
    const getProductInfo = mock(
      async (appIds: number[], packageIds: number[]) =>
        appIds.length
          ? productResult({ 10: product(appInfo()) })
          : packageResult({
              [packageIds[0]!]: packageInfo([10], [11]),
              [packageIds[1]!]: {
                changenumber: 1,
                missingToken: true,
                packageinfo: null,
              },
            }),
    )
    const client = { getProductInfo } as unknown as SteamContentUser
    const service = new ProductInfoService(
      { getClient: async () => client },
      { getPackageIds: async () => new Map([[10, [100, 101]]]) },
      report,
    )

    const result = await service.getProductInfoWithDlc(10)

    expect(result.eligibleBaseDepotIds).toBeNull()
    expect(report).toHaveBeenCalledWith(
      [10],
      'US',
      expect.objectContaining({
        message: expect.stringContaining('incomplete package information'),
      }),
    )
  })

  test('starts product and package branches together and waits for both', async () => {
    const storeResult = deferred<Map<number, number[]>>()
    const appResult = deferred<SteamUser.ProductInfo>()
    const packageResultPromise = deferred<SteamUser.ProductInfo>()
    const starts: string[] = []
    const getProductInfo = mock(async (appIds: number[]) => {
      starts.push(appIds.length ? 'app' : 'package')
      return appIds.length ? appResult.promise : packageResultPromise.promise
    })
    const client = { getProductInfo } as unknown as SteamContentUser
    const store = {
      getPackageIds: () => {
        starts.push('store')
        return storeResult.promise
      },
    }
    const service = new ProductInfoService(
      { getClient: async () => client },
      store,
    )

    let settled = false
    const result = service.getProductInfoWithDlc(10).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(starts).toEqual(['store', 'app'])

    storeResult.resolve(new Map([[10, [100]]]))
    appResult.resolve(productResult({ 10: product(appInfo()) }))
    await Promise.resolve()
    await Promise.resolve()
    expect(starts).toEqual(['store', 'app', 'package'])
    expect(settled).toBe(false)

    packageResultPromise.resolve(
      packageResult({ 100: packageInfo([10], [11]) }),
    )
    expect((await result).eligibleBaseDepotIds).toEqual(new Set([11]))
  })

  test.each([
    {
      catalog: 'US',
      dlcPackageId: 931349,
      dlcDepotIds: [] as number[],
      expected: [2109300],
    },
    {
      catalog: 'JP',
      dlcPackageId: 754270,
      dlcDepotIds: [2050655] as number[],
      expected: [2109300, 2050655],
    },
  ])(
    'derives Separate Ways DLC depots for the $catalog package family',
    async ({ dlcPackageId, dlcDepotIds, expected }) => {
      const base = appInfo({
        extended: { listofdlc: '2109300' },
        depots: {
          2109300: { dlcappid: '2109300' },
          2050655: { dlcappid: '2109300' },
        },
      })
      const getProductInfo = mock(
        async (appIds: number[], packageIds: number[]) => {
          if (appIds.includes(2050650))
            return productResult({ 2050650: product(base) })
          if (appIds.includes(2109300))
            return productResult({ 2109300: product(appInfo()) })
          if (packageIds.includes(dlcPackageId))
            return packageResult({
              [dlcPackageId]: packageInfo([2109300], dlcDepotIds),
            })
          return packageResult({
            994065: packageInfo([2050650, 2109300], [2050651, 2050653]),
          })
        },
      )
      const client = { getProductInfo } as unknown as SteamContentUser
      const store = {
        getPackageIds: async (appIds: number[]) =>
          appIds.includes(2050650)
            ? new Map([[2050650, [994065]]])
            : new Map([[2109300, [dlcPackageId]]]),
      }
      const service = new ProductInfoService(
        { getClient: async () => client },
        store,
      )

      const result = await service.getProductInfoWithDlc(2050650)

      expect(result.eligibleDlcDepotIds.get(2109300)).toEqual(new Set(expected))
    },
  )

  test('includes depots declared by the fetched DLC product', async () => {
    const base = appInfo({
      extended: { listofdlc: '20' },
      depots: { 20: { dlcappid: '20' } },
    })
    const dlc = appInfo({ depots: { 300: {} } })
    const getProductInfo = mock(
      async (appIds: number[], packageIds: number[]) => {
        if (appIds.includes(10)) return productResult({ 10: product(base) })
        if (appIds.includes(20)) return productResult({ 20: product(dlc) })
        return packageResult({
          [packageIds[0]!]: packageInfo(
            packageIds[0] === 100 ? [10, 20] : [20],
            packageIds[0] === 100 ? [] : [300],
          ),
        })
      },
    )
    const client = { getProductInfo } as unknown as SteamContentUser
    const service = new ProductInfoService(
      { getClient: async () => client },
      {
        getPackageIds: async (appIds: number[]) =>
          appIds.includes(10) ? new Map([[10, [100]]]) : new Map([[20, [200]]]),
      },
    )

    const result = await service.getProductInfoWithDlc(10)

    expect(result.eligibleDlcDepotIds.get(20)).toEqual(new Set([20, 300]))
  })
})

function appInfo(
  value: Record<string, unknown> = {},
): SteamUser.AppInfoContent {
  return value as unknown as SteamUser.AppInfoContent
}

function product(appinfo: SteamUser.AppInfoContent) {
  return { changenumber: 1, missingToken: false, appinfo }
}

function productResult(
  apps: SteamUser.ProductInfo['apps'],
): SteamUser.ProductInfo {
  return {
    apps,
    packages: {},
    unknownApps: [],
    unknownPackages: [],
  }
}

function packageResult(
  packages: SteamUser.ProductInfo['packages'],
): SteamUser.ProductInfo {
  return {
    apps: {},
    packages,
    unknownApps: [],
    unknownPackages: [],
  }
}

function packageInfo(appids: number[], depotids: number[]) {
  return {
    changenumber: 1,
    missingToken: false,
    packageinfo: { appids, depotids },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createService(result: SteamUser.ProductInfo): {
  service: ProductInfoService
  getProductInfo: ReturnType<typeof mock<SteamContentUser['getProductInfo']>>
} {
  const getProductInfo = mock(async () => result)
  const client = { getProductInfo } as unknown as SteamContentUser
  return {
    service: new ProductInfoService(
      { getClient: async () => client },
      emptyStore,
    ),
    getProductInfo,
  }
}

const emptyStore = { getPackageIds: async () => new Map<number, number[]>() }
