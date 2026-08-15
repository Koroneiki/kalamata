import { z } from 'zod'
import type { AppRpc } from './rpc.ts'
import {
  appSettingsSchema,
  manifestIdSchema,
  steamIdSchema,
  uniqueSteamIdsSchema,
} from './schemas.ts'

type Requests = AppRpc['bun']['requests']
type RequestSchemas = {
  [K in keyof Requests]: z.ZodType<Requests[K]['params']>
}
type ResponseSchemas = {
  [K in keyof Requests]: z.ZodType<Requests[K]['response']>
}
type RpcRequestInput = z.input<
  (typeof rpcRequestSchemas)[keyof typeof rpcRequestSchemas]
>
type RequestHandlers = {
  [K in keyof Requests]: (
    params: Requests[K]['params'],
  ) => Requests[K]['response'] | Promise<Requests[K]['response']>
}

const strict = z.strictObject
const emptySchema = strict({})
const idRequestSchema = strict({ appId: steamIdSchema })
const manifestTargetSchema = strict({
  depotId: steamIdSchema,
  manifestId: manifestIdSchema,
})
const operationRequestFields = {
  appId: steamIdSchema,
  desiredDepotIds: uniqueSteamIdsSchema,
  manifestTargets: z.array(manifestTargetSchema).optional(),
}
const operationKindSchema = z.enum(['download', 'reconcile', 'repair'])
const operationPhaseSchema = z.enum([
  'planning',
  'staging',
  'downloading',
  'verifying',
  'committing',
  'reconciling',
])
const operationErrorKindSchema = z.enum([
  'planning',
  'unavailable-resource',
  'insufficient-space',
  'steam',
  'unavailable-content',
  'transfer-exhausted',
  'integrity',
  'filesystem',
  'cancellation',
  'recovery',
  'persistence',
])
const activeOperationFields = {
  kind: operationKindSchema,
  phase: operationPhaseSchema,
  appId: steamIdSchema,
  installPath: z.string(),
  desiredDepotIds: z.array(steamIdSchema),
  installedBytesCompleted: manifestIdSchema,
  installedBytesTotal: manifestIdSchema,
  reusedLocalBytes: manifestIdSchema,
  networkBytes: manifestIdSchema,
}
const activeOperationStateSchema = strict({
  status: z.literal('active'),
  ...activeOperationFields,
})
const operationErrorSchema = strict({
  kind: operationErrorKindSchema,
  message: z.string(),
})
export const operationStateSchema = z.discriminatedUnion('status', [
  strict({ status: z.literal('idle') }),
  activeOperationStateSchema,
  strict({ status: z.literal('paused'), ...activeOperationFields }),
  strict({
    status: z.literal('resumable'),
    ...activeOperationFields,
    error: operationErrorSchema,
  }),
  strict({
    status: z.literal('completed'),
    kind: operationKindSchema,
    appId: steamIdSchema,
    installPath: z.string(),
    desiredDepotIds: z.array(steamIdSchema),
    installedBytes: manifestIdSchema,
    reusedLocalBytes: manifestIdSchema,
    networkBytes: manifestIdSchema,
  }),
  strict({
    status: z.literal('cancelled'),
    kind: operationKindSchema,
    appId: steamIdSchema,
    installPath: z.string(),
    desiredDepotIds: z.array(steamIdSchema),
    error: strict({ kind: z.literal('cancellation'), message: z.string() }),
  }),
  strict({
    status: z.literal('failed'),
    kind: operationKindSchema,
    appId: steamIdSchema,
    installPath: z.string(),
    desiredDepotIds: z.array(steamIdSchema),
    error: operationErrorSchema,
  }),
  strict({
    status: z.literal('repair-required'),
    appId: steamIdSchema,
    installPath: z.string(),
    error: strict({ kind: z.literal('recovery'), message: z.string() }),
  }),
])
const pendingDownloadSchema = strict({
  id: z.string().min(1),
  appId: steamIdSchema,
  kind: operationKindSchema,
  installPath: z.string().min(1),
  desiredDepotIds: uniqueSteamIdsSchema,
  createdAt: z.number().int().nonnegative(),
})
export const downloadQueueSnapshotSchema = strict({
  operation: operationStateSchema,
  pending: z.array(pendingDownloadSchema),
  repairRequiredAppIds: uniqueSteamIdsSchema,
})
const summaryFields = {
  appId: steamIdSchema,
  name: z.string(),
  developers: z.array(z.string()),
  publishers: z.array(z.string()),
  releaseDate: z.number().int().nullable(),
  iconUrls: z.array(z.string()),
  artworkUrl: z.string().nullable(),
}
const depotBaseFields = {
  depotId: steamIdSchema,
  mountIndex: z.number().int().nonnegative(),
  ownerAppId: steamIdSchema,
  ownerAppName: z.string().nullable(),
  platform: z.string().nullable(),
  language: z.string().nullable(),
  manifestId: manifestIdSchema.nullable(),
  installedManifestId: manifestIdSchema.nullable().optional(),
  pinned: z.boolean().optional(),
  sizeBytes: manifestIdSchema.nullable(),
  downloadBytes: manifestIdSchema.nullable(),
}
const appDepotSchema = z.discriminatedUnion('eligible', [
  strict({
    ...depotBaseFields,
    eligible: z.literal(true),
    group: z.enum(['Base Game', 'DLC']),
    manifestStatus: z.enum(['ready', 'missing', 'outdated', 'invalid']),
    keyStatus: z.enum(['present', 'missing', 'invalid']),
    installStatus: z.enum(['not-installed', 'current', 'outdated']),
    selectable: z.boolean(),
  }),
  strict({
    ...depotBaseFields,
    eligible: z.literal(false),
    group: z.enum(['Unknown', 'Steamworks Common Redistributables', 'Unused']),
    manifestStatus: z.null(),
    keyStatus: z.null(),
    installStatus: z.null(),
    selectable: z.literal(false),
  }),
])
const appSummarySchema = strict(summaryFields)
const appDetailsSchema = strict({
  ...summaryFields,
  inLibrary: z.boolean(),
  installPath: z.string().nullable(),
  selectedDepotIds: z.array(steamIdSchema),
  depots: z.array(appDepotSchema),
})
const libraryEntrySchema = strict({
  appId: steamIdSchema,
  installPath: z.string().nullable(),
  createdAt: z.number().int(),
})
const acceptedResultSchema = strict({ accepted: z.literal(true) })

