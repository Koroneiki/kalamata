import { test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
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
import type { DepotManifest } from '../../../src/backend/depot/manifests/types.ts'
import { KalamataDatabase } from '../../../src/db/database.ts'
import { removeTemporaryDirectory } from '../../helpers/filesystem.ts'

export const APP_ID = 10
export const DLC_APP_ID = 20
export const DEPOTS = [
  {
    depotId: 2379781,
    manifestId: '3512319404653808464',
    key: '01'.repeat(32),
  },
  {
    depotId: 593281,
    manifestId: '7871757316108895128',
    key: '02'.repeat(32),
  },
] as const
export const queueTest = test

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
    await writeFile(
      join(root, relativePath),
      encodeManifest(syntheticManifest(depot.depotId, depot.manifestId)),
    )
    database.setDepotKey(depot.depotId, depot.key)
  }
  return {
    database,
    installPath,
    root,
    async cleanup() {
      database.close()
      await removeTemporaryDirectory(root)
    },
  }
}

function syntheticManifest(depotId: number, manifestId: string): DepotManifest {
  const contents = Buffer.from(`depot-${depotId}`)
  const sha = createHash('sha1').update(contents).digest('hex')
  return {
    depot_id: depotId,
    gid_manifest: manifestId,
    filenames_encrypted: false,
    cb_disk_original: String(contents.length),
    cb_disk_compressed: String(contents.length),
    files: [
      {
        filename: `depot-${depotId}.bin`,
        size: String(contents.length),
        flags: 0,
        sha_content: sha,
        chunks: [
          {
            sha,
            crc: 1,
            offset: '0',
            cb_original: contents.length,
            cb_compressed: contents.length,
          },
        ],
      },
    ],
  }
}

function encodeManifest(manifest: DepotManifest): Buffer {
  const require = createRequire(import.meta.url)
  // SAFETY: steam-user's generated loader exposes these protobuf types but has no declarations.
  const schema =
    require('steam-user/protobufs/generated/_load.js') as ManifestSchema
  const payload = schema.ContentManifestPayload.encode({
    mappings: manifest.files.map((file) => ({
      ...file,
      sha_content: Buffer.from(file.sha_content, 'hex'),
      chunks: file.chunks.map((chunk) => ({
        ...chunk,
        sha: Buffer.from(chunk.sha, 'hex'),
      })),
    })),
  }).finish()
  const metadata = schema.ContentManifestMetadata.encode(manifest).finish()
  return Buffer.concat([
    manifestSection(0x71f617d0, payload),
    manifestSection(0x1f4812be, metadata),
    Buffer.from([0xab, 0x15, 0xc4, 0x32]),
  ])
}

function manifestSection(magic: number, contents: Uint8Array): Buffer {
  const header = Buffer.alloc(8)
  header.writeUint32LE(magic, 0)
  header.writeUint32LE(contents.length, 4)
  return Buffer.concat([header, contents])
}

interface ManifestSchema {
  ContentManifestPayload: ProtobufType
  ContentManifestMetadata: ProtobufType
}

interface ProtobufType {
  encode(value: DepotManifest | ManifestPayload): { finish(): Uint8Array }
}

interface ManifestPayload {
  mappings: Array<
    Omit<DepotManifest['files'][number], 'sha_content' | 'chunks'> & {
      sha_content: Buffer
      chunks: Array<
        Omit<DepotManifest['files'][number]['chunks'][number], 'sha'> & {
          sha: Buffer
        }
      >
    }
  >
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
    ({ depotId, manifestId, pinned, ownerAppId }, mountIndex) => ({
      depotId,
      manifestId,
      pinned,
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
  paused = false,
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
      paused,
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
  let reject!: (reason?: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function product(
  appId: number,
  appInfoId: `${number}`,
  depotEntries: NonNullable<SteamUser.AppInfoContentGame['depots']>,
): ProductInfo {
  return {
    appId,
    changenumber: 1,
    missingToken: false,
    appinfo: {
      appid: appInfoId,
      common: { name: 'Queue Test', type: 'game', gameid: appInfoId },
      depots: depotEntries,
    },
  }
}

export function products(
  dlcManifestId: string = DEPOTS[1].manifestId,
): ProductInfoResult {
  return {
    baseProduct: product(APP_ID, `${APP_ID}`, {
      [DEPOTS[0].depotId]: depotMetadata(DEPOTS[0].manifestId),
    }),
    listedDlcAppIds: [DLC_APP_ID],
    dlcProducts: [
      product(DLC_APP_ID, `${DLC_APP_ID}`, {
        [DEPOTS[1].depotId]: depotMetadata(dlcManifestId),
      }),
    ],
    eligibleBaseDepotIds: null,
    eligibleDlcDepotIds: new Map(),
  }
}

function depotMetadata(manifestId: string) {
  return {
    config: { oslist: 'windows' },
    manifests: { public: { gid: manifestId, size: '10', download: '10' } },
  }
}
