import { useEffect, useRef, useState } from 'react'
import styles from './ProcessingView.module.css'
import { processFrames } from '../../lib/stitcher'

interface ProcessingViewProps {
  frames: Blob[]
  onComplete: (result: Blob) => void
  onError: (error: string) => void
}

export function ProcessingView({ frames, onComplete, onError }: ProcessingViewProps) {
  const [step, setStep] = useState('Preparing...')
  const [percent, setPercent] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Guard against double-invocation in StrictMode / re-renders
  const hasStarted = useRef(false)

  useEffect(() => {
    if (hasStarted.current) return
    hasStarted.current = true

    processFrames(frames, (s, p) => {
      setStep(s)
      setPercent(p)
    })
      .then((blob) => {
        onComplete(blob)
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setErrorMsg(msg)
      })
  }, [frames, onComplete, onError])

  if (errorMsg !== null) {
    return (
      <div className={styles.container}>
        <div className={styles.errorCard}>
          <span className={styles.errorIcon} aria-hidden="true">⚠️</span>
          <h2 className={styles.errorTitle}>Processing Failed</h2>
          <p className={styles.errorMessage}>{errorMsg}</p>
          <button
            className={styles.retryButton}
            onClick={() => onError(errorMsg)}
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.spinner} aria-hidden="true" />

        <h2 className={styles.title}>Unwrapping Label…</h2>

        <p className={styles.stepLabel} aria-live="polite">
          {step}
        </p>

        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Processing progress"
        >
          <div
            className={styles.progressFill}
            style={{ width: `${percent}%` }}
          />
        </div>

        <p className={styles.frameCount}>
          {frames.length} frame{frames.length !== 1 ? 's' : ''} to process
        </p>
      </div>
    </div>
  )
}
