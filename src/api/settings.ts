import { electroview } from '@/api/transport'
import type { AppSettings } from '@/types/rpc'

export function getSettings() {
  return electroview.rpc!.request.getSettings({})
}

export function updateSettings(settings: AppSettings) {
  return electroview.rpc!.request.updateSettings(settings)
}
