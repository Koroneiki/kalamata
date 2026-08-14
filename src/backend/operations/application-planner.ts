import { extractPublicDepots } from '../apps/product-normalizer.ts'
import type { ApplicationDepotInput } from '../depot/depot-download-service.ts'
import type { ApplicationDepotRecord } from '../depot/install/transaction/types.ts'
import { ApplicationTransactionError } from '../depot/install/transaction/types.ts'
import { abortable } from '../shared/abortable.ts'
import type { ProductInfoResult } from '../steam/types.ts'
import type { KalamataDatabase } from '../../db/database.ts'
import { validateManagedManifest } from '../../db/manifest-files.ts'
import { depotKeyFromHex } from '../../db/validation.ts'
import type { DepotManifestTarget, OperationKind } from '../../types/rpc.ts'

type InstalledDepotRow = ReturnType<KalamataDatabase['getInstalls']>[number]
type PublicDepot = ReturnType<typeof extractPublicDepots>[number]
type DepotMetadata = Map<number, PublicDepot>
type DepotResources = Map<
  string,
  Promise<Omit<ApplicationDepotInput, 'ownerAppId' | 'pinned'>>
>

interface DesiredDepotContext {
  request: ApplicationPlanRequest
  installedRows: InstalledDepotRow[]
  metadata: DepotMetadata
  requested: Set<number>
  manifestTargets: Map<number, DepotManifestTarget>
  pureRemoval: boolean
  signal: AbortSignal
  database: KalamataDatabase
  resources: DepotResources
}

export interface ApplicationPlanRequest {
  kind: OperationKind
  appId: number
  installPath: string
  requestedDepotIds?: number[]
  desiredDepotIds?: number[]
  fixedDesired?: ApplicationDepotRecord[]
  manifestTargets?: DepotManifestTarget[]
}

export interface ApplicationMetadataService {
  getProductInfoWithDlc(appId: number): Promise<ProductInfoResult>
}

export interface ApplicationPlan {
  installedDepots: ApplicationDepotInput[]
  desiredDepots: ApplicationDepotInput[]
  desiredDepotIds: number[]
}

export async function planApplication(
  request: ApplicationPlanRequest,
  steam: ApplicationMetadataService,
  database: KalamataDatabase,
  signal: AbortSignal,
  onDesiredDepotIds: (depotIds: number[]) => void,
): Promise<ApplicationPlan> {
  const installedRows = database.getInstalls(request.appId)
  const desiredIds = getDesiredDepotIds(request, installedRows)
  const pureRemoval = isPureRemoval(request, installedRows, desiredIds)
  const needsOwnershipMetadata = requiresOwnershipMetadata(
    installedRows,
    desiredIds,
  )
  const publicDepots = await getPublicDepots(
    request,
    steam,
    signal,
    pureRemoval,
    needsOwnershipMetadata,
  )
  signal.throwIfAborted()
  const metadata = new Map(publicDepots.map((depot) => [depot.depotId, depot]))
  const metadataOrder = publicDepots.map(({ depotId }) => depotId)
  // Physical resources are shared; ownership remains specific to each occurrence.
  const resources: DepotResources = new Map()
  const installedDepots = await Promise.all(
    installedRows.map((row) =>
      planDepot(
        row.depotId,
        row.installedManifestId,
        metadata,
        signal,
        row.ownerAppId ??
          metadata.get(row.depotId)?.ownerAppId ??
          request.appId,
        database,
        resources,
        row.pinned,
      ),
    ),
  )
  validateDesiredAvailability(request, installedRows, desiredIds, metadata)
  validateOwnershipMetadata(
    installedRows,
    desiredIds,
    metadata,
    needsOwnershipMetadata,
  )
  const desiredOrder = getDesiredDepotOrder(
    request,
    installedRows,
    desiredIds,
    metadata,
    metadataOrder,
    pureRemoval,
  )
  onDesiredDepotIds(desiredOrder)
  const context: DesiredDepotContext = {
    request,
    installedRows,
    metadata,
    requested: new Set(request.requestedDepotIds ?? []),
    manifestTargets: new Map(
      request.manifestTargets?.map((target) => [target.depotId, target]),
    ),
    pureRemoval,
    signal,
    database,
    resources,
  }
  const desiredDepots = await Promise.all(
    desiredOrder.map((depotId) => planDesiredDepot(depotId, context)),
  )
  signal.throwIfAborted()
  return { installedDepots, desiredDepots, desiredDepotIds: desiredOrder }
}

