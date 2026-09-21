import { storeToRefs } from 'pinia'
import { watch } from 'vue'

import { appToast } from '@/lib/toast'
import { useManifestQueueStore } from '@/stores/manifest-queue'

export function useManifestQueueToasts() {
  const manifestQueue = useManifestQueueStore()
  const { state } = storeToRefs(manifestQueue)
  let toastId: string | number | undefined

  watch(
    state,
    (queue) => {
      if (!queue) {
        if (toastId !== undefined) appToast.dismiss(toastId)
        toastId = undefined
        return
      }

      const nextToastId = `manifest-queue-${queue.id}`
      // Vue may coalesce the previous queue's null state with this new queue.
      if (toastId !== undefined && toastId !== nextToastId)
        appToast.dismiss(toastId)
      toastId = appToast.manifestQueue(
        queue.completed,
        queue.total,
        nextToastId,
      )
    },
    { immediate: true },
  )

  return { active: state }
}
