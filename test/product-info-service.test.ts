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
})
