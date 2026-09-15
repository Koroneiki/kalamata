import { z } from 'zod'

import type { HubcapUsage, HubcapUsageResult } from '../../../types/rpc.ts'
import {
  manifestIdSchema,
  steamIdStringSchema,
} from '../../../types/schemas.ts'

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
const manifestContentsResponseSchema = z.object({
  app_id: steamIdStringSchema,
  zip_exists: z.boolean(),
  manifests: z.array(
    z.object({
      depot_id: steamIdStringSchema,
      manifest_id: manifestIdSchema,
      filename: z.string(),
    }),
  ),
})

const MAX_HUBCAP_MANIFEST_ZIP_BYTES = 256 * 1024 * 1024

type HubcapDepotIdsResult =
  | { status: 'available'; depotIds: Set<number> }
  | { status: 'invalid-key' }
  | { status: 'unavailable' }

export type HubcapManifestContentsResult =
  | {
      status: 'available'
      zipExists: boolean
      manifests: Array<{
        depotId: number
        manifestId: string
        filename: string
      }>
    }
  | { status: 'invalid-key' }
  | { status: 'unavailable' }

type HubcapResponseResult =
  | { status: 'available'; response: Response }
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
    const result = await this.get('/api/v1/depot-keys', apiKey, signal)
    if (result.status !== 'available') return result

    try {
      const value = depotIdsResponseSchema.parse(await result.response.json())
      return { status: 'available', depotIds: new Set(value.depot_ids) }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async getUsage(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<HubcapUsageResult> {
    const result = await this.get('/api/v1/user/stats', apiKey, signal)
    if (result.status === 'invalid-key') return result
    if (result.status === 'unavailable') return { status: 'stats-unavailable' }

    try {
      const value = statsResponseSchema.parse(await result.response.json())
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

  async getManifestContents(
    appId: number,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<HubcapManifestContentsResult> {
    const result = await this.get(
      `/api/v1/manifest/${appId}/contents`,
      apiKey,
      signal,
    )
    if (result.status !== 'available') return result

    try {
      const value = manifestContentsResponseSchema.parse(
        await result.response.json(),
      )
      if (Number(value.app_id) !== appId) return { status: 'unavailable' }
      return {
        status: 'available',
        zipExists: value.zip_exists,
        manifests: value.manifests.map((manifest) => ({
          depotId: Number(manifest.depot_id),
          manifestId: manifest.manifest_id,
          filename: manifest.filename,
        })),
      }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async getManifestZip(
    appId: number,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    let response: Response
    try {
      response = await this.fetcher(
        `${HUBCAP_ORIGIN}/api/v1/manifest/${appId}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        },
      )
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Error('Hubcap manifest request failed')
    }
    if (!response.ok) throw new Error('Hubcap manifest request failed')
    return readBoundedBody(response, MAX_HUBCAP_MANIFEST_ZIP_BYTES, signal)
  }

  async getUsageAfterRequest(
    apiKey: string,
    preflightUsage: HubcapUsage,
    signal?: AbortSignal,
  ): Promise<HubcapUsage> {
    const refreshed = await this.getUsage(apiKey, signal)
    return refreshed.status === 'available'
      ? refreshed.usage
      : {
          ...preflightUsage,
          dailyUsage: preflightUsage.dailyUsage + 1,
          remaining: Math.max(0, preflightUsage.remaining - 1),
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

  private async get(
    path: string,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<HubcapResponseResult> {
    let response: Response
    try {
      response = await this.fetcher(`${HUBCAP_ORIGIN}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      return { status: 'unavailable' }
    }
    if (response.status === 401 || response.status === 403)
      return { status: 'invalid-key' }
    return response.ok
      ? { status: 'available', response }
      : { status: 'unavailable' }
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const declaredLength = response.headers.get('Content-Length')
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw new Error('Hubcap manifest ZIP is too large')
  }

  if (!response.body) throw new Error('Hubcap manifest response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const part = await reader.read().catch(() => {
        signal?.throwIfAborted()
        throw new Error('Hubcap manifest response could not be read')
      })
      const { done, value } = part
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        void reader.cancel()
        throw new Error('Hubcap manifest ZIP is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}
