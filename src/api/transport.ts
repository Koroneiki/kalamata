import { Electroview } from 'electrobun/view'

import type { AppRpc, OperationState } from '@/types/rpc'
import { operationStateSchema, rpcResponseSchemas } from '@/types/rpc-schemas'

type Requests = AppRpc['bun']['requests']

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
        const result = operationStateSchema.safeParse(state)
        if (!result.success) return
        latestOperationState = result.data
        operationStateMessageSequence += 1
        for (const listener of operationStateListeners)
          listener(result.data, operationStateMessageSequence)
      },
    },
  },
})

const electroview = new Electroview({ rpc })

export async function request<K extends keyof Requests>(
  method: K,
  params: Requests[K]['params'],
): Promise<Requests[K]['response']> {
  const rawRequest = electroview.rpc!.request as unknown as (
    method: keyof Requests,
    params: unknown,
  ) => Promise<unknown>
  const response = await rawRequest(method, params)
  return rpcResponseSchemas[method].parse(response) as Requests[K]['response']
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
