import { request } from '@/api/transport'
import type { AppSettings } from '@/types/rpc'

export function getSettings() {
  return request('getSettings', {})
}

export function updateSettings(settings: AppSettings) {
  return request('updateSettings', settings)
}

export function getHubcapUsage() {
  return request('getHubcapUsage', {})
}

export function openUserDataFolder() {
  return request('openUserDataFolder', {})
}
