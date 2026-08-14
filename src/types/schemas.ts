import { z } from 'zod'
import type { AppSettings } from './rpc.ts'

export const steamIdSchema = z.number().int().positive().max(0xffffffff)
export const manifestIdSchema = z.string().regex(/^\d+$/u)
export const steamIdStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform(Number)
  .pipe(steamIdSchema)
export const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/iu)
export const lowercaseSha1Schema = z.string().regex(/^[0-9a-f]{40}$/u)
export const depotKeyHexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/iu, {
    message: 'Depot key must contain exactly 64 hexadecimal characters',
  })
  .transform((value) => value.toLowerCase())
const depotPlatformSchema = z.enum(['windows', 'macos', 'linux'])
export const appSettingsSchema: z.ZodType<AppSettings> = z
  .object({
    automaticManifestAcquisition: z.boolean(),
    hideRedistributables: z.boolean(),
    hideUnknownDepots: z.boolean(),
    hideUnusedDepots: z.boolean(),
    platforms: z.array(depotPlatformSchema),
  })
  .strict()
  .refine(
    (settings) =>
      new Set(settings.platforms).size === settings.platforms.length,
    {
      message: 'platforms must contain unique supported platforms',
      path: ['platforms'],
    },
  )

export const uniqueSteamIdsSchema = z
  .array(steamIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Depot IDs must not contain duplicates',
  })
