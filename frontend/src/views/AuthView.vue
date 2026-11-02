<script setup lang="ts">
import { FirebaseError } from 'firebase/app'
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth'
import { Loader2Icon, SparklesIcon } from '@lucide/vue'
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, endSession, errorMessage, startSession } from '@/lib/api'
import { auth } from '@/lib/firebase'

const router = useRouter()
const route = useRoute()
const mode = ref<'signin' | 'signup'>('signin')
const email = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

const MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/weak-password': 'Use at least 6 characters for your password.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network error. Check your connection.',
}

async function submit() {
  error.value = null
  submitting.value = true
  try {
    if (mode.value === 'signup') await createUserWithEmailAndPassword(auth, email.value.trim(), password.value)
    else await signInWithEmailAndPassword(auth, email.value.trim(), password.value)
    await startSession()
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/dashboard'
    await router.replace(redirect)
  } catch (err) {
    if (err instanceof ApiError) await endSession() // signed in but no CRM session: don't leave a half-signed-in state
    error.value = err instanceof FirebaseError ? (MESSAGES[err.code] ?? err.message) : errorMessage(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="min-h-screen grid place-items-center bg-muted/40 px-4">
    <div class="w-full max-w-sm space-y-6">
      <div class="flex items-center justify-center gap-2 text-lg font-semibold">
        <SparklesIcon class="size-5 text-primary" />
        Genesis
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{{ mode === 'signin' ? 'Welcome back' : 'Create your account' }}</CardTitle>
          <CardDescription>Build HighLevel marketplace apps by describing them.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <Tabs v-model="mode">
            <TabsList class="w-full">
              <TabsTrigger value="signin" class="flex-1">Sign in</TabsTrigger>
              <TabsTrigger value="signup" class="flex-1">Sign up</TabsTrigger>
            </TabsList>
          </Tabs>
          <form class="space-y-3" @submit.prevent="submit">
            <div class="space-y-1.5">
              <Label for="email">Email</Label>
              <Input id="email" v-model="email" type="email" autocomplete="email" required />
            </div>
            <div class="space-y-1.5">
              <Label for="password">Password</Label>
              <Input
                id="password"
                v-model="password"
                type="password"
                :autocomplete="mode === 'signin' ? 'current-password' : 'new-password'"
                minlength="6"
                required
              />
            </div>
            <Alert v-if="error" variant="destructive">
              <AlertDescription>{{ error }}</AlertDescription>
            </Alert>
            <Button type="submit" class="w-full" :disabled="submitting">
              <Loader2Icon v-if="submitting" class="animate-spin" />
              {{ mode === 'signin' ? 'Sign in' : 'Create account' }}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  </main>
</template>