export const rpcRequestSchemas = {
  getAppSummary: idRequestSchema,
  getAppDetails: idRequestSchema,
  openInstallDirectory: idRequestSchema,
  getLibrary: emptySchema,
  getSettings: emptySchema,
  updateSettings: appSettingsSchema,
  openUserDataFolder: emptySchema,
  addLibraryEntry: idRequestSchema,
  removeLibraryEntry: idRequestSchema,
  setSelectedDepots: strict({
    appId: steamIdSchema,
    depotIds: uniqueSteamIdsSchema,
  }),
  setDepotPinned: strict({
    appId: steamIdSchema,
    depotId: steamIdSchema,
    pinned: z.boolean(),
  }),
  selectInstallDirectory: strict({ startingPath: z.string().optional() }),
  startDownload: strict({
    appId: steamIdSchema,
    installPath: z.string(),
    depotIds: uniqueSteamIdsSchema.min(1),
    manifestTargets: z.array(manifestTargetSchema).optional(),
  }),
  queueDepotUpdate: strict(operationRequestFields),
  previewApplicationOperation: strict({
    ...operationRequestFields,
    installPath: z.string().optional(),
  }),
  repairApplication: idRequestSchema,
  acquireManifest: strict({
    appId: steamIdSchema,
    depotId: steamIdSchema,
    manifestId: manifestIdSchema,
  }),
  acquireDepotKeys: strict({
    appId: steamIdSchema,
    depotIds: uniqueSteamIdsSchema,
  }),
  cancelOperation: emptySchema,
  pauseOperation: emptySchema,
  resumeOperation: emptySchema,
  getDownloadQueue: emptySchema,
  removeQueuedOperation: strict({ id: z.string().min(1) }),
} satisfies RequestSchemas

