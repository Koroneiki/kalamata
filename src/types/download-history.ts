import { z } from 'zod'
import { steamIdSchema } from './schemas.ts'

// History is cosmetic and bounded independently of queues and recovery journals.
export const DOWNLOAD_HISTORY_LIMIT = 100
const downloadHistoryEntrySchema = z.strictObject({
  id: z.string().min(1),
  appId: steamIdSchema.nullable(),
  title: z.string(),
  // Optional details keep history saved before these fields were added readable.
  description: z.string().optional(),
  totalBytes: z.string().regex(/^\d+$/u).nullable().optional(),
  operation: z.enum(['install', 'update', 'uninstall', 'repair']).optional(),
  depotCount: z.number().int().nonnegative().safe().optional(),
  compact: z.boolean(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  transferredBytes: z.string().regex(/^\d+$/u),
  error: z.string().nullable(),
  finishedAt: z.number().int().nonnegative().safe(),
})
export const downloadHistorySchema = z
  .array(downloadHistoryEntrySchema)
  .max(DOWNLOAD_HISTORY_LIMIT)
export type DownloadHistoryEntry = z.output<typeof downloadHistoryEntrySchema>
