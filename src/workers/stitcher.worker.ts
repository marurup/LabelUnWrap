/**
 * stitcher.worker.ts — slit-scan label unwrapper.
 *
 * How it works
 * ─────────────
 * The camera is held still while the can rotates.  The centre column of each
 * frame therefore shows a different strip of the label as it sweeps past.
 * We concatenate those centre strips in time order to build a flat panorama.
 *
 * Horizontal jitter compensation
 * ───────────────────────────────
 * Camera shake shifts the can left/right in the frame.  We detect the can's
 * horizontal centre each frame (midpoint of non-background columns) and
 * always sample relative to that centre, so jitter is automatically cancelled.
 *
 * Strip width
 * ────────────
 * Cross-correlating the gradient profiles centred on the can centre gives the
 * apparent rotation Δpx between consecutive frames.  We use |Δpx| columns
 * from the centre of each frame so the output is geometrically proportional
 * to the rotation — no stretching, no compression.
 *
 * Vertical alignment
 * ───────────────────
 * For each frame we find the vertical centre of the can at its centre column
 * and shift the strip so the can centre is always at the same output row.
 */

type WorkerInput = { type: 'stitch'; frames: ImageData[] }

export interface FrameDebugInfo {
  frameIndex: number
  xPosition: number
  overlapWithPrev: number
  overlapPct: number
  nccScore: number
}

export interface StitchDebugInfo {
  frameWidth: number
  frameHeight: number
  panoramaWidth: number
  frames: FrameDebugInfo[]
}

type WorkerOutput =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'result'; imageData: ImageData; debugInfo: StitchDebugInfo }
  | { type: 'error'; message: string }

type BgColor = [number, number, number]

const BG_THRESH_SQ  = 50 * 50
// Maximum strip width taken from a single frame.  Limits distortion at can edges.
const MAX_STRIP     = 80
// Minimum rotation (px) needed to include a frame.  Skips near-stationary frames.
const MIN_ROTATION  = 2
// Half-width of the centred profile window used for rotation detection.
const PROFILE_HW    = 300

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function sampleBackground(frame: ImageData): BgColor {
  const { width, height, data } = frame
  const PATCH = 12
  let r = 0, g = 0, b = 0, n = 0
  const origins = [
    [0, 0], [width - PATCH, 0],
    [0, height - PATCH], [width - PATCH, height - PATCH],
  ]
  for (const [sx, sy] of origins) {
    for (let dy = 0; dy < PATCH; dy++) {
      for (let dx = 0; dx < PATCH; dx++) {
        const i = (clamp(sy + dy, 0, height - 1) * width + clamp(sx + dx, 0, width - 1)) * 4
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
      }
    }
  }
  return [r / n, g / n, b / n]
}

// ---------------------------------------------------------------------------
// Per-column profiles
// ---------------------------------------------------------------------------


/**
 * Gradient profile: mean |∂lum/∂x| per column for non-background pixels
 * in the middle 60% of rows.  Used for rotation detection.
 */
function gradientProfile(img: ImageData, bg: BgColor): Float32Array {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg
  const yStart = Math.floor(height * 0.15)
  const yEnd   = Math.floor(height * 0.75)
  const prof = new Float32Array(width)
  for (let x = 1; x < width - 1; x++) {
    let sum = 0, cnt = 0
    for (let y = yStart; y < yEnd; y++) {
      const i  = (y * width + x) * 4
      const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB
      if (dr * dr + dg * dg + db * db < BG_THRESH_SQ) continue
      const il = (y * width + x - 1) * 4
      const ir = (y * width + x + 1) * 4
      const lL = 0.299 * data[il] + 0.587 * data[il + 1] + 0.114 * data[il + 2]
      const lR = 0.299 * data[ir] + 0.587 * data[ir + 1] + 0.114 * data[ir + 2]
      sum += Math.abs(lR - lL); cnt++
    }
    prof[x] = cnt > 0 ? sum / cnt : 0
  }
  return prof
}

// ---------------------------------------------------------------------------
// Can geometry per frame
// ---------------------------------------------------------------------------

interface CanGeometry {
  /** Centre column of the can (rotation axis projected onto image plane). */
  cx: number
  /** Leftmost non-background column. */
  left: number
  /** Rightmost non-background column. */
  right: number
  /** Vertical centre row of can content at the centre column. */
  cy: number
}

