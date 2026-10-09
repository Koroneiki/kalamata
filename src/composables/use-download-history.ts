import { useMutation, useQuery, useQueryCache } from '@pinia/colada'
import { onScopeDispose } from 'vue'
import {
  clearDownloadHistory,
  dismissDownloadHistory,
  getDownloadHistory,
} from '@/api/download-history'
import { subscribeToDownloadHistory } from '@/api/transport'

const historyQueryKey = ['download-history'] as const

export function useDownloadHistory() {
  const cache = useQueryCache()
  // History can change while this route is unmounted and its subscription is off.
  const history = useQuery({
    key: historyQueryKey,
    query: getDownloadHistory,
    staleTime: 0,
  })
  const unsubscribe = subscribeToDownloadHistory((entries) =>
    cache.setQueryData(historyQueryKey, entries),
  )
  onScopeDispose(unsubscribe)
  const clear = useMutation({ mutation: clearDownloadHistory })
  const dismiss = useMutation({ mutation: dismissDownloadHistory })
  return { history, clear, dismiss }
}
