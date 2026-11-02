import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * CSP as a <meta> tag so dev and prod match: only our own bundle runs, and data only goes to our API and Firebase.
 * frame-ancestors is a header in firebase.json; /preview.html has its own policy.
 */
function cspPlugin(env: Record<string, string>, dev: boolean): Plugin {
  const api = env.VITE_API_BASE_URL ? new URL(env.VITE_API_BASE_URL).origin : ''
  const emulators = env.VITE_USE_EMULATORS === 'true' ? 'http://127.0.0.1:9099 http://127.0.0.1:8080' : ''
  const firebase = 'https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com'
  const authDomain = `https://${env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID || 'demo-genesis'}.firebaseapp.com`}`
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self' blob:", // Monaco language workers
    "style-src 'self' 'unsafe-inline'", // Vue/Monaco/reka set inline styles; CSS can't run script
    "font-src 'self' data:",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${api} ${firebase} ${emulators} ${dev ? 'ws://localhost:* ws://127.0.0.1:*' : ''}`,
    `frame-src 'self' ${authDomain}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .join('; ')
  return {
    name: 'genesis-csp',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd())
  const projectId = env.VITE_FIREBASE_PROJECT_ID || 'demo-genesis'
  return {
    plugins: [vue(), tailwindcss(), cspPlugin(env, command === 'serve')],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      // Mirrors the Hosting rewrite (/api/** -> api function) so cookie-authenticated routes are same-origin in dev.
      proxy: {
        '/api': { target: 'http://127.0.0.1:5001', rewrite: (path) => `/${projectId}/us-central1/api${path}` },
      },
    },
  }
})
