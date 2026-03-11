import { useEffect, useRef, useState, useCallback } from 'react'
import { useCamera } from '../../hooks/useCamera'
import styles from './CameraCapture.module.css'

interface CameraCaptureProps {
  onCapture: (frames: Blob[]) => void
}

type CaptureMode = 'photo' | 'video'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function CameraCapture({ onCapture }: CameraCaptureProps) {
  const { stream, error, isLoading, startCamera, stopCamera, capturePhoto, videoRef } = useCamera()
  const [mode, setMode] = useState<CaptureMode>('photo')
  const [photos, setPhotos] = useState<Blob[]>([])
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Start camera on mount
  useEffect(() => {
    startCamera()
    return () => {
      stopCamera()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Assign stream to video element whenever it changes
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch(() => {})
    }
  }, [stream, videoRef])

  const handleModeToggle = useCallback(() => {
    if (isRecording) return
    setMode((m) => (m === 'photo' ? 'video' : 'photo'))
    setPhotos([])
  }, [isRecording])

  // ── Photo mode ───────────────────────────────────────────────────────────
  const handleCapture = useCallback(async () => {
    const blob = await capturePhoto()
    if (blob) {
      setPhotos((prev) => [...prev, blob])
    }
  }, [capturePhoto])

  const handleRetakeLast = useCallback(() => {
    setPhotos((prev) => prev.slice(0, -1))
  }, [])

  const handleDone = useCallback(() => {
    if (photos.length >= 2) {
      stopCamera()
      onCapture(photos)
    }
  }, [photos, stopCamera, onCapture])

  // ── Video mode ───────────────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    if (!stream) return

    recordedChunksRef.current = []

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm')
      ? 'video/webm'
      : 'video/mp4'

    const recorder = new MediaRecorder(stream, { mimeType })
    mediaRecorderRef.current = recorder

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data)
    }

    recorder.onstop = () => {
      const videoBlob = new Blob(recordedChunksRef.current, { type: mimeType })
      stopCamera()
      onCapture([videoBlob])
    }

    recorder.start(100)
    setIsRecording(true)
    setRecordingSeconds(0)

    timerRef.current = setInterval(() => {
      setRecordingSeconds((s) => s + 1)
    }, 1000)
  }, [stream, stopCamera, onCapture])

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setIsRecording(false)
    mediaRecorderRef.current?.stop()
  }, [])

  const handleRecordToggle = useCallback(() => {
    if (isRecording) {
      stopRecording()
    } else {
      startRecording()
    }
  }, [isRecording, startRecording, stopRecording])

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.wrapper}>
      {/* Video element — always present so the ref is set */}
      <video
        ref={videoRef}
        className={styles.video}
        autoPlay
        playsInline
        muted
        aria-label="Camera viewfinder"
      />

      {/* Guide overlay (photo mode only) */}
      {mode === 'photo' && stream && (
        <div className={styles.guideOverlay} aria-hidden="true">
          <div className={styles.guideLeft} />
          <div className={styles.guideCenter} />
          <div className={styles.guideRight} />
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className={styles.stateOverlay} role="status">
          <div className={styles.spinner} />
          <p>Starting camera…</p>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className={styles.stateOverlay} role="alert">
          <p>{error}</p>
          <button className={styles.retryBtn} onClick={startCamera}>
            Retry
          </button>
        </div>
      )}

      {/* Controls — only show when camera is active */}
      {stream && !error && (
        <div className={styles.controls}>
          {/* Top bar */}
          <div className={styles.topBar}>
            <button
              className={styles.modeToggle}
              onClick={handleModeToggle}
              aria-label={mode === 'photo' ? 'Switch to video mode' : 'Switch to photo mode'}
              disabled={isRecording}
            >
              {mode === 'photo' ? '🎥' : '📷'}
            </button>

            {mode === 'photo' && (
              <div className={styles.frameCounter} aria-live="polite" aria-atomic="true">
                {photos.length} {photos.length === 1 ? 'photo' : 'photos'}
              </div>
            )}

            {mode === 'video' && isRecording && (
              <div className={styles.duration} aria-live="polite" aria-atomic="true">
                ● {formatDuration(recordingSeconds)}
              </div>
            )}
          </div>

          {/* Bottom bar */}
          <div className={styles.bottomBar}>
            {/* Left side action */}
            {mode === 'photo' ? (
              photos.length > 0 ? (
                <button
                  className={styles.sideBtn}
                  onClick={handleRetakeLast}
                  aria-label="Remove last photo"
                >
                  Undo
                </button>
              ) : (
                <div className={styles.sideBtnPlaceholder} aria-hidden="true" />
              )
            ) : (
              <div className={styles.sideBtnPlaceholder} aria-hidden="true" />
            )}

            {/* Centre — capture / record */}
            {mode === 'photo' ? (
              <button
                className={styles.captureBtn}
                onClick={handleCapture}
                aria-label="Capture photo"
              />
            ) : (
              <button
                className={`${styles.captureBtn}${isRecording ? ` ${styles.recording}` : ''}`}
                onClick={handleRecordToggle}
                aria-label={isRecording ? 'Stop recording' : 'Start recording'}
              />
            )}

            {/* Right side action */}
            {mode === 'photo' && photos.length >= 2 ? (
              <button
                className={`${styles.sideBtn} ${styles.sideBtnAccent}`}
                onClick={handleDone}
                aria-label={`Done — use ${photos.length} photos`}
              >
                Done
              </button>
            ) : (
              <div className={styles.sideBtnPlaceholder} aria-hidden="true" />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