function detectCanGeometry(img: ImageData, bg: BgColor, grad: Float32Array): CanGeometry {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg

  // Horizontal: find can edges using gradient profile.
  // Background regions (floor, wall) have low gradient; the can label has high gradient.
  // Use 8% of the peak as the edge threshold.
  let maxG = 0
  for (let x = 0; x < width; x++) if (grad[x] > maxG) maxG = grad[x]
  const edgeThresh = maxG * 0.08

  let left = Math.floor(width * 0.05)
  let right = Math.ceil(width * 0.95)
  for (let x = 0; x < width; x++) { if (grad[x] >= edgeThresh) { left = x; break } }
  for (let x = width - 1; x >= 0; x--) { if (grad[x] >= edgeThresh) { right = x; break } }
  const cx = Math.round((left + right) / 2)

  // Vertical: find topmost and bottommost non-background rows at cx
  let top = 0, bottom = height - 1
  for (let y = 0; y < height; y++) {
    const i = (y * width + cx) * 4
    const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB
    if (dr * dr + dg * dg + db * db >= BG_THRESH_SQ) { top = y; break }
  }
  for (let y = height - 1; y >= 0; y--) {
    const i = (y * width + cx) * 4
    const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB
    if (dr * dr + dg * dg + db * db >= BG_THRESH_SQ) { bottom = y; break }
  }
  const cy = Math.round((top + bottom) / 2)

  return { cx, left, right, cy }
}

// ---------------------------------------------------------------------------
// Rotation detection
// ---------------------------------------------------------------------------

/**
 * Detect the apparent pixel rotation of the can between two frames.
 *
 * We extract windows of the gradient profile centred on each frame's can
 * centre, then cross-correlate.  Because we align to the can centre,
 * horizontal camera jitter is already cancelled.
 *
 * Returns the signed shift (positive = can moved right = label scrolled right).
 */
function detectRotation(
  profA: Float32Array, cxA: number,
  profB: Float32Array, cxB: number,
  fw: number,
): { shift: number; score: number } {
  const hw = Math.min(
    PROFILE_HW,
    cxA, fw - 1 - cxA,
    cxB, fw - 1 - cxB,
  )
  if (hw < 20) return { shift: 0, score: 0 }

  // Extract centred windows
  const wA = new Float32Array(2 * hw + 1)
  const wB = new Float32Array(2 * hw + 1)
  for (let d = -hw; d <= hw; d++) {
    wA[d + hw] = profA[cxA + d]
    wB[d + hw] = profB[cxB + d]
  }

  // 1-D NCC across all shifts up to hw/2
  const maxShift = Math.round(hw * 0.8)
  const n = wA.length
  let bestShift = 0, bestScore = -Infinity

  for (let shift = -maxShift; shift <= maxShift; shift++) {
    let mA = 0, mB = 0, cnt = 0
    for (let i = 0; i < n; i++) {
      const j = i + shift
      if (j < 0 || j >= n) continue
      mA += wA[i]; mB += wB[j]; cnt++
    }
    if (cnt < 10) continue
    mA /= cnt; mB /= cnt
    let num = 0, dA = 0, dB = 0
    for (let i = 0; i < n; i++) {
      const j = i + shift
      if (j < 0 || j >= n) continue
      const da = wA[i] - mA, db = wB[j] - mB
      num += da * db; dA += da * da; dB += db * db
    }
    const den = Math.sqrt(dA * dB)
    const s = den < 1e-6 ? 0 : num / den
    if (s > bestScore) { bestScore = s; bestShift = shift }
  }
  return { shift: bestShift, score: bestScore }
}

// ---------------------------------------------------------------------------
// Crop helpers
// ---------------------------------------------------------------------------

function cropBackground(img: ImageData, bg: BgColor): ImageData {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg
  const BG_FRAC = 0.85

  function isBgRow(y: number) {
    let bgCnt = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB
      if (dr * dr + dg * dg + db * db < BG_THRESH_SQ) bgCnt++
    }
    return bgCnt / width >= BG_FRAC
  }

  let y0 = 0
  while (y0 < height && isBgRow(y0)) y0++
  let y1 = height - 1
  while (y1 > y0 && isBgRow(y1)) y1--
  if (y1 - y0 < height * 0.05) return img

  const margin = Math.round(height * 0.01)
  y0 = Math.max(0, y0 - margin)
  y1 = Math.min(height - 1, y1 + margin)
  const nh = y1 - y0 + 1
  const out = new ImageData(width, nh)
  for (let y = 0; y < nh; y++) {
    out.data.set(data.subarray((y0 + y) * width * 4, (y0 + y + 1) * width * 4), y * width * 4)
  }
  return out
}

