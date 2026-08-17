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
    const service = new ProductInfoService({ getClient: async () => client })

    const result = await service.getProductInfoWithDlc(10)

    expect(result.baseProduct).toMatchObject({ appId: 10, appinfo: base })
    expect(result.dlcProducts.map(({ appId }) => appId)).toEqual([20, 30])
    expect(getProductInfo.mock.calls).toEqual([
      [[10], [], true],
      [[20, 30], [], true],
    ])
  })

  test('omits only the base app that owns an unavailable direct DLC', async () => {
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
    const service = new ProductInfoService({ getClient: async () => client })

    const result = await service.getProductInfoWithDlcBatch([10, 11])

    expect(result.has(10)).toBe(false)
    expect(result.get(11)?.dlcProducts.map(({ appId }) => appId)).toEqual([30])
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

function createService(result: SteamUser.ProductInfo): {
  service: ProductInfoService
  getProductInfo: ReturnType<typeof mock<SteamContentUser['getProductInfo']>>
} {
  const getProductInfo = mock(async () => result)
  const client = { getProductInfo } as unknown as SteamContentUser
  return {
    service: new ProductInfoService({ getClient: async () => client }),
    getProductInfo,
  }
}
