import { request } from '@/api/transport'
import type {
  ColdClientDependencyId,
  ColdClientSetupRequest,
} from '@/types/cold-client'

export function getColdClientDependencies() {
  return request('getColdClientDependencies', {})
}

export function checkColdClientDependencyUpdates() {
  return request('checkColdClientDependencyUpdates', {})
}

export function updateColdClientDependencies(
  dependencyIds: ColdClientDependencyId[],
) {
  return request('updateColdClientDependencies', { dependencyIds })
}

export function openColdClientLoginDirectory() {
  return request('openColdClientLoginDirectory', {})
}

export function inspectColdClientSetup(appId: number) {
  return request('inspectColdClientSetup', { appId })
}

export function getColdClientStatus(appId: number) {
  return request('getColdClientStatus', { appId })
}

export function configureColdClient(setup: ColdClientSetupRequest) {
  return request('configureColdClient', setup)
}

export function regenerateColdClientConfiguration(appId: number) {
  return request('regenerateColdClientConfiguration', { appId })
}

export function getColdClientOperation() {
  return request('getColdClientOperation', {})
}

export function cancelColdClientOperation(appId: number) {
  return request('cancelColdClientOperation', { appId })
}
