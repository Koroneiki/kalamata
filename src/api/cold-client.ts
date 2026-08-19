import { request } from '@/api/transport'
import type { ColdClientDependencyId } from '@/types/cold-client'

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
