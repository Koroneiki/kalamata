import { request as rpcRequest } from '@/api/transport'

import type {
  QueueDepotUpdateRequest,
  PreviewApplicationOperationRequest,
  RepairApplicationRequest,
} from '@/types/rpc'

export function getDownloadQueue() {
  return rpcRequest('getDownloadQueue', {})
}

export function removeQueuedOperation(id: string) {
  return rpcRequest('removeQueuedOperation', { id })
}

export function prioritizeQueuedOperation(id: string) {
  return rpcRequest('prioritizeQueuedOperation', { id })
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
