import { z } from 'zod'

import type { HubcapUsage, HubcapUsageResult } from '../../../types/rpc.ts'
import { steamIdStringSchema } from '../../../types/schemas.ts'

const HUBCAP_ORIGIN = 'https://hubcapmanifest.com'
const statsResponseSchema = z.object({
  daily_usage: z.number().int().nonnegative(),
  daily_limit: z.number().int().nonnegative(),
  can_make_requests: z.boolean(),
})
const depotIdsResponseSchema = z.object({
  status: z.literal('success'),
  depot_ids: z.array(steamIdStringSchema),
})

type HubcapDepotIdsResult =
  | { status: 'available'; depotIds: Set<number> }
  | { status: 'invalid-key' }
  | { status: 'unavailable' }

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class HubcapClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async getDepotIds(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<HubcapDepotIdsResult> {
    let response: Response
    try {
      response = await this.fetcher(`${HUBCAP_ORIGIN}/api/v1/depot-keys`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      return { status: 'unavailable' }
    }

    if (response.status === 401 || response.status === 403)
      return { status: 'invalid-key' }
    if (!response.ok) return { status: 'unavailable' }

    try {
      const value = depotIdsResponseSchema.parse(await response.json())
      return { status: 'available', depotIds: new Set(value.depot_ids) }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async getUsage(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<HubcapUsageResult> {
    let response: Response
    try {
      response = await this.fetcher(`${HUBCAP_ORIGIN}/api/v1/user/stats`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      return { status: 'stats-unavailable' }
    }

    if (response.status === 401 || response.status === 403)
      return { status: 'invalid-key' }
    if (!response.ok) return { status: 'stats-unavailable' }

    try {
      const value = statsResponseSchema.parse(await response.json())
      const usage: HubcapUsage = {
        dailyUsage: value.daily_usage,
        dailyLimit: value.daily_limit,
        remaining: Math.max(0, value.daily_limit - value.daily_usage),
        canMakeRequests: value.can_make_requests,
      }
      return { status: 'available', usage }
    } catch {
      return { status: 'stats-unavailable' }
    }
  }

  async getLua(
    appId: number,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let response: Response
    try {
      response = await this.fetcher(`${HUBCAP_ORIGIN}/api/v1/lua/${appId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Error('Hubcap Lua request failed')
    }
    if (!response.ok) throw new Error('Hubcap Lua request failed')
    try {
      return await response.text()
    } catch {
      throw new Error('Hubcap Lua response could not be read')
    }
  }
}
