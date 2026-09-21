import { markRaw } from 'vue'
import type { ExternalToast } from 'vue-sonner'
import { toast } from 'vue-sonner'

import AppToast from '@/components/shared/AppToast.vue'
import GameCompletionToast from '@/components/shared/GameCompletionToast.vue'
import ManifestQueueToast from '@/components/shared/ManifestQueueToast.vue'
import { cn } from '@/lib/utils'

export const MANIFEST_QUEUE_TOASTER_ID = 'manifest-queue'

const APP_TOAST_CLASS =
  'app-toast !w-88 !max-w-[calc(100vw-2rem)] !border-border !bg-card !text-card-foreground'
const RawAppToast = markRaw(AppToast)
const RawManifestQueueToast = markRaw(ManifestQueueToast)
const RawGameCompletionToast = markRaw(GameCompletionToast)

type AppToastOptions = Omit<ExternalToast, 'componentProps' | 'description'> & {
  description?: string
}

function optionsWithAppStyle(options?: ExternalToast): ExternalToast {
  return {
    ...options,
    class: cn(APP_TOAST_CLASS, options?.class),
  }
}

export const appToast = {
  success(message: string, options?: AppToastOptions) {
    return statusToast('success', message, options)
  },
  warning(message: string, options?: AppToastOptions) {
    return statusToast('warning', message, options)
  },
  error(message: string, options?: AppToastOptions) {
    return statusToast('error', message, options)
  },
  dismiss(id?: string | number) {
    return toast.dismiss(id)
  },
  manifestQueue(completed: number, total: number, id: string) {
    return toast.custom(
      RawManifestQueueToast,
      optionsWithAppStyle({
        id,
        toasterId: MANIFEST_QUEUE_TOASTER_ID,
        componentProps: { completed, total },
        duration: Infinity,
        dismissible: false,
        closeButton: false,
        class: '!h-16 !p-0',
      }),
    )
  },
  gameCompletion(name: string, iconUrl: string | null, message: string) {
    return toast.custom(
      RawGameCompletionToast,
      optionsWithAppStyle({
        componentProps: { name, iconUrl, message },
        duration: 6_000,
        class: '!p-0',
      }),
    )
  },
}

function statusToast(
  variant: 'success' | 'warning' | 'error' | 'info',
  message: string,
  options?: AppToastOptions,
) {
  const { description, ...toastOptions } = options ?? {}
  return toast.custom(
    RawAppToast,
    optionsWithAppStyle({
      ...toastOptions,
      componentProps: { variant, message, description },
      closeButton: false,
      class: cn('!p-0', toastOptions.class),
    }),
  )
}