export const rpcResponseSchemas = {
  getAppSummary: appSummarySchema,
  getAppDetails: appDetailsSchema,
  openInstallDirectory: z.void(),
  getLibrary: z.array(libraryEntrySchema),
  getSettings: appSettingsSchema,
  updateSettings: appSettingsSchema,
  openUserDataFolder: z.void(),
  addLibraryEntry: libraryEntrySchema,
  removeLibraryEntry: z.void(),
  setSelectedDepots: z.array(steamIdSchema),
  setDepotPinned: z.void(),
  selectInstallDirectory: z.string().nullable(),
  startDownload: downloadQueueSnapshotSchema,
  queueDepotUpdate: downloadQueueSnapshotSchema,
  previewApplicationOperation: strict({
    overlaps: z.array(
      strict({
        depotId: steamIdSchema,
        overriddenByDepotIds: z.array(steamIdSchema),
        complete: z.boolean(),
      }),
    ),
    depots: z.array(
      strict({
        depotId: steamIdSchema,
        action: z.enum(['install', 'remove', 'update']),
        currentManifestId: manifestIdSchema.nullable(),
        targetManifestId: manifestIdSchema.nullable(),
        currentSizeBytes: manifestIdSchema,
        targetSizeBytes: manifestIdSchema,
        targetDownloadBytes: manifestIdSchema,
      }),
    ),
    counts: strict({
      install: z.number().int(),
      remove: z.number().int(),
      update: z.number().int(),
    }),
    fileCounts: strict({
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative(),
    }),
    logicalSizeDeltaBytes: z.string().regex(/^-?\d+$/u),
    estimatedDownloadBytes: manifestIdSchema,
    networkPayloadUpperBoundBytes: manifestIdSchema.nullable(),
    stagingLogicalUpperBoundBytes: manifestIdSchema,
  }),
  repairApplication: downloadQueueSnapshotSchema,
  acquireManifest: strict({
    depotId: steamIdSchema,
    manifestId: manifestIdSchema,
    relativePath: z.string(),
  }),
  acquireDepotKeys: strict({
    acquiredDepotIds: z.array(steamIdSchema),
    missingDepotIds: z.array(steamIdSchema),
  }),
  cancelOperation: z.discriminatedUnion('accepted', [
    acceptedResultSchema,
    strict({
      accepted: z.literal(false),
      reason: z.enum(['no-active-operation', 'commit-in-progress']),
    }),
  ]),
  pauseOperation: z.discriminatedUnion('accepted', [
    acceptedResultSchema,
    strict({
      accepted: z.literal(false),
      reason: z.enum(['no-active-operation', 'invalid-phase']),
    }),
  ]),
  resumeOperation: z.discriminatedUnion('accepted', [
    acceptedResultSchema,
    strict({
      accepted: z.literal(false),
      reason: z.literal('no-resumable-operation'),
    }),
  ]),
  getDownloadQueue: downloadQueueSnapshotSchema,
  removeQueuedOperation: downloadQueueSnapshotSchema,
} satisfies ResponseSchemas

export function parseRpcRequest<K extends keyof Requests>(
  method: K,
  value: RpcRequestInput,
): Requests[K]['params'] {
  // SAFETY: `method` indexes a schema declared against the same request contract.
  return rpcRequestSchemas[method].parse(value) as Requests[K]['params']
}

export function validatedRpcHandlers(
  handlers: RequestHandlers,
): RequestHandlers {
  // SAFETY: `RequestHandlers` requires every key. This assertion erases only the
  // correlated key/value relationship so one loop can generate the wrappers.
  const untypedHandlers = handlers as Record<
    keyof Requests,
    (
      params: Requests[keyof Requests]['params'],
    ) =>
      | Requests[keyof Requests]['response']
      | Promise<Requests[keyof Requests]['response']>
  >
  // SAFETY: each entry retains its original method and handler as a pair, and the
  // wrapper validates parameters with that method's schema before dispatching.
  return Object.fromEntries(
    Object.entries(untypedHandlers).map(([method, handler]) => [
      method,
      (value: Requests[keyof Requests]['params']) => {
        // SAFETY: `method` originates from the complete keyed handler record above.
        const requestMethod = method as keyof Requests
        return handler(parseRpcRequest(requestMethod, value))
      },
    ]),
  ) as RequestHandlers
}
