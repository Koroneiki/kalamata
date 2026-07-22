import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
    },
    {
      path: '/app/:appId',
      name: 'app-details',
      component: () => import('@/views/AppDetailsView.vue'),
    },
  ],
})

export default router
