import { expect, test } from 'bun:test'
import { StoreBrowseClient } from '../src/backend/steam/store-browse-client.ts'

test.skipIf(process.env.STEAM_STOREFRONT_INTEGRATION !== '1')(
  'returns the known US and Japanese package families',
  async () => {
    const store = new StoreBrowseClient()
    const [us, japan] = await Promise.all([
      store.getPackageIds([2677660, 883710, 2050650, 2109300], 'US'),
      store.getPackageIds([883710, 2050650, 2109300], 'JP'),
    ])

    expect(us.get(2677660)).toEqual([959247, 1115063, 1185436])
    expect(us.get(883710)).toEqual([280800, 281610, 597332, 1142889])
    expect(japan.get(883710)).toEqual([281609, 281611, 597333])
    expect(us.get(2050650)).toEqual([794618, 994065, 1142889])
    expect(us.get(2109300)).toEqual([931349, 1142889])
    expect(japan.get(2050650)).toEqual([794605, 994064, 1142890])
    expect(japan.get(2109300)).toEqual([754270, 1142890])
  },
)
