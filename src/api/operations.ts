import { request as rpcRequest } from '@/api/transport'

import type {
  QueueDepotUpdateRequest,
  PreviewApplicationOperationRequest,
  RepairApplicationRequest,
} from '@/types/rpc'

export function getOperationState() {
  return rpcRequest('getOperationState', {})
}

export function queueDepotUpdate(request: QueueDepotUpdateRequest) {
  return rpcRequest('queueDepotUpdate', request)
}

export function previewApplicationOperation(
  request: PreviewApplicationOperationRequest,
) {
  return rpcRequest('previewApplicationOperation', request)
}

export function repairApplication(request: RepairApplicationRequest) {
  return rpcRequest('repairApplication', request)
}

export function cancelOperation() {
  return rpcRequest('cancelOperation', {})
}

export function pauseOperation() {
  return rpcRequest('pauseOperation', {})
}

export function resumeOperation() {
  return rpcRequest('resumeOperation', {})
}
