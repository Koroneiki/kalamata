import { request } from '@/api/transport'

export function getLibrary() {
  return request('getLibrary', {})
}

export function addLibraryEntry(appId: number) {
  return request('addLibraryEntry', { appId })
}

export function removeLibraryEntry(appId: number) {
  return request('removeLibraryEntry', { appId })
}

export function setSelectedDepots(appId: number, depotIds: number[]) {
  return request('setSelectedDepots', { appId, depotIds })
}

export function setDepotPinned(
  appId: number,
  depotId: number,
  pinned: boolean,
) {
  return request('setDepotPinned', { appId, depotId, pinned })
}
