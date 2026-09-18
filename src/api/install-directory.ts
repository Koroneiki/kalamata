import { request } from '@/api/transport'

const LAST_INSTALL_DIRECTORY_KEY = 'last_install_directory'

export async function selectInstallDirectory(startingPath?: string) {
  const selected = await request('selectInstallDirectory', {
    startingPath:
      startingPath ??
      globalThis.localStorage?.getItem(LAST_INSTALL_DIRECTORY_KEY) ??
      undefined,
  })
  if (selected) {
    globalThis.localStorage?.setItem(LAST_INSTALL_DIRECTORY_KEY, selected)
  }
  return selected
}
