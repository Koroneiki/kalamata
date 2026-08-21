import { describe, expect, mock, test } from 'bun:test'
import { ProductInfoService } from '../src/backend/steam/product-info-service.ts'

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
})
