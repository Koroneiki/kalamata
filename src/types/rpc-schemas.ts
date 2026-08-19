import { z } from 'zod'
import type { AppRpc } from './rpc.ts'
import {
  appSettingsSchema,
  manifestIdSchema,
  steamIdSchema,
  uniqueSteamIdsSchema,
} from './schemas.ts'
import { AVAILABLE_UPDATE_BATCH_SIZE } from './available-updates.ts'
import {
  coldClientDependencyIdSchema,
  coldClientDetectionSourceSchema,
  coldClientLoaderArchitectureSchema,
  coldClientOperationKinds,
  coldClientOperationPhases,
  coldClientRelativePathSchema,
  coldClientSetupRequestSchema,
  coldClientSetupWarningSchema,
} from './cold-client.ts'

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
const dependencyAssetIdSchema = z.number().int().positive().safe()
const coldClientDependencyItemStatusSchema = strict({
  dependencyId: coldClientDependencyIdSchema,
  status: z.enum(['current', 'update-available', 'missing', 'check-failed']),
  currentAssetId: dependencyAssetIdSchema.nullable(),
  currentTag: z.string().nullable(),
  availableAssetId: dependencyAssetIdSchema.nullable(),
  availableTag: z.string().nullable(),
  error: z.string().nullable(),
})
const coldClientDependencyStatusSchema = strict({
  supported: z.boolean(),
  dependencies: z
    .array(coldClientDependencyItemStatusSchema)
    .length(3)
    .refine(
      (items) =>
        new Set(items.map(({ dependencyId }) => dependencyId)).size === 3,
      'Dependency statuses must be unique',
    ),
  lastCheckedAt: z.number().int().nonnegative().safe().nullable(),
  loginFileExists: z.boolean(),
  loginDirectory: z.string().nullable(),
})
const coldClientLaunchOptionSchema = strict({
  key: z.string().regex(/^\d+$/u),
  executable: coldClientRelativePathSchema,
  matchedExecutableRelativePath: coldClientRelativePathSchema.nullable(),
  arguments: z.string(),
  description: z.string().nullable(),
})
const coldClientSetupDependencySchema = strict({
  assetId: dependencyAssetIdSchema,
  tag: z.string().min(1),
})
const coldClientSetupDraftSchema = strict({
  appId: steamIdSchema,
  targetRelativePath: z.literal('_ColdClient'),
  executableCandidates: z.array(coldClientRelativePathSchema).min(1),
  selectedExecutableRelativePath: coldClientRelativePathSchema.nullable(),
  executableDetectionSource: coldClientDetectionSourceSchema,
  steamApiCandidates: z.array(coldClientRelativePathSchema),
  selectedSteamApiRelativePath: coldClientRelativePathSchema.nullable(),
  steamApiDetectionSource: coldClientDetectionSourceSchema,
  loaderArchitecture: coldClientLoaderArchitectureSchema,
  launchOptions: z.array(coldClientLaunchOptionSchema),
  launchArguments: z.string(),
  launchArgumentSource: z.string().regex(/^\d+$/u).nullable(),
  warnings: z.array(coldClientSetupWarningSchema),
  existingColdClient: z.boolean(),
  gbe: coldClientSetupDependencySchema,
  gse: coldClientSetupDependencySchema,
}).superRefine((draft, ctx) => {
  if (
    draft.selectedExecutableRelativePath !== null &&
    !draft.executableCandidates.includes(draft.selectedExecutableRelativePath)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Selected executable must be a candidate',
      path: ['selectedExecutableRelativePath'],
    })
  }
  if (
    draft.selectedSteamApiRelativePath !== null &&
    !draft.steamApiCandidates.includes(draft.selectedSteamApiRelativePath)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Selected Steam API DLL must be a candidate',
      path: ['selectedSteamApiRelativePath'],
    })
  }
  if (
    draft.launchArgumentSource !== null &&
    !draft.launchOptions.some(({ key }) => key === draft.launchArgumentSource)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Launch argument source must be an available launch entry',
      path: ['launchArgumentSource'],
    })
  }
  if (
    new Set(draft.warnings).size !== draft.warnings.length ||
    new Set(draft.executableCandidates.map((path) => path.toLowerCase()))
      .size !== draft.executableCandidates.length ||
    new Set(draft.steamApiCandidates.map((path) => path.toLowerCase())).size !==
      draft.steamApiCandidates.length
  ) {
    ctx.addIssue({ code: 'custom', message: 'Draft values must be unique' })
  }
})
export const coldClientOperationSnapshotSchema = z.discriminatedUnion(
  'status',
  [
    strict({ status: z.literal('idle') }),
    strict({
      status: z.literal('active'),
      appId: steamIdSchema,
      kind: z.enum(coldClientOperationKinds),
      phase: z.enum(coldClientOperationPhases),
      cancellable: z.boolean(),
    }),
  ],
)
export const coldClientStatusSchema = z.discriminatedUnion('status', [
  strict({
    status: z.literal('unsupported'),
    reason: z.enum(['host-platform', 'not-installed']),
  }),
  strict({ status: z.literal('not-configured') }),
  strict({
    status: z.literal('configured'),
    coreUpdateAvailable: z.boolean(),
    recommendationReasons: z
      .array(z.enum(['depots-changed', 'gse-updated']))
      .refine(
        (reasons) => new Set(reasons).size === reasons.length,
        'Recommendation reasons must be unique',
      ),
    installedGbeTag: z.string().min(1),
    availableGbeTag: z.string().min(1).nullable(),
    installedGseTag: z.string().min(1),
    availableGseTag: z.string().min(1).nullable(),
    lastConfiguredAt: z.number().int().nonnegative().safe(),
  }),
  strict({ status: z.literal('invalid'), message: z.string().min(1) }),
])
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
  estimatedDownloadBytes: manifestIdSchema.nullable(),
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
    estimatedDownloadBytes: manifestIdSchema,
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
    group: z.enum([
      'Unknown',
      'Steamworks Common Redistributables',
      'Unused',
      'Unavailable',
    ]),
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
  installedDepotIds: z.array(steamIdSchema),
  depots: z.array(appDepotSchema),
})
export const availableUpdateResultSchema = z.discriminatedUnion('status', [
  strict({
    status: z.literal('current'),
    appId: steamIdSchema,
    checkedAt: z.number().int().nonnegative(),
  }),
  strict({
    status: z.literal('available'),
    candidate: strict({
      app: appSummarySchema,
      installedDepotIds: uniqueSteamIdsSchema,
      outdatedDepots: z.array(
        strict({
          depotId: steamIdSchema,
          ownerAppId: steamIdSchema,
          installedManifestId: manifestIdSchema,
          targetManifestId: manifestIdSchema,
          sizeBytes: manifestIdSchema.nullable(),
          downloadBytes: manifestIdSchema.nullable(),
        }),
      ),
      totalDownloadBytes: manifestIdSchema.nullable(),
    }),
    checkedAt: z.number().int().nonnegative(),
  }),
  strict({
    status: z.literal('error'),
    appId: steamIdSchema,
    message: z.string(),
    checkedAt: z.number().int().nonnegative(),
  }),
])
const libraryEntrySchema = strict({
  appId: steamIdSchema,
  installPath: z.string().nullable(),
  hasInstalledDepots: z.boolean(),
  createdAt: z.number().int(),
})
const acceptedResultSchema = strict({ accepted: z.literal(true) })
export const hubcapUsageSchema = strict({
  dailyUsage: z.number().int().nonnegative(),
  dailyLimit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  canMakeRequests: z.boolean(),
}).refine(
  (usage) =>
    usage.remaining === Math.max(0, usage.dailyLimit - usage.dailyUsage),
  {
    message: 'remaining must match daily limit minus usage',
    path: ['remaining'],
  },
)
const hubcapUsageResultSchema = z.discriminatedUnion('status', [
  strict({ status: z.literal('available'), usage: hubcapUsageSchema }),
  strict({ status: z.literal('missing-key') }),
  strict({ status: z.literal('invalid-key') }),
  strict({ status: z.literal('stats-unavailable') }),
])
const hubcapDepotKeyOutcomeSchema = z.discriminatedUnion('status', [
  strict({ status: z.literal('approval-required'), usage: hubcapUsageSchema }),
  strict({
    status: z.literal('fetched'),
    usage: hubcapUsageSchema,
    acquiredDepotIds: z.array(steamIdSchema),
  }),
  strict({ status: z.literal('missing-key') }),
  strict({ status: z.literal('invalid-key') }),
  strict({ status: z.literal('quota-exhausted'), usage: hubcapUsageSchema }),
  strict({ status: z.literal('stats-unavailable') }),
])

