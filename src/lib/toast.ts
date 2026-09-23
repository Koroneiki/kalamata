import { markRaw } from 'vue'
import type { ExternalToast } from 'vue-sonner'
import { toast } from 'vue-sonner'

import AppToast from '@/components/shared/AppToast.vue'
import GameCompletionToast from '@/components/shared/GameCompletionToast.vue'
import { cn } from '@/lib/utils'

const APP_TOAST_CLASS =
  'app-toast !w-88 !max-w-[calc(100vw-2rem)] !border-border !bg-card !text-card-foreground'
const RawAppToast = markRaw(AppToast)
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
