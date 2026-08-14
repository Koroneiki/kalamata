import { Electroview } from 'electrobun/view'

import type { AppRpc, OperationState } from '@/types/rpc'
import { operationStateSchema, rpcResponseSchemas } from '@/types/rpc-schemas'

type Requests = AppRpc['bun']['requests']
type AppRequest = <K extends keyof Requests>(
  method: K,
  params: Requests[K]['params'],
) => Promise<Requests[K]['response']>

type OperationStateListener = (
  state: OperationState,
  messageSequence: number,
) => void

const operationStateListeners = new Set<OperationStateListener>()
let latestOperationState: OperationState | undefined
let operationStateMessageSequence = 0

const rpc = Electroview.defineRPC<AppRpc>({
  // Electrobun timeouts only abandon the response; they do not cancel native
  // work such as manifest acquisition, filesystem previews, or durable pauses.
  maxRequestTime: Infinity,
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
  // SAFETY: every Kalamata RPC request declares required `params`; this removes
  // Electrobun's conditional rest tuple while preserving each method's pairing.
  const appRequest = electroview.rpc!.request as AppRequest
  const response = await appRequest(method, params)
  // SAFETY: `method` selects both the RPC response contract and its matching schema.
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