const rpcRequestSchemas = {
  getAppSummary: idRequestSchema,
  getAppDetails: idRequestSchema,
  checkAvailableUpdate: idRequestSchema,
  checkAvailableUpdates: strict({
    appIds: uniqueSteamIdsSchema.min(1).max(AVAILABLE_UPDATE_BATCH_SIZE),
  }),
  openInstallDirectory: idRequestSchema,
  getLibrary: emptySchema,
  getSettings: emptySchema,
  updateSettings: appSettingsSchema,
  getHubcapUsage: emptySchema,
  openUserDataFolder: emptySchema,
  getColdClientDependencies: emptySchema,
  checkColdClientDependencyUpdates: emptySchema,
  updateColdClientDependencies: strict({
    dependencyIds: z
      .array(coldClientDependencyIdSchema)
      .min(1)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Dependencies must be unique',
      ),
  }),
  openColdClientLoginDirectory: emptySchema,
  inspectColdClientSetup: idRequestSchema,
  getColdClientStatus: idRequestSchema,
  configureColdClient: coldClientSetupRequestSchema,
  regenerateColdClientConfiguration: idRequestSchema,
  getColdClientOperation: emptySchema,
  cancelColdClientOperation: idRequestSchema,
  addLibraryEntry: idRequestSchema,
  removeLibraryEntry: idRequestSchema,
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
  queueDepotUpdate: strict({
    ...operationRequestFields,
    priority: z.boolean().optional(),
  }),
  previewApplicationOperation: strict({
    ...operationRequestFields,
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
    approveLowQuotaHubcap: z.boolean().optional(),
  }),
  cancelOperation: emptySchema,
  pauseOperation: emptySchema,
  resumeOperation: emptySchema,
  getDownloadQueue: emptySchema,
  removeQueuedOperation: strict({ id: z.string().min(1) }),
  prioritizeQueuedOperation: strict({ id: z.string().min(1) }),
} satisfies RequestSchemas

