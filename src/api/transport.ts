import { Electroview } from 'electrobun/view'

import type { ColdClientOperationSnapshot } from '@/types/cold-client'
import type { AppRpc, DownloadQueueSnapshot } from '@/types/rpc'
import {
  coldClientOperationSnapshotSchema,
  downloadQueueSnapshotSchema,
  rpcResponseSchemas,
} from '@/types/rpc-schemas'

type Requests = AppRpc['bun']['requests']
type AppRequest = <K extends keyof Requests>(
  method: K,
  params: Requests[K]['params'],
) => Promise<Requests[K]['response']>

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
let latestColdClientOperation: ColdClientOperationSnapshot | undefined
let coldClientOperationMessageSequence = 0

const rpc = Electroview.defineRPC<AppRpc>({
  // Electrobun timeouts only abandon the response; they do not cancel native
  // work such as manifest acquisition, filesystem previews, or durable pauses.
  maxRequestTime: Infinity,
  handlers: {
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
    },
  },
})

const electroview = new Electroview({ rpc })

export async function request<K extends keyof Requests>(
  method: K,
  params: Requests[K]['params'],
): Promise<Requests[K]['response']> {
  // SAFETY: every Kalamata RPC request declares required `params`; this removes
  // Electrobun's conditional rest tuple while preserving each method's pairing.
  const appRequest = electroview.rpc!.request as AppRequest
  const response = await appRequest(method, params)
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
