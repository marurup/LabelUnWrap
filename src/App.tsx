import { useState } from 'react'
import styles from './App.module.css'
import { CameraCapture } from './components/CameraCapture'
import { FrameReview } from './components/FrameReview'
import { InstallPrompt } from './components/InstallPrompt'
import { LandingPage } from './components/LandingPage'
import { ProcessingView } from './components/ProcessingView'
import { ResultView } from './components/ResultView'
import { extractFrames } from './lib/frameSelector'

export type AppState = 'landing' | 'capture' | 'review' | 'processing' | 'result'

const STATE_ORDER: AppState[] = ['capture', 'review', 'processing', 'result']

const VIDEO_FRAME_TARGET = 12

function App() {
  const [appState, setAppState] = useState<AppState>('landing')
  const [capturedFrames, setCapturedFrames] = useState<Blob[]>([])
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)

  const handleCapture = async (blobs: Blob[]) => {
    // Single video blob → extract frames on the main thread
    if (blobs.length === 1 && blobs[0].type.startsWith('video/')) {
      setIsExtracting(true)
      try {
        const frames = await extractFrames(blobs[0], VIDEO_FRAME_TARGET)
        setCapturedFrames(frames)
        setAppState('review')
      } catch (err) {
        console.error('Frame extraction failed:', err)
        setAppState('capture')
      } finally {
        setIsExtracting(false)
      }
    } else {
      // Photo blobs — go straight to review
      setCapturedFrames(blobs)
      setAppState('review')
    }
  }

  const handleConfirm = (frames: Blob[]) => {
    setCapturedFrames(frames)
    setAppState('processing')
  }

  const handleRetake = () => {
    setCapturedFrames([])
    setAppState('capture')
  }

  const handleProcessingComplete = (blob: Blob) => {
    setResultBlob(blob)
    setAppState('result')
  }

  const handleProcessingError = (_error: string) => {
    // Return to capture so the user can try again
    setCapturedFrames([])
    setAppState('capture')
  }

  const renderView = () => {
    switch (appState) {
      case 'landing':
        return <LandingPage onStart={() => setAppState('capture')} />
      case 'capture':
        return <CameraCapture onCapture={handleCapture} />
      case 'review':
        return (
          <FrameReview
            frames={capturedFrames}
            onConfirm={handleConfirm}
            onRetake={handleRetake}
          />
        )
      case 'processing':
        return (
          <ProcessingView
            frames={capturedFrames}
            onComplete={handleProcessingComplete}
            onError={handleProcessingError}
          />
        )
      case 'result':
        if (!resultBlob) return null
        return (
          <ResultView
            resultBlob={resultBlob}
            onReset={() => {
              setCapturedFrames([])
              setResultBlob(null)
              setAppState('landing')
            }}
          />
        )
    }
  }

  return (
    <div className={styles.app}>
      <InstallPrompt />
      <header className={styles.header}>
        <h1 className={styles.logo}>
          Label<span>Un</span>Wrap
        </h1>
      </header>

      <main className={styles.main}>
        {isExtracting ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 16,
              color: 'var(--color-text-muted)',
            }}
            role="status"
          >
            <div
              style={{
                width: 40,
                height: 40,
                border: '3px solid rgba(255,255,255,0.15)',
                borderTopColor: 'var(--color-accent)',
                borderRadius: '50%',
                animation: 'spin 0.7s linear infinite',
              }}
            />
            <p>Extracting frames…</p>
          </div>
        ) : (
          renderView()
        )}
      </main>

      {appState !== 'landing' && (
        <footer className={styles.footer}>
          <div className={styles.stateIndicator} role="status" aria-label={`Current step: ${appState}`}>
            {STATE_ORDER.map((state) => (
              <div
                key={state}
                className={`${styles.stateDot} ${state === appState ? styles.stateDotActive : ''}`}
                aria-hidden="true"
              />
            ))}
          </div>
        </footer>
      )}
    </div>
  )
}

export default App
