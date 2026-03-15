import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './ResultView.module.css'
import { getLastDebugInfo } from '../../lib/stitcher'
import type { StitchDebugInfo } from '../../workers/stitcher.worker'
import { getLastAutoUnwrapDebugInfo, getLastFlatFrameBlobs } from '../../lib/autoUnwrapper'
import type { AutoUnwrapDebugInfo } from '../../workers/autoUnwrap.worker'

interface ResultViewProps {
  resultBlob: Blob
  onReset: () => void
  devMode?: boolean
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

export function ResultView({ resultBlob, onReset, devMode = false }: ResultViewProps) {
  const [objectUrl, setObjectUrl] = useState<string>('')
  const [toast, setToast] = useState<ToastState>({ message: '', visible: false })
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null)
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 })
  const [debugInfo] = useState<StitchDebugInfo | null>(() => devMode ? getLastDebugInfo() : null)
  const [autoDebugInfo] = useState<AutoUnwrapDebugInfo | null>(() => devMode ? getLastAutoUnwrapDebugInfo() : null)
  const [flatFrameUrls, setFlatFrameUrls] = useState<string[]>([])
  const [showDebug, setShowDebug] = useState(false)
  const debugCanvasRef = useRef<HTMLCanvasElement>(null)

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

  // Create object URLs for flat-frame thumbnails (dev mode)
  useEffect(() => {
    if (!devMode) return
    const blobs = getLastFlatFrameBlobs()
    if (blobs.length === 0) return
    const urls = blobs.map(b => URL.createObjectURL(b))
    setFlatFrameUrls(urls)
    return () => { urls.forEach(u => URL.revokeObjectURL(u)) }
  }, [devMode])

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

  // Draw debug overlay on canvas once image dimensions are known
  useEffect(() => {
    if (!devMode || !debugInfo || !dimensions || !debugCanvasRef.current) return
    const canvas = debugCanvasRef.current
    canvas.width = dimensions.w
    canvas.height = dimensions.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, dimensions.w, dimensions.h)

    debugInfo.frames.forEach((f, i) => {
      if (i === 0) return // no line for first frame
      const x = f.xPosition
      // Draw boundary line
      ctx.strokeStyle = f.nccScore > 0.5 ? '#00ff88' : f.nccScore > 0.2 ? '#ffcc00' : '#ff4444'
      ctx.lineWidth = Math.max(2, dimensions.w / 600)
      ctx.setLineDash([8, 4])
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, dimensions.h)
      ctx.stroke()

      // Draw label
      const label = `F${i} | ${f.overlapPct}% | NCC:${f.nccScore.toFixed(2)}`
      ctx.font = `bold ${Math.max(12, dimensions.h / 40)}px monospace`
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(x + 4, 6, ctx.measureText(label).width + 8, Math.max(18, dimensions.h / 30))
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, x + 8, Math.max(20, dimensions.h / 22))
    })
  }, [devMode, debugInfo, dimensions, showDebug])

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
          <span>{dimensions.w} &times; {dimensions.h} px</span>
          {devMode && (debugInfo || autoDebugInfo) && (
            <button className={styles.debugToggle} onClick={() => setShowDebug(v => !v)}>
              {showDebug ? 'Hide debug' : 'Debug'}
            </button>
          )}
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
          <div style={{ position: 'relative', display: 'inline-block',
            transform: `scale(${transform.scale}) translate(${transform.x / transform.scale}px, ${transform.y / transform.scale}px)`,
            transformOrigin: 'center center' }}>
            <img
              src={objectUrl}
              alt="Unwrapped label"
              className={styles.image}
              style={{ transform: 'none' }}
              onLoad={handleImageLoad}
              draggable={false}
            />
            {devMode && showDebug && (
              <canvas
                ref={debugCanvasRef}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              />
            )}
          </div>
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

      {/* Flat-frames strip (auto-unwrap dev mode) */}
      {devMode && showDebug && flatFrameUrls.length > 0 && (
        <div className={styles.flatStrip}>
          <span className={styles.flatStripLabel}>
            Flat&nbsp;frames&nbsp;({flatFrameUrls.length})
          </span>
          {flatFrameUrls.map((url, i) => (
            <img
              key={i}
              src={url}
              alt={`flat frame ${i}`}
              className={styles.flatThumb}
              onClick={() => window.open(url, '_blank')}
            />
          ))}
        </div>
      )}

      {/* Auto-unwrap debug panel */}
      {devMode && showDebug && autoDebugInfo && (
        <div className={styles.debugPanel}>
          <p className={styles.debugTitle}>
            Auto-unwrap — {autoDebugInfo.detectedFrames}/{autoDebugInfo.totalFrames} frames detected
            &nbsp;| panorama {autoDebugInfo.panoramaWidth}×{autoDebugInfo.panoramaHeight}px
          </p>
          <table className={styles.debugTable}>
            <thead>
              <tr><th>Frame</th><th>Detected</th><th>Confidence</th><th>X offset</th></tr>
            </thead>
            <tbody>
              {autoDebugInfo.frames.filter(f => f.detected).map(f => (
                <tr key={f.frameIndex}>
                  <td>{f.frameIndex}</td>
                  <td style={{ color: '#00ff88' }}>✓</td>
                  <td style={{ color: f.confidence > 0.6 ? '#00ff88' : f.confidence > 0.4 ? '#ffcc00' : '#ff4444' }}>
                    {(f.confidence * 100).toFixed(0)}%
                  </td>
                  <td>{f.xOffset}px</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Slit-scan debug panel */}
      {devMode && showDebug && debugInfo && (
        <div className={styles.debugPanel}>
          <p className={styles.debugTitle}>Stitch debug — panorama {debugInfo.panoramaWidth}×{debugInfo.frameHeight}px | frames {debugInfo.frameWidth}px wide</p>
          <table className={styles.debugTable}>
            <thead>
              <tr><th>Frame</th><th>X pos</th><th>Overlap</th><th>NCC score</th><th>Quality</th></tr>
            </thead>
            <tbody>
              {debugInfo.frames.map(f => (
                <tr key={f.frameIndex}>
                  <td>{f.frameIndex}</td>
                  <td>{f.xPosition}px</td>
                  <td>{f.overlapPct}%</td>
                  <td style={{ color: f.nccScore > 0.5 ? '#00ff88' : f.nccScore > 0.2 ? '#ffcc00' : '#ff4444' }}>
                    {f.nccScore.toFixed(3)}
                  </td>
                  <td>{f.nccScore > 0.5 ? '✓ Good' : f.nccScore > 0.2 ? '⚠ Fair' : '✗ Poor'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
