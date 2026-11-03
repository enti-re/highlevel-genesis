import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './style.css'

// Monaco rejects in-flight work with a "Canceled" error when an editor is disposed; it's expected noise.
window.addEventListener('unhandledrejection', (event) => {
  if ((event.reason as Error | undefined)?.name === 'Canceled') event.preventDefault()
})

createApp(App).use(router).mount('#app')
