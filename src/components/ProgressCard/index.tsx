import { useEffect, useRef, useState } from 'react'
import styles from './ProgressCard.module.css'

interface ProgressCardProps {
  title: string
  step: string
  percent: number
  detail?: string  // e.g. "8 / 12 frames"
}

/** Format seconds into a human-readable "Xs" or "Xm Ys" string. */
function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

export function ProgressCard({ title, step, percent, detail }: ProgressCardProps) {
  const startRef = useRef<number>(Date.now())
  const [eta, setEta] = useState<string | null>(null)

  useEffect(() => {
    // Reset start time whenever percent goes back to 0 (new operation)
    if (percent === 0) {
      startRef.current = Date.now()
      setEta(null)
      return
    }

    const elapsed = (Date.now() - startRef.current) / 1000
    if (percent >= 100) {
      setEta(null)
      return
    }
    // Only show ETA once we have at least 5% progress and 1 second elapsed
    if (percent >= 5 && elapsed >= 1) {
      const totalEstimated = elapsed / (percent / 100)
      const remaining = Math.max(0, totalEstimated - elapsed)
      setEta(formatTime(remaining))
    }
  }, [percent])

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.spinner} aria-hidden="true" />

        <h2 className={styles.title}>{title}</h2>

        <p className={styles.stepLabel} aria-live="polite">{step}</p>

        <div className={styles.progressWrapper}>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progress"
          >
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
          <div className={styles.progressMeta}>
            <span className={styles.percentLabel}>{Math.round(percent)}%</span>
            {eta !== null && (
              <span className={styles.etaLabel}>~{eta} left</span>
            )}
          </div>
        </div>

        {detail && (
          <p className={styles.detail}>{detail}</p>
        )}
      </div>
    </div>
  )
}
