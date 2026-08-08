import { electroview } from '@/api/transport'

export function getLibrary() {
  return electroview.rpc!.request.getLibrary({})
}
