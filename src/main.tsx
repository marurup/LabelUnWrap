import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

// Register service worker with auto-update
registerSW({
  onNeedRefresh() {
    // New content available — could show a toast/prompt here in a future phase
    console.info('[PWA] New content available, will update on next reload.')
  },
  onOfflineReady() {
    console.info('[PWA] App is ready for offline use.')
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
