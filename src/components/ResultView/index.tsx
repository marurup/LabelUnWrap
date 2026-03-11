import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './ResultView.module.css'

interface ResultViewProps {
  resultBlob: Blob
  onReset: () => void
}

interface ToastState {
  message: string
  visible: boolean
}

interface Transform {
  scale: number
  x: number
  y: number
}

const MIN_SCALE = 1
const MAX_SCALE = 5
const DOUBLE_TAP_DELAY = 300 // ms

export function ResultView({ resultBlob, onReset }: ResultViewProps) {
  const [objectUrl, setObjectUrl] = useState<string>('')
  const [toast, setToast] = useState<ToastState>({ message: '', visible: false })
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null)
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 })

  // Refs for pan/zoom gesture tracking
  const containerRef = useRef<HTMLDivElement>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const lastPinchDist = useRef<number | null>(null)
  const dragStart = useRef<{ px: number; py: number; tx: number; ty: number } | null>(null)
  const lastTapTime = useRef<number>(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Create and revoke object URL
  useEffect(() => {
    const url = URL.createObjectURL(resultBlob)
    setObjectUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [resultBlob])

  // Show a toast for 2 seconds
  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ message, visible: true })
    toastTimer.current = setTimeout(() => {
      setToast({ message: '', visible: false })
    }, 2000)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  // --- Actions ---

  const handleSave = useCallback(() => {
    if (!objectUrl) return
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = 'label-unwrapped.jpg'
    a.click()
    showToast('Saved!')
  }, [objectUrl, showToast])

  const handleShare = useCallback(async () => {
    try {
      const file = new File([resultBlob], 'label.jpg', { type: 'image/jpeg' })
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] })
        showToast('Shared!')
      } else {
        // Fall back to clipboard
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/jpeg': resultBlob }),
        ])
        showToast('Copied to clipboard!')
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        showToast('Share failed')
      }
    }
  }, [resultBlob, showToast])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/jpeg': resultBlob }),
      ])
      showToast('Copied!')
    } catch {
      showToast('Copy failed')
    }
  }, [resultBlob, showToast])

  const handleNew = useCallback(() => {
    onReset()
  }, [onReset])

  // --- Image load ---

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setDimensions({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  // --- Pan & Zoom helpers ---

  const clampTransform = useCallback((t: Transform): Transform => {
    return { ...t, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale)) }
  }, [])

  const resetView = useCallback(() => {
    setTransform({ scale: 1, x: 0, y: 0 })
  }, [])

  const getPinchDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  // --- Pointer events ---

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.current.size === 1) {
      // Single pointer — start drag, also check double-tap
      const now = Date.now()
      const gap = now - lastTapTime.current
      if (gap < DOUBLE_TAP_DELAY) {
        resetView()
      }
      lastTapTime.current = now

      setTransform(prev => {
        dragStart.current = { px: e.clientX, py: e.clientY, tx: prev.x, ty: prev.y }
        return prev
      })
      lastPinchDist.current = null
    } else if (pointers.current.size === 2) {
      // Two pointers — start pinch
      dragStart.current = null
      const pts = Array.from(pointers.current.values())
      lastPinchDist.current = getPinchDistance(pts[0], pts[1])
    }
  }, [resetView])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.current.size === 1 && dragStart.current) {
      const dx = e.clientX - dragStart.current.px
      const dy = e.clientY - dragStart.current.py
      setTransform(prev => clampTransform({
        scale: prev.scale,
        x: dragStart.current!.tx + dx,
        y: dragStart.current!.ty + dy,
      }))
    } else if (pointers.current.size === 2) {
      const pts = Array.from(pointers.current.values())
      const dist = getPinchDistance(pts[0], pts[1])
      if (lastPinchDist.current !== null) {
        const ratio = dist / lastPinchDist.current
        setTransform(prev => clampTransform({
          scale: prev.scale * ratio,
          x: prev.x,
          y: prev.y,
        }))
      }
      lastPinchDist.current = dist
    }
  }, [clampTransform])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) {
      lastPinchDist.current = null
    }
    if (pointers.current.size === 0) {
      dragStart.current = null
    }
  }, [])

  // Wheel zoom (desktop)
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setTransform(prev => clampTransform({ ...prev, scale: prev.scale * delta }))
  }, [clampTransform])

  return (
    <div className={styles.container}>
      {/* Info bar */}
      {dimensions && (
        <div className={styles.infoBar} aria-label="Image dimensions">
          {dimensions.w} &times; {dimensions.h} px
        </div>
      )}

      {/* Pan/zoom viewport */}
      <div
        ref={containerRef}
        className={styles.viewport}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ touchAction: 'none' }}
      >
        {objectUrl && (
          <img
            src={objectUrl}
            alt="Unwrapped label"
            className={styles.image}
            style={{
              transform: `scale(${transform.scale}) translate(${transform.x / transform.scale}px, ${transform.y / transform.scale}px)`,
            }}
            onLoad={handleImageLoad}
            draggable={false}
          />
        )}
      </div>

      {/* Action bar */}
      <div className={styles.actionBar} role="toolbar" aria-label="Result actions">
        <button className={styles.actionBtn} onClick={handleSave} aria-label="Save image">
          <span className={styles.actionIcon}>&#8595;</span>
          <span className={styles.actionLabel}>Save</span>
        </button>
        <button className={styles.actionBtn} onClick={handleShare} aria-label="Share image">
          <span className={styles.actionIcon}>&#8599;</span>
          <span className={styles.actionLabel}>Share</span>
        </button>
        <button className={styles.actionBtn} onClick={handleCopy} aria-label="Copy image">
          <span className={styles.actionIcon}>&#10697;</span>
          <span className={styles.actionLabel}>Copy</span>
        </button>
        <button className={styles.actionBtn} onClick={handleNew} aria-label="Capture new">
          <span className={styles.actionIcon}>&#8617;</span>
          <span className={styles.actionLabel}>New</span>
        </button>
      </div>

      {/* Toast */}
      {toast.message && (
        <div
          className={`${styles.toast} ${toast.visible ? styles.toastVisible : ''}`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
