import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'

const env = import.meta.env
export const USE_EMULATORS = env.VITE_USE_EMULATORS === 'true'
const projectId = env.VITE_FIREBASE_PROJECT_ID || 'demo-genesis'

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-api-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
  projectId,
  appId: env.VITE_FIREBASE_APP_ID,
})

// Firebase Auth persists the session in IndexedDB by default, so a refresh keeps you signed in.
export const auth = getAuth(app)
export const db = getFirestore(app)

if (USE_EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
}

export const API_BASE_URL = (env.VITE_API_BASE_URL || (USE_EMULATORS ? `http://127.0.0.1:5001/${projectId}/us-central1/api` : '')).replace(
  /\/$/,
  '',
)
