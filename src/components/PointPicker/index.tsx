/**
 * PointPicker
 *
 * Shows the captured photo on a canvas. The user taps 6 boundary points
 * in order: A (top-left), B (top-arc peak), C (top-right),
 *           D (bottom-right), E (bottom-arc peak), F (bottom-left).
 *
 * Points are stored as normalised coordinates (0..1 relative to the image).
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import type { Point2D } from '../../lib/unwrapper'
import styles from './PointPicker.module.css'

const POINT_LABELS = ['A', 'B', 'C', 'D', 'E', 'F']
const POINT_INSTRUCTIONS = [
  'Top-left corner of the label',
  'Top center — highest point of the top edge',
  'Top-right corner of the label',
  'Bottom-right corner of the label',
  'Bottom center — lowest point of the bottom edge',
  'Bottom-left corner of the label',
]
const POINT_COLORS = ['#e94560', '#e94560', '#e94560', '#4090e9', '#4090e9', '#4090e9']

interface Transform {
  offsetX: number
  offsetY: number
  drawW: number
  drawH: number
}

interface PointPickerProps {
  photo: Blob
  onConfirm: (points: [Point2D, Point2D, Point2D, Point2D, Point2D, Point2D]) => void
  onRetake: () => void
}

export function PointPicker({ photo, onConfirm, onRetake }: PointPickerProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef       = useRef<HTMLImageElement | null>(null)
  const transformRef = useRef<Transform>({ offsetX: 0, offsetY: 0, drawW: 1, drawH: 1 })

  const [points, setPoints] = useState<Point2D[]>([])

  // ── Load image ────────────────────────────────────────────────────────────
  useEffect(() => {
    const url = URL.createObjectURL(photo)
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      renderCanvas(img, [])
    }
    img.src = url
    return () => URL.revokeObjectURL(url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo])

  // ── Canvas renderer ───────────────────────────────────────────────────────
  const renderCanvas = useCallback((img: HTMLImageElement, pts: Point2D[]) => {
    const canvas    = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    canvas.width  = container.clientWidth
    canvas.height = container.clientHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Letterbox: fit image inside canvas
    const scale  = Math.min(canvas.width / img.width, canvas.height / img.height)
    const drawW  = img.width  * scale
    const drawH  = img.height * scale
    const offsetX = (canvas.width  - drawW) / 2
    const offsetY = (canvas.height - drawH) / 2
    transformRef.current = { offsetX, offsetY, drawW, drawH }

    ctx.drawImage(img, offsetX, offsetY, drawW, drawH)

    if (pts.length === 0) return

    // Helper: normalised → canvas pixel
    const toCvs = (p: Point2D) => ({
      x: offsetX + p.x * drawW,
      y: offsetY + p.y * drawH,
    })

    // Draw top arc (pts 0-2)
    const topCount = Math.min(3, pts.length)
    if (topCount >= 2) drawArc(ctx, pts.slice(0, topCount).map(toCvs), '#e94560')

    // Draw bottom arc (pts 3-5)
    if (pts.length >= 4) {
      const botPts = pts.slice(3).map(toCvs)
      if (botPts.length >= 2) drawArc(ctx, botPts, '#4090e9')
    }

    // Connect left side (A→F) and right side (C→D) as faint lines
    if (pts.length >= 4) {
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 5])
      const A = toCvs(pts[0]), C = toCvs(pts[2] ?? pts[0])
      const D = toCvs(pts[3]),  F = pts[5] ? toCvs(pts[5]) : null
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(D.x, D.y); ctx.stroke()
      if (pts.length >= 3 && pts.length >= 4) {
        ctx.beginPath(); ctx.moveTo(C.x, C.y); ctx.lineTo(D.x, D.y); ctx.stroke()
      }
      if (F) {
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(F.x, F.y); ctx.stroke()
      }
      ctx.restore()
    }

    // Draw labelled dots
    for (let i = 0; i < pts.length; i++) {
      const { x: cx, y: cy } = toCvs(pts[i])
      // Shadow for visibility
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.6)'
      ctx.shadowBlur  = 6
      ctx.beginPath()
      ctx.arc(cx, cy, 13, 0, Math.PI * 2)
      ctx.fillStyle = POINT_COLORS[i]
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth   = 2
      ctx.stroke()

      ctx.fillStyle    = '#fff'
      ctx.font         = 'bold 11px system-ui, sans-serif'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(POINT_LABELS[i], cx, cy)
    }
  }, [])

  // Redraw when points change
  useEffect(() => {
    if (imgRef.current) renderCanvas(imgRef.current, points)
  }, [points, renderCanvas])

  // Redraw on resize
  useEffect(() => {
    const obs = new ResizeObserver(() => {
      if (imgRef.current) renderCanvas(imgRef.current, points)
    })
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [points, renderCanvas])

  // ── Tap / click handler ───────────────────────────────────────────────────
  const handleTap = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
      if (points.length >= 6) return
      e.preventDefault()

      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      let clientX: number, clientY: number

      if ('changedTouches' in e) {
        clientX = e.changedTouches[0].clientX
        clientY = e.changedTouches[0].clientY
      } else {
        clientX = e.clientX
        clientY = e.clientY
      }

      // Scale to canvas internal coords
      const canvasX = (clientX - rect.left) * (canvas.width  / rect.width)
      const canvasY = (clientY - rect.top)  * (canvas.height / rect.height)

      // Convert to image-normalised coords
      const { offsetX, offsetY, drawW, drawH } = transformRef.current
      const relX = (canvasX - offsetX) / drawW
      const relY = (canvasY - offsetY) / drawH

      if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return

      setPoints((prev) => [...prev, { x: relX, y: relY }])
    },
    [points.length],
  )

  const handleUndo    = useCallback(() => setPoints((prev) => prev.slice(0, -1)), [])
  const handleConfirm = useCallback(() => {
    if (points.length === 6) {
      onConfirm(points as [Point2D, Point2D, Point2D, Point2D, Point2D, Point2D])
    }
  }, [points, onConfirm])

  const isDone   = points.length === 6
  const nextIdx  = points.length

  return (
    <div className={styles.container}>
      {/* Instruction bar */}
      <div className={styles.instructionBar}>
        {isDone ? (
          <span className={styles.allSet}>All 6 points placed — tap Unwrap!</span>
        ) : (
          <>
            <span
              className={styles.stepBadge}
              style={{ backgroundColor: POINT_COLORS[nextIdx] }}
            >
              {nextIdx + 1}/6
            </span>
            <span className={styles.instruction}>{POINT_INSTRUCTIONS[nextIdx]}</span>
          </>
        )}
      </div>

      {/* Canvas */}
      <div ref={containerRef} className={styles.photoArea}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          onClick={handleTap}
          onTouchEnd={handleTap}
          aria-label="Label photo — tap to place boundary points"
        />
      </div>

      {/* Controls */}
      <div className={styles.controls}>
        <button className={styles.btnSecondary} onClick={onRetake}>
          Retake
        </button>
        <button
          className={styles.btnSecondary}
          onClick={handleUndo}
          disabled={points.length === 0}
          aria-disabled={points.length === 0}
        >
          Undo
        </button>
        <button
          className={styles.btnPrimary}
          onClick={handleConfirm}
          disabled={!isDone}
          aria-disabled={!isDone}
        >
          Unwrap
        </button>
      </div>
    </div>
  )
}

// ── Arc drawing helper ──────────────────────────────────────────────────────

function drawArc(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  color: string,
) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth   = 2.5
  ctx.setLineDash([8, 5])
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)

  if (pts.length === 3) {
    // Quadratic bezier: adjust ctrl so that B lies exactly on the curve at t=0.5
    // Q(0.5) = 0.25*P0 + 0.5*P1_ctrl + 0.25*P2 = B  →  P1_ctrl = 2B - 0.5P0 - 0.5P2
    const ctrl = {
      x: 2 * pts[1].x - 0.5 * pts[0].x - 0.5 * pts[2].x,
      y: 2 * pts[1].y - 0.5 * pts[0].y - 0.5 * pts[2].y,
    }
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, pts[2].x, pts[2].y)
  } else {
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
  }

  ctx.stroke()
  ctx.restore()
}
