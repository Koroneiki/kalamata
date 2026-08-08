import { Electroview } from 'electrobun/view'

import type { AppRpc, DownloadQueueState } from '@/types/rpc'

type DownloadStateListener = (
  state: DownloadQueueState,
  messageSequence: number,
) => void

const downloadStateListeners = new Set<DownloadStateListener>()
let latestDownloadState: DownloadQueueState | undefined
let downloadStateMessageSequence = 0

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
    },
  },
})

export const electroview = new Electroview({ rpc })

export function getDownloadStateMessageSequence() {
  return downloadStateMessageSequence
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
