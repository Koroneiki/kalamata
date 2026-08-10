import { electroview } from '@/api/transport'

export function getLibrary() {
  return electroview.rpc!.request.getLibrary({})
}

export function addLibraryEntry(appId: number) {
  return electroview.rpc!.request.addLibraryEntry({ appId })
}

export function removeLibraryEntry(appId: number) {
  return electroview.rpc!.request.removeLibraryEntry({ appId })
}

export function setSelectedDepots(appId: number, depotIds: number[]) {
  return electroview.rpc!.request.setSelectedDepots({ appId, depotIds })
}
