import { extractPublicDepots } from '../apps/product-normalizer.ts'
import type { ApplicationDepotInput } from '../depot/depot-download-service.ts'
import type { ApplicationDepotRecord } from '../depot/install/transaction/types.ts'
import { ApplicationTransactionError } from '../depot/install/transaction/types.ts'
import { abortable } from '../shared/abortable.ts'
import type { ProductInfoResult } from '../steam/types.ts'
import type { KalamataDatabase } from '../../db/database.ts'
import { validateManagedManifest } from '../../db/manifest-files.ts'
import { depotKeyFromHex } from '../../db/validation.ts'
import type { OperationKind } from '../../types/rpc.ts'

export interface ApplicationPlanRequest {
  kind: OperationKind
  appId: number
  installPath: string
  requestedDepotIds?: number[]
  desiredDepotIds?: number[]
  fixedDesired?: ApplicationDepotRecord[]
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
  const pureRemoval =
    request.kind === 'reconcile' &&
    desiredIds.size < installedRows.length &&
    [...desiredIds].every((depotId) =>
      installedRows.some((row) => row.depotId === depotId),
    )
  const needsOwnershipMetadata = installedRows.some(
    (row) => desiredIds.has(row.depotId) && row.ownerAppId === null,
  )
  const canPlanLocally =
    request.fixedDesired !== undefined ||
    ((request.kind === 'repair' || pureRemoval) && !needsOwnershipMetadata)
  const publicDepots = canPlanLocally
    ? []
    : extractPublicDepots(
        await abortable(
          steam.getProductInfoWithDlc(request.appId).catch((error) => {
            throw new ApplicationTransactionError(
              'steam',
              'Steam product metadata is unavailable',
              { cause: error },
            )
          }),
          signal,
        ),
      )
  signal.throwIfAborted()
  const metadata = new Map(publicDepots.map((depot) => [depot.depotId, depot]))
  const metadataOrder = publicDepots.map(({ depotId }) => depotId)
  const requested = new Set(request.requestedDepotIds ?? [])
  // Physical resources are shared; ownership remains specific to each occurrence.
  const resources = new Map<
    string,
    Promise<Omit<ApplicationDepotInput, 'ownerAppId'>>
  >()
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
      ),
    ),
  )
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
  const desiredOrder = request.fixedDesired
    ? request.fixedDesired.map(({ depotId }) => depotId)
    : request.kind === 'repair' || pureRemoval
      ? installedRows
          .map(({ depotId }) => depotId)
          .filter((depotId) => desiredIds.has(depotId))
      : [
          ...metadataOrder.filter((depotId) => desiredIds.has(depotId)),
          // Keep unavailable installed depots after published depots without
          // disturbing their persisted relative mount order.
          ...installedRows
            .map(({ depotId }) => depotId)
            .filter(
              (depotId) => desiredIds.has(depotId) && !metadata.has(depotId),
            ),
        ]
  onDesiredDepotIds(desiredOrder)
  const desiredDepots = await Promise.all(
    desiredOrder.map((depotId) => {
      const installed = installedRows.find((row) => row.depotId === depotId)
      const publicManifestId = metadata.get(depotId)?.manifestId
      const fixed = request.fixedDesired?.find(
        (record) => record.depotId === depotId,
      )
      const useInstalled =
        pureRemoval ||
        request.kind === 'repair' ||
        (request.kind === 'download' &&
          installed !== undefined &&
          !requested.has(depotId))
      const manifestId =
        fixed?.manifestId ??
        (useInstalled ? installed?.installedManifestId : publicManifestId)
      if (!manifestId)
        throw new ApplicationTransactionError(
          'unavailable-resource',
          `Depot ${depotId} has no available target manifest`,
        )
      return planDepot(
        depotId,
        manifestId,
        metadata,
        signal,
        fixed?.ownerAppId ??
          installed?.ownerAppId ??
          metadata.get(depotId)?.ownerAppId ??
          request.appId,
        database,
        resources,
      )
    }),
  )
  signal.throwIfAborted()
  return { installedDepots, desiredDepots, desiredDepotIds: desiredOrder }
}

async function planDepot(
  depotId: number,
  manifestId: string,
  metadata: Map<number, ReturnType<typeof extractPublicDepots>[number]>,
  signal: AbortSignal,
  fallbackOwnerAppId: number,
  database: KalamataDatabase,
  resources: Map<string, Promise<Omit<ApplicationDepotInput, 'ownerAppId'>>>,
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
  }
}

async function loadDepotResource(
  depotId: number,
  manifestId: string,
  database: KalamataDatabase,
): Promise<Omit<ApplicationDepotInput, 'ownerAppId'>> {
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
