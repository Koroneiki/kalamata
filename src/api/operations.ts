import { electroview } from '@/api/transport'

import type {
  QueueDepotUpdateRequest,
  PreviewApplicationOperationRequest,
  RepairApplicationRequest,
} from '@/types/rpc'

export function getOperationState() {
  return electroview.rpc!.request.getOperationState({})
}

export function queueDepotUpdate(request: QueueDepotUpdateRequest) {
  return electroview.rpc!.request.queueDepotUpdate(request)
}

export function previewApplicationOperation(
  request: PreviewApplicationOperationRequest,
) {
  return electroview.rpc!.request.previewApplicationOperation(request)
}

export function repairApplication(request: RepairApplicationRequest) {
  return electroview.rpc!.request.repairApplication(request)
}

export function cancelOperation() {
  return electroview.rpc!.request.cancelOperation({})
}

export function pauseOperation() {
  return electroview.rpc!.request.pauseOperation({})
}

export function resumeOperation() {
  return electroview.rpc!.request.resumeOperation({})
}
