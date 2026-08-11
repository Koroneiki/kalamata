import { Electroview } from 'electrobun/view'

import type { AppRpc, DownloadQueueState, OperationState } from '@/types/rpc'

type DownloadStateListener = (
  state: DownloadQueueState,
  messageSequence: number,
) => void
type OperationStateListener = (
  state: OperationState,
  messageSequence: number,
) => void

const downloadStateListeners = new Set<DownloadStateListener>()
const operationStateListeners = new Set<OperationStateListener>()
let latestDownloadState: DownloadQueueState | undefined
let latestOperationState: OperationState | undefined
let downloadStateMessageSequence = 0
let operationStateMessageSequence = 0

const rpc = Electroview.defineRPC<AppRpc>({
  maxRequestTime: 30_000,
  handlers: {
    messages: {
      downloadStateChanged: (state) => {
        latestDownloadState = state
        downloadStateMessageSequence += 1

        for (const listener of downloadStateListeners) {
          listener(state, downloadStateMessageSequence)
        }
      },
      operationStateChanged: (state) => {
        latestOperationState = state
        operationStateMessageSequence += 1
        for (const listener of operationStateListeners)
          listener(state, operationStateMessageSequence)
      },
    },
  },
})

export const electroview = new Electroview({ rpc })

export function getDownloadStateMessageSequence() {
  return downloadStateMessageSequence
}

export function subscribeToOperationState(
  listener: OperationStateListener,
): () => void {
  operationStateListeners.add(listener)
  if (latestOperationState)
    listener(latestOperationState, operationStateMessageSequence)
  return () => operationStateListeners.delete(listener)
}

export function getOperationStateMessageSequence() {
  return operationStateMessageSequence
}

export function subscribeToDownloadState(
  listener: DownloadStateListener,
): () => void {
  downloadStateListeners.add(listener)

  if (latestDownloadState) {
    listener(latestDownloadState, downloadStateMessageSequence)
  }

  return () => downloadStateListeners.delete(listener)
}