function cropSides(img: ImageData): ImageData {
  const { width, height, data } = img
  let x0 = 0, x1 = width - 1
  outer: for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (data[(y * width + x) * 4 + 3] > 0) { x0 = x; break outer }
    }
  }
  outer: for (let x = width - 1; x >= x0; x--) {
    for (let y = 0; y < height; y++) {
      if (data[(y * width + x) * 4 + 3] > 0) { x1 = x; break outer }
    }
  }
  if (x0 === 0 && x1 === width - 1) return img
  const nw = x1 - x0 + 1
  const out = new ImageData(nw, height)
  for (let y = 0; y < height; y++) {
    const si = (y * width + x0) * 4
    out.data.set(data.subarray(si, si + nw * 4), y * nw * 4)
  }
  return out
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.addEventListener('message', (event: MessageEvent<WorkerInput>) => {
  const msg = event.data
  if (msg.type !== 'stitch') {
    self.postMessage({ type: 'error', message: `Unknown: ${(msg as { type: string }).type}` } as WorkerOutput)
    return
  }

  try {
    const { frames } = msg
    if (!frames || frames.length < 2) {
      self.postMessage({ type: 'error', message: 'Need at least 2 frames' } as WorkerOutput)
      return
    }

    const n  = frames.length
    const fw = frames[0].width
    const fh = frames[0].height
    const post = (o: WorkerOutput) => self.postMessage(o)

    // -----------------------------------------------------------------------
    // Phase 1: Detect background, build profiles, find can geometry
    // -----------------------------------------------------------------------
    post({ type: 'progress', step: 'Detecting background…', percent: 5 })
    const bg = sampleBackground(frames[0])

    post({ type: 'progress', step: 'Analysing frames…', percent: 10 })
    const gradProfiles = frames.map(f => gradientProfile(f, bg))
    const geoms        = frames.map((f, i) => detectCanGeometry(f, bg, gradProfiles[i]))

    // Robust can vertical centre: median across all frames
    const sortedCy = geoms.map(g => g.cy).slice().sort((a, b) => a - b)
    const refCy    = sortedCy[Math.floor(n / 2)]

    // -----------------------------------------------------------------------
    // Phase 2: Detect per-pair rotation
    // -----------------------------------------------------------------------
    post({ type: 'progress', step: 'Measuring rotation…', percent: 25 })

    interface Strip { frameIdx: number; width: number; rotation: number; score: number }
    const strips: Strip[] = []

    for (let i = 1; i < n; i++) {
      const pct = Math.round(25 + ((i - 1) / (n - 1)) * 35)
      post({ type: 'progress', step: `Aligning frame ${i + 1} of ${n}…`, percent: pct })

      const { shift, score } = detectRotation(
        gradProfiles[i - 1], geoms[i - 1].cx,
        gradProfiles[i],     geoms[i].cx,
        fw,
      )

      // shift > 0 → can rotated so features moved right → label advancing
      // We use |shift| as strip width; direction handled by time order.
      const w = clamp(Math.abs(shift), 0, MAX_STRIP)
      if (w >= MIN_ROTATION) {
        strips.push({ frameIdx: i, width: w, rotation: shift, score })
      }
    }

    if (strips.length === 0) {
      self.postMessage({ type: 'error', message: 'No rotation detected between frames — did the can stay still?' } as WorkerOutput)
      return
    }

    // -----------------------------------------------------------------------
    // Phase 3: Assemble slit-scan panorama
    // -----------------------------------------------------------------------
    post({ type: 'progress', step: 'Assembling panorama…', percent: 65 })

    const totalW = strips.reduce((s, t) => s + t.width, 0)

    // Output height: frame height (will crop later)
    const out = new ImageData(totalW, fh)
    let outCol = 0

    for (const strip of strips) {
      const frame  = frames[strip.frameIdx]
      const geo    = geoms[strip.frameIdx]
      const halfW  = Math.floor(strip.width / 2)
      const startX = clamp(geo.cx - halfW, 0, fw - strip.width)
      // Vertical shift to align can centre to refCy
      const dyPx   = geo.cy - refCy

      for (let s = 0; s < strip.width; s++) {
        const srcX = startX + s
        for (let oy = 0; oy < fh; oy++) {
          const srcY = clamp(oy + dyPx, 0, fh - 1)
          const si = (srcY * fw + srcX) * 4
          const di = (oy  * totalW + outCol) * 4
          out.data[di]     = frame.data[si]
          out.data[di + 1] = frame.data[si + 1]
          out.data[di + 2] = frame.data[si + 2]
          out.data[di + 3] = 255
        }
        outCol++
      }
    }

    // -----------------------------------------------------------------------
    // Phase 4: Crop background rows, then sides
    // -----------------------------------------------------------------------
    post({ type: 'progress', step: 'Cropping…', percent: 88 })
    const cropped = cropBackground(out, bg)
    const result  = cropSides(cropped)

    // -----------------------------------------------------------------------
    // Debug info
    // -----------------------------------------------------------------------
    const debugFrames: FrameDebugInfo[] = strips.map((st, si) => ({
      frameIndex:     st.frameIdx,
      xPosition:      strips.slice(0, si).reduce((s, t) => s + t.width, 0),
      overlapWithPrev: 0,
      overlapPct:      0,
      nccScore:        Math.round(st.score * 1000) / 1000,
    }))

    const debugInfo: StitchDebugInfo = {
      frameWidth:    fw,
      frameHeight:   fh,
      panoramaWidth: result.width,
      frames:        debugFrames,
    }

    post({ type: 'progress', step: 'Done', percent: 100 })
    self.postMessage({ type: 'result', imageData: result, debugInfo } as WorkerOutput, {
      transfer: [result.data.buffer],
    })
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } as WorkerOutput)
  }
})

export {}
