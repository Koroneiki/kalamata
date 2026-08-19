import { expect, test } from 'bun:test'

import {
  requestHubcapApproval,
  useHubcapApproval,
} from '../src/composables/use-hubcap-approval.ts'

test('queues Hubcap approvals without overwriting the active request', async () => {
  const approval = useHubcapApproval()
  const first = requestHubcapApproval({
    dailyUsage: 90,
    dailyLimit: 100,
    remaining: 10,
    canMakeRequests: true,
  })
  const second = requestHubcapApproval({
    dailyUsage: 91,
    dailyLimit: 100,
    remaining: 9,
    canMakeRequests: true,
  })

  expect(approval.current.value?.usage.remaining).toBe(10)
  approval.decide(false)
  expect(await first).toBe(false)
  expect(approval.current.value?.usage.remaining).toBe(9)
  approval.decide(true)
  expect(await second).toBe(true)
  expect(approval.current.value).toBeNull()
})
