import { storeToRefs } from 'pinia'
import { watch } from 'vue'
import { toast } from 'vue-sonner'

import ManifestQueueToast from '@/components/shared/ManifestQueueToast.vue'
import { useManifestQueueStore } from '@/stores/manifest-queue'

const TOASTER_ID = 'manifest-queue'

export function useManifestQueueToasts() {
  const manifestQueue = useManifestQueueStore()
  const { state } = storeToRefs(manifestQueue)
  let toastId: string | number | undefined

  watch(
    state,
    (queue) => {
      if (!queue) {
        if (toastId !== undefined) toast.dismiss(toastId)
        toastId = undefined
        return
      }

      const nextToastId = `manifest-queue-${queue.id}`
      // Vue may coalesce the previous queue's null state with this new queue.
      if (toastId !== undefined && toastId !== nextToastId)
        toast.dismiss(toastId)
      toastId = toast.custom(ManifestQueueToast, {
        id: nextToastId,
        toasterId: TOASTER_ID,
        componentProps: {
          completed: queue.completed,
          total: queue.total,
        },
        duration: Infinity,
        dismissible: false,
        closeButton: false,
        class:
          'manifest-queue-toast !h-16 !w-88 !max-w-[calc(100vw-2rem)] !border-border !bg-card !p-0 !text-card-foreground',
      })
    },
    { immediate: true },
  )

  return { active: state }
}
