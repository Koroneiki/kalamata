import { describe, expect, mock, test } from 'bun:test'
import { StoreBrowseClient } from '../src/backend/steam/store-browse-client.ts'

describe('StoreBrowseClient', () => {
  test('requests all purchase options with an explicit US catalog by default', async () => {
    const fetcher = mock(async (_input: string | URL | Request) =>
      Response.json({
        response: {
          store_items: [
            {
              appid: 883710,
              success: 1,
              visible: true,
              purchase_options: [
                { packageid: 280800 },
                { packageid: 280800 },
                { bundleid: 9575 },
              ],
            },
          ],
        },
      }),
    )

    const result = await new StoreBrowseClient(fetcher).getPackageIds([883710])

    expect(result).toEqual(new Map([[883710, [280800]]]))
    const url = fetcher.mock.calls[0]![0] as URL
    expect(url.origin + url.pathname).toBe(
      'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/',
    )
    expect(JSON.parse(url.searchParams.get('input_json')!)).toEqual({
      ids: [{ appid: 883710 }],
      context: { country_code: 'US' },
      data_request: { include_all_purchase_options: true },
    })
  })

  test.each([
    { success: 0, visible: true },
    { success: 1, visible: false },
    { success: 1, visible: true, is_free: true },
    {
      success: 1,
      visible: true,
      unvailable_for_country_restriction: true,
    },
  ])('ignores an unusable Store item %#', async (state) => {
    const fetcher = mock(async (_input: string | URL | Request) =>
      Response.json({
        response: {
          store_items: [
            {
              appid: 440,
              purchase_options: [{ packageid: 1 }],
              ...state,
            },
          ],
        },
      }),
    )

    await expect(
      new StoreBrowseClient(fetcher).getPackageIds([440]),
    ).resolves.toEqual(new Map())
  })

  test('rejects HTTP and invalid response data', async () => {
    const httpFailure = new StoreBrowseClient(
      mock(
        async (_input: string | URL | Request) =>
          new Response(null, { status: 503 }),
      ),
    )
    const invalidData = new StoreBrowseClient(
      mock(async (_input: string | URL | Request) =>
        Response.json({ response: {} }),
      ),
    )

    await expect(httpFailure.getPackageIds([440])).rejects.toThrow('HTTP 503')
    await expect(invalidData.getPackageIds([440])).rejects.toThrow(
      'invalid product information',
    )
  })
})
