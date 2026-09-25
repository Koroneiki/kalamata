import { Electroview } from 'electrobun/view'

import type {
  ColdClientDependencyStatus,
  ColdClientOperationSnapshot,
} from '@/types/cold-client'
import type { BackgroundDownloadsSnapshot } from '@/types/background-downloads'
import type {
  AppRpc,
  ApplicationUpdateStatus,
  DownloadQueueSnapshot,
} from '@/types/rpc'
import {
  coldClientOperationSnapshotSchema,
  backgroundDownloadsSnapshotSchema,
  applicationUpdateStatusSchema,
  coldClientDependencyStatusSchema,
  downloadQueueSnapshotSchema,
  rpcResponseSchemas,
} from '@/types/rpc-schemas'

type Requests = AppRpc['bun']['requests']
type AppRequests = {
  [K in keyof Requests]: (
    params: Requests[K]['params'],
  ) => Promise<Requests[K]['response']>
}

type DownloadQueueListener = (
  snapshot: DownloadQueueSnapshot,
  messageSequence: number,
) => void
type ColdClientOperationListener = (
  snapshot: ColdClientOperationSnapshot,
  messageSequence: number,
) => void

const downloadQueueListeners = new Set<DownloadQueueListener>()
let latestDownloadQueue: DownloadQueueSnapshot | undefined
let downloadQueueMessageSequence = 0
const coldClientOperationListeners = new Set<ColdClientOperationListener>()
const backgroundListeners = new Set<
  (snapshot: BackgroundDownloadsSnapshot) => void
>()
const applicationUpdateListeners = new Set<
  (status: ApplicationUpdateStatus) => void
>()
const dependencyListeners = new Set<
  (status: ColdClientDependencyStatus) => void
>()
let latestBackground: BackgroundDownloadsSnapshot | undefined
let backgroundSequence = 0
let latestColdClientOperation: ColdClientOperationSnapshot | undefined
let coldClientOperationMessageSequence = 0

const rpc = Electroview.defineRPC<AppRpc>({
  // Electrobun timeouts only abandon the response; they do not cancel native
  // work such as manifest acquisition, filesystem previews, or durable pauses.
  maxRequestTime: Infinity,
  handlers: {
    requests: {},
    messages: {
      downloadQueueChanged: (snapshot) => {
        const result = downloadQueueSnapshotSchema.safeParse(snapshot)
        if (!result.success) return
        latestDownloadQueue = result.data
        downloadQueueMessageSequence += 1
        for (const listener of downloadQueueListeners)
          listener(result.data, downloadQueueMessageSequence)
      },
      coldClientOperationChanged: (snapshot) => {
        const result = coldClientOperationSnapshotSchema.safeParse(snapshot)
        if (!result.success) return
        latestColdClientOperation = result.data
        coldClientOperationMessageSequence += 1
        for (const listener of coldClientOperationListeners)
          listener(result.data, coldClientOperationMessageSequence)
      },
      backgroundDownloadsChanged: (snapshot) => {
        const result = backgroundDownloadsSnapshotSchema.safeParse(snapshot)
        if (!result.success) return
        latestBackground = result.data
        backgroundSequence += 1
        for (const listener of backgroundListeners) listener(result.data)
      },
      applicationUpdateChanged: (status) => {
        const parsed = applicationUpdateStatusSchema.safeParse(status)
        if (!parsed.success) return
        for (const listener of applicationUpdateListeners) listener(parsed.data)
      },
      coldClientDependenciesChanged: (status) => {
        const parsed = coldClientDependencyStatusSchema.safeParse(status)
        if (!parsed.success) return
        for (const listener of dependencyListeners) listener(parsed.data)
      },
    },
  },
})

new Electroview({ rpc })

export async function request<K extends keyof Requests>(
  method: K,
  params: Requests[K]['params'],
): Promise<Requests[K]['response']> {
  // SAFETY: the method key selects the matching parameter and response types.
  const appRequests = rpc.request as AppRequests
  const response = await appRequests[method](params)
  // SAFETY: `method` selects both the RPC response contract and its matching schema.
  return rpcResponseSchemas[method].parse(response) as Requests[K]['response']
}

export function subscribeToDownloadQueue(
  listener: DownloadQueueListener,
): () => void {
  downloadQueueListeners.add(listener)
  if (latestDownloadQueue)
    listener(latestDownloadQueue, downloadQueueMessageSequence)
  return () => downloadQueueListeners.delete(listener)
}

export function getDownloadQueueMessageSequence() {
  return downloadQueueMessageSequence
}

export function subscribeToColdClientOperation(
  listener: ColdClientOperationListener,
): () => void {
  coldClientOperationListeners.add(listener)
  if (latestColdClientOperation)
    listener(latestColdClientOperation, coldClientOperationMessageSequence)
  return () => coldClientOperationListeners.delete(listener)
}

export function getColdClientOperationMessageSequence() {
  return coldClientOperationMessageSequence
}

export function subscribeToBackgroundDownloads(
  listener: (snapshot: BackgroundDownloadsSnapshot) => void,
) {
  backgroundListeners.add(listener)
  if (latestBackground) listener(latestBackground)
  return () => backgroundListeners.delete(listener)
}

export function getBackgroundDownloadsMessageSequence() {
  return backgroundSequence
}

export function subscribeToUpdateStatuses(
  application: (status: ApplicationUpdateStatus) => void,
  dependencies: (status: ColdClientDependencyStatus) => void,
) {
  applicationUpdateListeners.add(application)
  dependencyListeners.add(dependencies)
  return () => {
    applicationUpdateListeners.delete(application)
    dependencyListeners.delete(dependencies)
  }
}
