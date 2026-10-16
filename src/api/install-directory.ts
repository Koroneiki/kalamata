import { request } from '@/api/transport'

export function getInstallDirectory(appId: number) {
  return request('getInstallDirectory', { appId })
}

export function selectInstallDirectory(appId: number) {
  return request('selectInstallDirectory', { appId })
}
