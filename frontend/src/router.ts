import { createRouter, createWebHistory } from 'vue-router'
import { auth } from '@/lib/firebase'
import { authReady } from '@/composables/useAuth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/login', component: () => import('@/views/AuthView.vue'), meta: { guestOnly: true } },
    { path: '/dashboard', component: () => import('@/views/DashboardView.vue'), meta: { requiresAuth: true } },
    { path: '/projects/:id', component: () => import('@/views/WorkspaceView.vue'), meta: { requiresAuth: true }, props: true },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
  ],
})

router.beforeEach(async (to) => {
  await authReady()
  const signedIn = !!auth.currentUser
  if (to.meta.requiresAuth && !signedIn) return { path: '/login', query: { redirect: to.fullPath } }
  if (to.meta.guestOnly && signedIn) return { path: '/dashboard' }
})
