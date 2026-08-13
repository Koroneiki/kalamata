import '@/assets/index.css'

import { PiniaColada } from '@pinia/colada'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from '@/App.vue'
import router from '@/router'
import { useOperationStore } from '@/stores/operation'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(PiniaColada)
app.use(router)

app.mount('#app')
void useOperationStore(pinia).initialize()
