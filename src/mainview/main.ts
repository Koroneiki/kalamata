import '@/assets/index.css'

import { PiniaColada } from '@pinia/colada'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from '@/App.vue'
import router from '@/router'
import { useColdClientOperationStore } from '@/stores/cold-client-operation'
import { useOperationStore } from '@/stores/operation'
import { useBackgroundDownloadsStore } from '@/stores/background-downloads'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(PiniaColada, {
  queryOptions: {
    staleTime: Infinity,
    gcTime: false,
  },
})
app.use(router)

app.mount('#app')
void useOperationStore(pinia).initialize()
void useBackgroundDownloadsStore(pinia).initialize()
void useColdClientOperationStore(pinia).initialize()
