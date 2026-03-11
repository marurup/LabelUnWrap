import { useEffect, useRef, useState } from 'react'
import styles from './InstallPrompt.module.css'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const SESSION_KEY = 'install-prompt-dismissed'

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function InstallPrompt() {
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [iosVisible, setIosVisible] = useState(false)

  useEffect(() => {
    // Don't show if already dismissed this session
    if (sessionStorage.getItem(SESSION_KEY)) return

    if (isIOS()) {
      // On iOS, show static tip if the app is not already in standalone mode
      const isStandalone =
        (navigator as Navigator & { standalone?: boolean }).standalone === true
      if (!isStandalone) {
        setIosVisible(true)
      }
      return
    }

    const handler = (e: Event) => {
      e.preventDefault()
      deferredPrompt.current = e as BeforeInstallPromptEvent
      setVisible(true)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = async () => {
    if (!deferredPrompt.current) return
    await deferredPrompt.current.prompt()
    await deferredPrompt.current.userChoice
    deferredPrompt.current = null
    setVisible(false)
  }

  const handleDismiss = () => {
    sessionStorage.setItem(SESSION_KEY, '1')
    setVisible(false)
    setIosVisible(false)
  }

  if (iosVisible) {
    return (
      <div className={styles.banner} role="banner" aria-live="polite">
        <span className={styles.message}>
          Tap <strong>Share</strong> → <strong>Add to Home Screen</strong> to install LabelUnWrap
        </span>
        <button
          className={styles.dismiss}
          onClick={handleDismiss}
          aria-label="Dismiss install tip"
        >
          ✕
        </button>
      </div>
    )
  }

  if (!visible) return null

  return (
    <div className={styles.banner} role="banner" aria-live="polite">
      <span className={styles.message}>Add LabelUnWrap to your home screen</span>
      <button className={styles.installBtn} onClick={handleInstall}>
        Install
      </button>
      <button
        className={styles.dismiss}
        onClick={handleDismiss}
        aria-label="Dismiss install prompt"
      >
        ✕
      </button>
    </div>
  )
}