function getDesiredDepotIds(
  request: ApplicationPlanRequest,
  installedRows: InstalledDepotRow[],
): Set<number> {
  // Desired selection drives reconciliation; legacy starts are additive.
  const desiredIds =
    request.kind === 'download'
      ? new Set([
          ...installedRows.map(({ depotId }) => depotId),
          ...(request.requestedDepotIds ?? []),
        ])
      : new Set(request.desiredDepotIds ?? [])
  if (request.fixedDesired)
    for (const { depotId } of request.fixedDesired) desiredIds.add(depotId)
  return desiredIds
}

function isPureRemoval(
  request: ApplicationPlanRequest,
  installedRows: InstalledDepotRow[],
  desiredIds: Set<number>,
): boolean {
  return (
    request.kind === 'reconcile' &&
    desiredIds.size < installedRows.length &&
    [...desiredIds].every((depotId) =>
      installedRows.some((row) => row.depotId === depotId),
    )
  )
}

function requiresOwnershipMetadata(
  installedRows: InstalledDepotRow[],
  desiredIds: Set<number>,
): boolean {
  return installedRows.some(
    (row) => desiredIds.has(row.depotId) && row.ownerAppId === null,
  )
}

async function getPublicDepots(
  request: ApplicationPlanRequest,
  steam: ApplicationMetadataService,
  signal: AbortSignal,
  pureRemoval: boolean,
  needsOwnershipMetadata: boolean,
): Promise<PublicDepot[]> {
  const canPlanLocally =
    request.fixedDesired !== undefined ||
    ((request.kind === 'repair' || pureRemoval) && !needsOwnershipMetadata)
  if (canPlanLocally) return []

  const product = await abortable(
    steam.getProductInfoWithDlc(request.appId).catch((error) => {
      throw new ApplicationTransactionError(
        'steam',
        'Steam product metadata is unavailable',
        { cause: error },
      )
    }),
    signal,
  )
  return extractPublicDepots(product)
}

function validateDesiredAvailability(
  request: ApplicationPlanRequest,
  installedRows: InstalledDepotRow[],
  desiredIds: Set<number>,
  metadata: DepotMetadata,
): void {
  const unavailableDesired = [...desiredIds].filter(
    (depotId) =>
      !installedRows.some((row) => row.depotId === depotId) &&
      // Recovery pins the journal target; planDepot still validates its local input.
      !request.fixedDesired?.some((record) => record.depotId === depotId) &&
      !metadata.has(depotId),
  )
  if (unavailableDesired.length > 0)
    throw new ApplicationTransactionError(
      'unavailable-resource',
      `Depots are unavailable for this application: ${unavailableDesired.join(', ')}`,
    )
}

function validateOwnershipMetadata(
  installedRows: InstalledDepotRow[],
  desiredIds: Set<number>,
  metadata: DepotMetadata,
  needsOwnershipMetadata: boolean,
): void {
  if (
    needsOwnershipMetadata &&
    installedRows.some(
      (row) => desiredIds.has(row.depotId) && !metadata.has(row.depotId),
    )
  )
    throw new ApplicationTransactionError(
      'unavailable-resource',
      'Legacy depot ownership could not be resolved from Steam metadata',
    )
}

function getDesiredDepotOrder(
  request: ApplicationPlanRequest,
  installedRows: InstalledDepotRow[],
  desiredIds: Set<number>,
  metadata: DepotMetadata,
  metadataOrder: number[],
  pureRemoval: boolean,
): number[] {
  if (request.fixedDesired)
    return request.fixedDesired.map(({ depotId }) => depotId)
  if (request.kind === 'repair' || pureRemoval)
    return installedRows
      .map(({ depotId }) => depotId)
      .filter((depotId) => desiredIds.has(depotId))

  return [
    ...metadataOrder.filter((depotId) => desiredIds.has(depotId)),
    // Keep unavailable installed depots after published depots without
    // disturbing their persisted relative mount order.
    ...installedRows
      .map(({ depotId }) => depotId)
      .filter((depotId) => desiredIds.has(depotId) && !metadata.has(depotId)),
  ]
}

