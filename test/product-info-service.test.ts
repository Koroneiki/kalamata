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
})

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
