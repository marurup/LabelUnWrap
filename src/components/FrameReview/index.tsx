import { useState, useEffect, useRef, useCallback } from 'react'
import styles from './FrameReview.module.css'

interface FrameReviewProps {
  frames: Blob[]
  onConfirm: (frames: Blob[]) => void
  onRetake: () => void
}

export function FrameReview({ frames: initialFrames, onConfirm, onRetake }: FrameReviewProps) {
  const [frames, setFrames] = useState<Blob[]>(initialFrames)
  const [selectedIndex, setSelectedIndex] = useState<number>(0)
  // Map from Blob → object URL, cleaned up on unmount / frame removal
  const urlMapRef = useRef<Map<Blob, string>>(new Map())

  // Build object URLs for new blobs
  function getUrl(blob: Blob): string {
    if (!urlMapRef.current.has(blob)) {
      urlMapRef.current.set(blob, URL.createObjectURL(blob))
    }
    return urlMapRef.current.get(blob)!
  }

  // Revoke a single URL
  function revokeUrl(blob: Blob) {
    const url = urlMapRef.current.get(blob)
    if (url) {
      URL.revokeObjectURL(url)
      urlMapRef.current.delete(blob)
    }
  }

  // Clean up all URLs on unmount
  useEffect(() => {
    const map = urlMapRef.current
    return () => {
      map.forEach((url) => URL.revokeObjectURL(url))
      map.clear()
    }
  }, [])

  // Keep selectedIndex in bounds when frames change
  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, frames.length - 1)))
  }, [frames])

  const handleDelete = useCallback(
    (index: number) => {
      const blob = frames[index]
      revokeUrl(blob)
      setFrames((prev) => prev.filter((_, i) => i !== index))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frames],
  )

  // Long-press support: delete on long-press (500 ms)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleThumbnailPointerDown = useCallback(
    (index: number) => {
      longPressTimerRef.current = setTimeout(() => {
        handleDelete(index)
      }, 500)
    },
    [handleDelete],
  )

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const handleThumbnailClick = useCallback((index: number) => {
    cancelLongPress()
    setSelectedIndex(index)
  }, [cancelLongPress])

  const handleConfirm = useCallback(() => {
    if (frames.length >= 2) {
      onConfirm(frames)
    }
  }, [frames, onConfirm])

  const selectedFrame = frames[selectedIndex] ?? null

  return (
    <div className={styles.container}>
      {/* Full-size preview */}
      <div className={styles.preview}>
        {selectedFrame ? (
          <>
            <img
              className={styles.previewImg}
              src={getUrl(selectedFrame)}
              alt={`Frame ${selectedIndex + 1} preview`}
            />
            <div className={styles.previewBadge}>
              {selectedIndex + 1} / {frames.length}
            </div>
          </>
        ) : (
          <p className={styles.previewEmpty}>No frames captured yet.</p>
        )}
      </div>

      {/* Bottom panel */}
      <div className={styles.bottomPanel}>
        {/* Thumbnail strip */}
        <div className={styles.thumbnailStrip} role="list" aria-label="Captured frames">
          {frames.map((blob, index) => (
            <div
              key={getUrl(blob)}
              className={`${styles.thumbnailWrapper}${index === selectedIndex ? ` ${styles.selected}` : ''}`}
              role="listitem"
              tabIndex={0}
              aria-label={`Frame ${index + 1}${index === selectedIndex ? ', selected' : ''}`}
              onClick={() => handleThumbnailClick(index)}
              onPointerDown={() => handleThumbnailPointerDown(index)}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleThumbnailClick(index)
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault()
                  handleDelete(index)
                }
              }}
            >
              <img
                className={styles.thumbnail}
                src={getUrl(blob)}
                alt={`Frame ${index + 1}`}
                draggable={false}
              />
              <button
                className={styles.deleteBtn}
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete(index)
                }}
                aria-label={`Delete frame ${index + 1}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Frame count */}
        <p className={styles.frameCount}>
          {frames.length} {frames.length === 1 ? 'frame' : 'frames'} captured
          {frames.length < 2 && ' — capture at least 2 to process'}
        </p>

        {/* Actions */}
        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onRetake}>
            Retake
          </button>
          <button
            className={styles.btnPrimary}
            onClick={handleConfirm}
            disabled={frames.length < 2}
            aria-disabled={frames.length < 2}
          >
            Process {frames.length >= 2 ? `(${frames.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
