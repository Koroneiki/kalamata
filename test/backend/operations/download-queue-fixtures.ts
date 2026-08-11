import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type SteamUser from 'steam-user'
import type {
  ApplicationDepotRecord,
  ApplicationTransactionResult,
} from '../../../src/backend/depot/install/transaction/types.ts'
import type { ReconcileApplicationOptions } from '../../../src/backend/depot/depot-download-service.ts'
import type {
  ProductInfo,
  ProductInfoResult,
} from '../../../src/backend/steam/types.ts'
import type { DownloadQueueCoordinator } from '../../../src/backend/operations/download-queue.ts'
import { KalamataDatabase } from '../../../src/db/database.ts'

export const APP_ID = 10
export const DLC_APP_ID = 20
export const DEPOTS = [
  {
    depotId: 2379781,
    manifestId: '3512319404653808464',
    key: '16261e41d3e864018778d4a1d81658521a67d9ffb8543ea7e3e21f0685721af1',
  },
  {
    depotId: 593281,
    manifestId: '7871757316108895128',
    key: '33130777c4dc3a1691afe38e0202242580e2135bfb239dcd83e50cd18d384687',
  },
] as const

export interface DownloadQueueFixture {
  database: KalamataDatabase
  installPath: string
  root: string
  cleanup(): Promise<void>
}

export async function setupDownloadQueue(): Promise<DownloadQueueFixture> {
  const root = await mkdtemp(join(tmpdir(), 'kalamata-queue-'))
  const database = await KalamataDatabase.open(
    root,
    join(import.meta.dir, '..', '..', '..', 'src', 'db', 'migrations'),
  )
  const installPath = join(root, 'install')
  await mkdir(installPath)
  database.addLibraryEntry(APP_ID)
  for (const depot of DEPOTS) {
    const relativePath = database.addManifest(depot.depotId, depot.manifestId)
    await copyFile(
      join(
        import.meta.dir,
        '..',
        '..',
        'fixtures',
        `${depot.depotId}_${depot.manifestId}.manifest`,
      ),
      join(root, relativePath),
    )
    database.setDepotKey(depot.depotId, depot.key)
  }
  return {
    database,
    installPath,
    root,
    async cleanup() {
      database.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function install(
  fixture: DownloadQueueFixture,
  depot: (typeof DEPOTS)[number],
): Promise<void> {
  fixture.database.recordInstalledDepot(
    APP_ID,
    await realpath(fixture.installPath),
    depot.depotId,
    depot.manifestId,
  )
}

export async function successfulReconciliation(
  options: ReconcileApplicationOptions,
): Promise<ApplicationTransactionResult> {
  const desired: ApplicationDepotRecord[] = options.desiredDepots.map(
    ({ depotId, manifestId, ownerAppId }, mountIndex) => ({
      depotId,
      manifestId,
      mountIndex,
      ownerAppId,
    }),
  )
  await options.reconcile(desired)
  return {
    transactionId: 'transaction-id',
    logicalInstalledBytes: '30',
    reusedLocalBytes: '20',
    networkBytes: '10',
  }
}

export async function writeQueueStagingJournal(
  options: ReconcileApplicationOptions,
): Promise<void> {
  const id = 'queue-resume'
  const transaction = join(
    options.outputDirectory,
    '.Kalamata',
    'transactions',
    id,
  )
  await mkdir(join(transaction, 'staging'), { recursive: true })
  await writeFile(
    join(transaction, 'journal.json'),
    JSON.stringify({
      version: 2,
      id,
      generation: 'generation',
      appId: options.appId,
      kind: options.kind,
      installPath: options.outputDirectory,
      phase: 'staging',
      paused: false,
      source: options.installedDepots.map(
        ({ depotId, manifestId, ownerAppId }, mountIndex) => ({
          depotId,
          manifestId,
          mountIndex,
          ownerAppId,
        }),
      ),
      desired: options.desiredDepots.map(
        ({ depotId, manifestId, ownerAppId }, mountIndex) => ({
          depotId,
          manifestId,
          mountIndex,
          ownerAppId,
        }),
      ),
      stagedFiles: [],
      completedChunks: {},
      logicalInstalledTotal: '0',
      retainedBytes: '0',
      oldMoves: [],
      installs: [],
      obsoleteDirectories: [],
    }),
  )
}

export async function waitForTerminal(
  queue: DownloadQueueCoordinator,
): Promise<void> {
  while (queue.getOperationState().status === 'active') await Bun.sleep(1)
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function product(
  appId: number,
  depotEntries: Record<string, unknown>,
): ProductInfo {
  return {
    appId,
    changenumber: 1,
    missingToken: false,
    appinfo: {
      common: { name: 'Queue Test' },
      depots: depotEntries,
    } as unknown as SteamUser.AppInfoContent,
  }
}

export function products(
  dlcManifestId: string = DEPOTS[1].manifestId,
): ProductInfoResult {
  return {
    baseProduct: product(APP_ID, {
      [DEPOTS[0].depotId]: depotMetadata(DEPOTS[0].manifestId),
    }),
    dlcProducts: [
      product(DLC_APP_ID, {
        [DEPOTS[1].depotId]: depotMetadata(dlcManifestId),
      }),
    ],
  }
}

function depotMetadata(manifestId: string) {
  return {
    config: { oslist: 'windows' },
    manifests: { public: { gid: manifestId, size: '10', download: '10' } },
  }
}
