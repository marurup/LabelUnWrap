import { useState } from 'react'
import { useDevMode } from './hooks/useDevMode'
import styles from './App.module.css'
import { CameraCapture } from './components/CameraCapture'
import { FrameReview } from './components/FrameReview'
import { InstallPrompt } from './components/InstallPrompt'
import { LandingPage } from './components/LandingPage'
import { PointPicker } from './components/PointPicker'
import { ProcessingView } from './components/ProcessingView'
import type { ProcessingTask } from './components/ProcessingView'
import { ProgressCard } from './components/ProgressCard'
import { ResultView } from './components/ResultView'
import { extractFrames } from './lib/frameSelector'
import type { Point2D } from './lib/unwrapper'

export type AppState = 'landing' | 'capture' | 'review' | 'points' | 'processing' | 'result'

const STATE_ORDER: AppState[] = ['capture', 'points', 'processing', 'result']

const VIDEO_FRAME_TARGET = 60

function App() {
  const devMode = useDevMode()
  const [appState, setAppState]       = useState<AppState>('landing')
  const [capturedFrames, setCapturedFrames] = useState<Blob[]>([])
  const [capturedPhoto, setCapturedPhoto]   = useState<Blob | null>(null)
  const [processingTask, setProcessingTask] = useState<ProcessingTask | null>(null)
  const [resultBlob, setResultBlob]         = useState<Blob | null>(null)
  const [isExtracting, setIsExtracting]     = useState(false)
  const [extractionProgress, setExtractionProgress] = useState({ current: 0, total: VIDEO_FRAME_TARGET })

  const handleCapture = async (blobs: Blob[]) => {
    // Single video blob → extract frames (legacy slit-scan path)
    if (blobs.length === 1 && blobs[0].type.startsWith('video/')) {
      setIsExtracting(true)
      setExtractionProgress({ current: 0, total: VIDEO_FRAME_TARGET })
      try {
        const frames = await extractFrames(blobs[0], VIDEO_FRAME_TARGET, (extracted, total) => {
          setExtractionProgress({ current: extracted, total })
        })
        setCapturedFrames(frames)
        setAppState('review')
      } catch (err) {
        console.error('Frame extraction failed:', err)
        setAppState('capture')
      } finally {
        setIsExtracting(false)
      }
      return
    }

    // Single image blob → six-point unwrap path
    if (blobs.length === 1) {
      setCapturedPhoto(blobs[0])
      setAppState('points')
      return
    }

    // Multiple images → legacy multi-photo review
    setCapturedFrames(blobs)
    setAppState('review')
  }

  // Six-point path: user confirmed 6 points
  const handleConfirmPoints = (points: [Point2D, Point2D, Point2D, Point2D, Point2D, Point2D]) => {
    if (!capturedPhoto) return
    setProcessingTask({ kind: 'unwrap', photo: capturedPhoto, points })
    setAppState('processing')
  }

  // Legacy multi-photo path
  const handleConfirm = (frames: Blob[]) => {
    setCapturedFrames(frames)
    setProcessingTask({ kind: 'stitch', frames })
    setAppState('processing')
  }

  const handleRetake = () => {
    setCapturedFrames([])
    setCapturedPhoto(null)
    setProcessingTask(null)
    setAppState('capture')
  }

  const handleProcessingComplete = (blob: Blob) => {
    setResultBlob(blob)
    setAppState('result')
  }

  const handleProcessingError = (_error: string) => {
    setCapturedFrames([])
    setCapturedPhoto(null)
    setProcessingTask(null)
    setAppState('capture')
  }

  const renderView = () => {
    switch (appState) {
      case 'landing':
        return <LandingPage onStart={() => setAppState('capture')} />

      case 'capture':
        return <CameraCapture onCapture={handleCapture} devMode={devMode} />

      case 'points':
        if (!capturedPhoto) return null
        return (
          <PointPicker
            photo={capturedPhoto}
            onConfirm={handleConfirmPoints}
            onRetake={handleRetake}
          />
        )

      case 'review':
        return (
          <FrameReview
            frames={capturedFrames}
            onConfirm={handleConfirm}
            onRetake={handleRetake}
          />
        )

      case 'processing':
        if (!processingTask) return null
        return (
          <ProcessingView
            task={processingTask}
            onComplete={handleProcessingComplete}
            onError={handleProcessingError}
          />
        )

      case 'result':
        if (!resultBlob) return null
        return (
          <ResultView
            resultBlob={resultBlob}
            devMode={devMode}
            onReset={() => {
              setCapturedFrames([])
              setCapturedPhoto(null)
              setProcessingTask(null)
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
          <ProgressCard
            title="Extracting Frames"
            step={`Captured ${extractionProgress.current} of ${extractionProgress.total} frames…`}
            percent={Math.round((extractionProgress.current / extractionProgress.total) * 100)}
            detail="Playing video at high speed to sample frames"
          />
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
