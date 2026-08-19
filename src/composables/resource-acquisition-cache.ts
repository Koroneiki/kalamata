import type { EntryKey, QueryCache } from '@pinia/colada'

export const resourceAcquisitionQueryKey = ['resource-acquisition'] as const
const depotKeyAcquisitionQueryKey = [
  ...resourceAcquisitionQueryKey,
  'depot-keys',
] as const

export const resourceAcquisitionQueryKeys = {
  depotKey: (appId: number, depotId: number) => [
    ...depotKeyAcquisitionQueryKey,
    appId,
    depotId,
  ],
  manifest: (depotId: number, manifestId: string) => [
    ...resourceAcquisitionQueryKey,
    'manifest',
    depotId,
    manifestId,
  ],
} satisfies Record<string, (...args: never[]) => EntryKey>

export async function runCachedAcquisition<T>(
  queryCache: QueryCache,
  key: EntryKey,
  acquire: () => Promise<T>,
) {
  let fetched = false
  const entry = queryCache.ensure({
    key,
    // Unavailable resources are valid results and should not be retried on remount.
    staleTime: Infinity,
    query: async () => {
      fetched = true
      return acquire()
    },
  })
  const state = await queryCache.refresh(entry)
  if (state.status !== 'success') {
    throw state.status === 'error'
      ? state.error
      : new Error('Resource acquisition was cancelled.')
  }
  return { data: state.data, fetched }
}

export function acquisitionNeedsRequest(queryCache: QueryCache, key: EntryKey) {
  const entry = queryCache.get(key)
  return (
    !entry?.pending &&
    (!entry || entry.stale || entry.state.value.status === 'error')
  )
}

function invalidateAcquisitions(queryCache: QueryCache, key: EntryKey) {
  for (const entry of queryCache.getEntries({ key })) {
    const pending = entry.pending
    if (!pending) {
      queryCache.invalidate(entry)
      continue
    }

    // Acquisition RPCs cannot be aborted, so preserve their coordination entry
    // and make the completed result stale instead of starting a duplicate request.
    void pending.refreshCall
      .catch(() => undefined)
      .then(() => {
        if (entry.pending && entry.pending !== pending) return
        queryCache.invalidate(entry)
      })
  }
}

export function invalidateDepotKeyAcquisitions(queryCache: QueryCache) {
  invalidateAcquisitions(queryCache, depotKeyAcquisitionQueryKey)
}

export function invalidateResourceAcquisitions(queryCache: QueryCache) {
  invalidateAcquisitions(queryCache, resourceAcquisitionQueryKey)
}
