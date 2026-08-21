import { request } from '@/api/transport'
import type {
  ColdClientDependencyId,
  ColdClientSetupMode,
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

export function inspectColdClientSetup(
  appId: number,
  mode: ColdClientSetupMode,
) {
  return request('inspectColdClientSetup', { appId, mode })
}

export function getColdClientStatus(appId: number) {
  return request('getColdClientStatus', { appId })
}

export function configureColdClient(setup: ColdClientSetupRequest) {
  return request('configureColdClient', setup)
}

export function regenerateColdClientConfiguration(
  setup: ColdClientSetupRequest,
) {
  return request('regenerateColdClientConfiguration', setup)
}

export function updateColdClientCore(appId: number) {
  return request('updateColdClientCore', { appId })
}

export function removeColdClient(appId: number) {
  return request('removeColdClient', { appId })
}

export function getColdClientOperation() {
  return request('getColdClientOperation', {})
}

export function cancelColdClientOperation(appId: number) {
  return request('cancelColdClientOperation', { appId })
}
