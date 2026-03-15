import { useEffect, useRef, useState } from 'react'
import styles from './ProcessingView.module.css'
import { ProgressCard } from '../ProgressCard'
import { processFrames } from '../../lib/stitcher'
import { unwrapLabel } from '../../lib/unwrapper'
import type { Point2D } from '../../lib/unwrapper'

export type ProcessingTask =
  | { kind: 'stitch'; frames: Blob[] }
  | { kind: 'unwrap'; photo: Blob; points: [Point2D, Point2D, Point2D, Point2D, Point2D, Point2D] }

interface ProcessingViewProps {
  task: ProcessingTask
  onComplete: (result: Blob) => void
  onError: (error: string) => void
}

export function ProcessingView({ task, onComplete, onError }: ProcessingViewProps) {
  const [step, setStep]       = useState('Preparing…')
  const [percent, setPercent] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const hasStarted = useRef(false)

  useEffect(() => {
    if (hasStarted.current) return
    hasStarted.current = true

    const progress = (s: string, p: number) => { setStep(s); setPercent(p) }

    const run =
      task.kind === 'unwrap'
        ? unwrapLabel(task.photo, task.points, progress)
        : processFrames(task.frames, progress)

    run
      .then((blob) => onComplete(blob))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setErrorMsg(msg)
      })
  }, [task, onComplete, onError])

  const detail =
    task.kind === 'unwrap'
      ? 'Mapping label mesh to flat image'
      : `${task.frames.length} frame${task.frames.length !== 1 ? 's' : ''} to process`

  if (errorMsg !== null) {
    return (
      <div className={styles.container}>
        <div className={styles.errorCard}>
          <span className={styles.errorIcon} aria-hidden="true">⚠️</span>
          <h2 className={styles.errorTitle}>Processing Failed</h2>
          <p className={styles.errorMessage}>{errorMsg}</p>
          <button className={styles.retryButton} onClick={() => onError(errorMsg)}>
            Try Again
          </button>
        </div>
      </div>
    )
  }

  return (
    <ProgressCard
      title="Unwrapping Label…"
      step={step}
      percent={percent}
      detail={detail}
    />
  )
}
