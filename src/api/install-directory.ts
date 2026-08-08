import { electroview } from '@/api/transport'

export function selectInstallDirectory(startingPath?: string) {
  return electroview.rpc!.request.selectInstallDirectory({ startingPath })
}
