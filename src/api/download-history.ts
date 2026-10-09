import { request, subscribeToDownloadHistory } from './transport'
import type { DownloadHistoryEntry } from '@/types/download-history'

export async function getDownloadHistory() {
  let latest: DownloadHistoryEntry[] | undefined
  const unsubscribe = subscribeToDownloadHistory((entries) => {
    latest = entries
  })
  try {
    const entries = await request('getDownloadHistory', {})
    // A finishing download or Clear all can push newer history during this request.
    return latest ?? entries
  } finally {
    unsubscribe()
  }
}

export const clearDownloadHistory = () => request('clearDownloadHistory', {})
export const dismissDownloadHistory = (id: string) =>
  request('dismissDownloadHistory', { id })
