import { request } from '@/api/transport'

export function selectInstallDirectory(startingPath?: string) {
  return request('selectInstallDirectory', { startingPath })
}
