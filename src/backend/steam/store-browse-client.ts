import { z } from 'zod'
import { steamIdSchema } from '../../types/schemas.ts'

const STORE_BROWSE_URL =
  'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/'

export class StoreBrowseClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async getPackageIds(
    appIds: number[],
    countryCode = 'US',
  ): Promise<Map<number, number[]>> {
    const url = new URL(STORE_BROWSE_URL)
    url.searchParams.set(
      'input_json',
      JSON.stringify({
        ids: appIds.map((appid) => ({ appid })),
        context: { country_code: countryCode },
        data_request: { include_all_purchase_options: true },
      }),
    )
    const response = await this.fetcher(url)
    if (!response.ok) {
      const status = Number.isFinite(response.status)
        ? `HTTP ${response.status}`
        : 'a failure without an HTTP status'
      throw new Error(`Steam StoreBrowse returned ${status}`)
    }

    const parsed = responseSchema.safeParse(await response.json())
    if (!parsed.success)
      throw new Error('Steam StoreBrowse returned invalid product information')

    const requested = new Set(appIds)
    const result = new Map<number, number[]>()
    for (const rawItem of parsed.data.response.store_items) {
      const item = usableStoreItemSchema.safeParse(rawItem)
      if (!item.success || !requested.has(item.data.appid)) continue
      const packageIds = [
        ...new Set(
          item.data.purchase_options.flatMap(({ packageid }) =>
            packageid === undefined ? [] : [packageid],
          ),
        ),
      ]
      if (packageIds.length) result.set(item.data.appid, packageIds)
    }
    return result
  }
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

const purchaseOptionSchema = z.looseObject({
  packageid: steamIdSchema.optional(),
  bundleid: steamIdSchema.optional(),
})
const usableStoreItemSchema = z.looseObject({
  appid: steamIdSchema,
  success: z.literal(1),
  visible: z.literal(true),
  is_free: z.literal(false).optional(),
  unvailable_for_country_restriction: z.literal(false).optional(),
  purchase_options: z.array(purchaseOptionSchema).optional().default([]),
})
const responseSchema = z.object({
  response: z.object({
    store_items: z.array(z.unknown()),
  }),
})
