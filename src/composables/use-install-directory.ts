import { useMutation, useQuery, useQueryCache } from '@pinia/colada'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import {
  getInstallDirectory,
  selectInstallDirectory,
} from '@/api/install-directory'

const directoryQueryKey = ['install-directory'] as const

export function useInstallDirectory(
  appId: MaybeRefOrGetter<number>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  const cache = useQueryCache()
  const directory = useQuery(() => ({
    key: [...directoryQueryKey, toValue(appId)],
    query: () => getInstallDirectory(toValue(appId)),
    enabled: toValue(enabled),
    // Reopening must notice a removed base folder or a choice made for another game.
    staleTime: 0,
  }))
  const select = useMutation({
    mutation: selectInstallDirectory,
    async onSuccess(path, id) {
      if (!path) return
      await cache.invalidateQueries({ key: directoryQueryKey })
      cache.setQueryData([...directoryQueryKey, id], path)
    },
  })
  // A cached path is not a confirmed usable choice while it is being rechecked.
  const path = computed(() =>
    directory.asyncStatus.value === 'idle' &&
    !directory.error.value &&
    !select.isLoading.value
      ? directory.data.value
      : null,
  )
  return { directory, select, path }
}
