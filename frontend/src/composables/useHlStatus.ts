import { doc, onSnapshot } from 'firebase/firestore'
import { computed, effectScope, ref, watch } from 'vue'
import { db } from '@/lib/firebase'
import type { HlStatus } from '@/types'
import { useAuth } from './useAuth'

const hl = ref<HlStatus>({})
const loaded = ref(false)
let unsubscribe: (() => void) | null = null
let started = false

/** Live HighLevel connection status from users/{uid} (written only by the backend). */
export function useHlStatus() {
  const { user } = useAuth()
  if (!started) {
    started = true
    // Detached scope: tied to the app, not to the first component that asked, so it survives
    // that view unmounting and follows sign-out / sign-in as a different user.
    effectScope(true).run(() =>
      watch(
        user,
        (signedInUser) => {
          unsubscribe?.()
          loaded.value = false
          hl.value = {}
          if (!signedInUser) return
          unsubscribe = onSnapshot(
            doc(db, 'users', signedInUser.uid),
            (snap) => {
              hl.value = (snap.get('hl') as HlStatus) ?? {}
              loaded.value = true
            },
            () => (loaded.value = true),
          )
        },
        { immediate: true },
      ),
    )
  }
  const connected = computed(() => hl.value.status === 'connected')
  return { hl, connected, loaded }
}
