import { onAuthStateChanged, type User } from 'firebase/auth'
import { ref } from 'vue'
import { auth } from '@/lib/firebase'

const user = ref<User | null>(null)
const ready = ref(false)
let readyPromise: Promise<void> | null = null

/** Resolves once Firebase has restored (or ruled out) the persisted session. */
export function authReady(): Promise<void> {
  readyPromise ??= new Promise((resolve) => {
    onAuthStateChanged(auth, (firebaseUser) => {
      user.value = firebaseUser
      ready.value = true
      resolve()
    })
  })
  return readyPromise
}

export function useAuth() {
  void authReady()
  return { user, ready }
}
