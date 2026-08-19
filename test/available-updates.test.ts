import { expect, test } from 'bun:test'
import { AvailableUpdateService } from '../src/backend/apps/available-update-service.ts'

test('sanitizes product metadata failures', async () => {
  const service = new AvailableUpdateService(
    {
      getProductInfoWithDlc: () =>
        Promise.reject(new Error('Steam token secret')),
      getProductInfoWithDlcBatch: () =>
        Promise.reject(new Error('Steam token secret')),
    },
    {
      getInstalls: () => [
        {
          depotId: 101,
          installedManifestId: '1',
          pinned: false,
          mountIndex: 101,
          ownerAppId: 10,
        },
      ],
    },
    () => 123,
  )

  expect(await service.check(10)).toEqual({
    status: 'error',
    appId: 10,
    message: 'Could not check this app for updates.',
    checkedAt: 123,
  })
})
