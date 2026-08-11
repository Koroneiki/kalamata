import { Electroview } from 'electrobun/view'

import type { AppRpc, OperationState } from '@/types/rpc'

type OperationStateListener = (
  state: OperationState,
  messageSequence: number,
) => void

const operationStateListeners = new Set<OperationStateListener>()
let latestOperationState: OperationState | undefined
let operationStateMessageSequence = 0

const rpc = Electroview.defineRPC<AppRpc>({
  maxRequestTime: 30_000,
  handlers: {
    messages: {
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