async function planDesiredDepot(
  depotId: number,
  context: DesiredDepotContext,
): Promise<ApplicationDepotInput> {
  const installed = context.installedRows.find((row) => row.depotId === depotId)
  const fixed = getFixedDesired(context.request, depotId)
  const customManifestId = getCustomManifestId(context.manifestTargets, depotId)
  const manifestId = resolveManifestId(
    depotId,
    installed,
    fixed,
    customManifestId,
    context,
  )
  if (!manifestId)
    throw new ApplicationTransactionError(
      'unavailable-resource',
      `Depot ${depotId} has no available target manifest`,
    )

  return planDepot(
    depotId,
    manifestId,
    context.metadata,
    context.signal,
    resolveOwnerAppId(depotId, installed, fixed, context),
    context.database,
    context.resources,
    resolvePinned(installed, fixed, customManifestId),
  )
}

function getFixedDesired(
  request: ApplicationPlanRequest,
  depotId: number,
): ApplicationDepotRecord | undefined {
  return request.fixedDesired?.find((record) => record.depotId === depotId)
}

function getCustomManifestId(
  manifestTargets: Map<number, DepotManifestTarget>,
  depotId: number,
): string | undefined {
  return manifestTargets.get(depotId)?.manifestId
}

function resolveManifestId(
  depotId: number,
  installed: InstalledDepotRow | undefined,
  fixed: ApplicationDepotRecord | undefined,
  customManifestId: string | undefined,
  context: DesiredDepotContext,
): string | null | undefined {
  const selectedManifestId = fixed?.manifestId ?? customManifestId
  if (selectedManifestId != null) return selectedManifestId
  if (
    installed?.pinned ||
    shouldUseInstalledManifest(depotId, installed, context)
  )
    return installed?.installedManifestId
  return context.metadata.get(depotId)?.manifestId
}

function resolveOwnerAppId(
  depotId: number,
  installed: InstalledDepotRow | undefined,
  fixed: ApplicationDepotRecord | undefined,
  context: DesiredDepotContext,
): number {
  return (
    fixed?.ownerAppId ??
    installed?.ownerAppId ??
    context.metadata.get(depotId)?.ownerAppId ??
    context.request.appId
  )
}

function resolvePinned(
  installed: InstalledDepotRow | undefined,
  fixed: ApplicationDepotRecord | undefined,
  customManifestId: string | undefined,
): boolean {
  const fixedPinned = fixed?.pinned
  if (fixedPinned != null) return fixedPinned
  if (customManifestId !== undefined) return true
  return installed?.pinned ?? false
}

function shouldUseInstalledManifest(
  depotId: number,
  installed: InstalledDepotRow | undefined,
  context: DesiredDepotContext,
): boolean {
  return (
    context.pureRemoval ||
    context.request.kind === 'repair' ||
    (context.request.kind === 'download' &&
      installed !== undefined &&
      !context.requested.has(depotId))
  )
}

async function planDepot(
  depotId: number,
  manifestId: string,
  metadata: DepotMetadata,
  signal: AbortSignal,
  fallbackOwnerAppId: number,
  database: KalamataDatabase,
  resources: DepotResources,
  pinned = false,
): Promise<ApplicationDepotInput> {
  signal.throwIfAborted()
  const depot = metadata.get(depotId)
  if (depot && depot.group !== 'Base Game' && depot.group !== 'DLC')
    throw new ApplicationTransactionError(
      'planning',
      `Depot ${depotId} is not eligible for this application`,
    )
  const resourceKey = `${depotId}:${manifestId}`
  let resource = resources.get(resourceKey)
  if (!resource) {
    resource = loadDepotResource(depotId, manifestId, database)
    resources.set(resourceKey, resource)
  }
  return {
    ...(await resource),
    ownerAppId: depot?.ownerAppId ?? fallbackOwnerAppId,
    pinned,
  }
}

async function loadDepotResource(
  depotId: number,
  manifestId: string,
  database: KalamataDatabase,
): Promise<Omit<ApplicationDepotInput, 'ownerAppId' | 'pinned'>> {
  const row = database
    .getManifestRows(depotId)
    .find((candidate) => candidate.manifestId === manifestId)
  const keyText = database.getDepotKey(depotId)
  if (!row || keyText === null)
    throw new ApplicationTransactionError(
      'unavailable-resource',
      `Depot ${depotId} requires a manually supplied manifest and key`,
    )
  try {
    const depotKey = depotKeyFromHex(keyText)
    const manifestPath = await validateManagedManifest(
      database.dataRoot,
      depotId,
      manifestId,
      row.relativePath,
      depotKey,
    )
    return { depotId, manifestId, manifestPath, depotKey }
  } catch (error) {
    throw new ApplicationTransactionError(
      'unavailable-resource',
      `Depot ${depotId} manifest or key is invalid`,
      { cause: error },
    )
  }
}
