<script setup lang="ts">
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Toaster } from '@/components/ui/sonner'
import { useAuth } from '@/composables/useAuth'
import 'vue-sonner/style.css'

const { user, ready } = useAuth()
const route = useRoute()
const router = useRouter()

// Signed out anywhere (another tab, expired session): leave protected pages.
watch(user, (signedInUser) => {
  if (ready.value && !signedInUser && route.meta.requiresAuth) {
    void router.replace({ path: '/login', query: { redirect: route.fullPath } })
  }
})
</script>

<template>
  <RouterView />
  <Toaster rich-colors position="bottom-right" />
</template>
