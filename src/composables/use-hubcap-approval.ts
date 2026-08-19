import { readonly, shallowRef } from 'vue'

import type { HubcapUsage } from '../types/rpc.ts'

interface ApprovalRequest {
  usage: HubcapUsage
  resolve: (approved: boolean) => void
}

const current = shallowRef<ApprovalRequest | null>(null)
const queue: ApprovalRequest[] = []

function advance() {
  current.value = queue.shift() ?? null
}

export function requestHubcapApproval(usage: HubcapUsage): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ usage, resolve })
    if (!current.value) advance()
  })
}

export function useHubcapApproval() {
  function decide(approved: boolean) {
    const request = current.value
    if (!request) return
    current.value = null
    request.resolve(approved)
    advance()
  }

  return { current: readonly(current), decide }
}