export const rpcResponseSchemas = {
  getAppSummary: appSummarySchema,
  getAppDetails: appDetailsSchema,
  checkAvailableUpdate: availableUpdateResultSchema,
  checkAvailableUpdates: z.array(availableUpdateResultSchema),
  openInstallDirectory: z.void(),
  getLibrary: z.array(libraryEntrySchema),
  getSettings: appSettingsSchema,
  updateSettings: appSettingsSchema,
  getHubcapUsage: hubcapUsageResultSchema,
  openUserDataFolder: z.void(),
  getColdClientDependencies: coldClientDependencyStatusSchema,
  checkColdClientDependencyUpdates: coldClientDependencyStatusSchema,
  updateColdClientDependencies: coldClientDependencyStatusSchema,
  openColdClientLoginDirectory: z.void(),
  inspectColdClientSetup: coldClientSetupDraftSchema,
  getColdClientStatus: coldClientStatusSchema,
  configureColdClient: coldClientStatusSchema,
  regenerateColdClientConfiguration: coldClientStatusSchema,
  getColdClientOperation: coldClientOperationSnapshotSchema,
  cancelColdClientOperation: z.discriminatedUnion('accepted', [
    acceptedResultSchema,
    strict({
      accepted: z.literal(false),
      reason: z.enum(['no-active-operation', 'replacement-in-progress']),
    }),
  ]),
  addLibraryEntry: libraryEntrySchema,
  removeLibraryEntry: z.void(),
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
    hubcap: hubcapDepotKeyOutcomeSchema.optional(),
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
  prioritizeQueuedOperation: downloadQueueSnapshotSchema,
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
