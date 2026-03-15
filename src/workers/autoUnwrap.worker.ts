/**
 * autoUnwrap.worker.ts
 *
 * Pipeline for video-based label unwrapping:
 *   1. Detect background colour from the first frame.
 *   2. For every frame, auto-detect the six label boundary points
 *      (top-left A, top-apex B, top-right C, bottom-right D, bottom-apex E, bottom-left F).
 *   3. Unwrap each detected frame to a flat rectangle.
 *   4. Stitch the flat frames into a panorama using 1-D NCC on luminance profiles.
 *
 * In debug mode the worker also posts a `flatFrames` message (before the final
 * result) so the UI can display the per-frame unwraps.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AutoUnwrapInput {
  type: 'autoUnwrap'
  frames: ImageData[]
  debugMode: boolean
}

export interface FrameDebugInfo {
  frameIndex: number
  detected: boolean
  confidence: number
  xOffset: number
}

export interface AutoUnwrapDebugInfo {
  totalFrames: number
  detectedFrames: number
  panoramaWidth: number
  panoramaHeight: number
  frames: FrameDebugInfo[]
}

type WorkerOutput =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'flatFrames'; frames: ImageData[] }
  | { type: 'result'; imageData: ImageData; debugInfo: AutoUnwrapDebugInfo }
  | { type: 'error'; message: string }

interface Point2D { x: number; y: number }
type BgColor = [number, number, number]

// ─── Constants ────────────────────────────────────────────────────────────────

const BG_THRESH_SQ  = 50 * 50
/** Mesh resolution for per-frame unwrap (same as unwrap.worker.ts). */
const COLS = 40
const ROWS = 30
/** Minimum ratio of valid edge columns to accept a frame. */
const MIN_CONFIDENCE = 0.30
/** NCC score below which a frame-pair alignment is considered unreliable. */
const MIN_NCC_SCORE  = 0.15

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function lum(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function isBg(r: number, g: number, b: number, bg: BgColor): boolean {
  const dr = r - bg[0], dg = g - bg[1], db = b - bg[2]
  return dr * dr + dg * dg + db * db < BG_THRESH_SQ
}

// ─── Background sampling ──────────────────────────────────────────────────────

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

// ─── Horizontal gradient profile (for left/right can edges) ───────────────────

function gradientProfile(img: ImageData, bg: BgColor): Float32Array {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg
  const yStart = Math.floor(height * 0.15)
  const yEnd   = Math.floor(height * 0.75)
  const prof = new Float32Array(width)
  for (let x = 1; x < width - 1; x++) {
    let sum = 0, cnt = 0
    for (let y = yStart; y < yEnd; y++) {
      const i = (y * width + x) * 4
      const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB
      if (dr * dr + dg * dg + db * db < BG_THRESH_SQ) continue
      const il = (y * width + x - 1) * 4
      const ir = (y * width + x + 1) * 4
      sum += Math.abs(
        lum(data[ir], data[ir + 1], data[ir + 2]) -
        lum(data[il], data[il + 1], data[il + 2]),
      )
      cnt++
    }
    prof[x] = cnt > 0 ? sum / cnt : 0
  }
  return prof
}

// ─── Detect can left / right columns ─────────────────────────────────────────

function detectCanLR(grad: Float32Array, width: number): { left: number; right: number } {
  let maxG = 0
  for (let x = 0; x < width; x++) if (grad[x] > maxG) maxG = grad[x]
  const edgeThresh = maxG * 0.08
  let left  = Math.floor(width * 0.05)
  let right = Math.ceil(width * 0.95)
  for (let x = 0; x < width; x++)         { if (grad[x] >= edgeThresh) { left  = x; break } }
  for (let x = width - 1; x >= 0; x--)    { if (grad[x] >= edgeThresh) { right = x; break } }
  return { left, right }
}

// ─── 3×3 Gaussian elimination ─────────────────────────────────────────────────

function solve3(A: number[][], bv: number[]): number[] | null {
  const M = A.map((row, i) => [...row, bv[i]])
  for (let col = 0; col < 3; col++) {
    let maxRow = col
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row
    }
    ;[M[col], M[maxRow]] = [M[maxRow], M[col]]
    if (Math.abs(M[col][col]) < 1e-12) return null
    for (let row = 0; row < 3; row++) {
      if (row === col) continue
      const f = M[row][col] / M[col][col]
      for (let c = col; c <= 3; c++) M[row][c] -= f * M[col][c]
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]]
}

// ─── Least-squares parabola fit  y = a·x² + b·x + c ─────────────────────────

function fitParabola(pts: Point2D[]): { a: number; b: number; c: number } | null {
  if (pts.length < 3) return null
  let sx4 = 0, sx3 = 0, sx2 = 0, sx1 = 0
  let sx2y = 0, sxy = 0, sy = 0
  const n = pts.length
  for (const { x, y } of pts) {
    const x2 = x * x
    sx4 += x2 * x2; sx3 += x2 * x; sx2 += x2; sx1 += x
    sx2y += x2 * y; sxy += x * y; sy += y
  }
  const coeffs = solve3(
    [[sx4, sx3, sx2], [sx3, sx2, sx1], [sx2, sx1, n]],
    [sx2y, sxy, sy],
  )
  if (!coeffs) return null
  return { a: coeffs[0], b: coeffs[1], c: coeffs[2] }
}

// ─── Edge detection: find top and bottom label boundary per column ────────────

interface LabelEdgeResult {
  left: number
  right: number
  topPts: Point2D[]
  botPts: Point2D[]
  confidence: number
}

function detectLabelEdges(img: ImageData, bg: BgColor): LabelEdgeResult | null {
  const { width, height, data } = img

  // 1. Can left/right via horizontal gradient
  const grad = gradientProfile(img, bg)
  const { left: canLeft, right: canRight } = detectCanLR(grad, width)
  if (canRight - canLeft < width * 0.1) return null

  // 2. Can vertical extent at the centre column
  const cx = Math.round((canLeft + canRight) / 2)
  let canTop = 0, canBot = height - 1
  for (let y = 0; y < height; y++) {
    const i = (y * width + cx) * 4
    if (!isBg(data[i], data[i + 1], data[i + 2], bg)) { canTop = y; break }
  }
  for (let y = height - 1; y >= 0; y--) {
    const i = (y * width + cx) * 4
    if (!isBg(data[i], data[i + 1], data[i + 2], bg)) { canBot = y; break }
  }
  const canH = canBot - canTop
  if (canH < height * 0.08) return null

  // 3. For each column in the can region, find label top/bottom via the
  //    first strong vertical-gradient crossing (scanning inward from the can edges).
  //    We search within the outer 40 % of the can height on each side.
  const searchH = Math.round(canH * 0.40)
  const colStep = Math.max(1, Math.round((canRight - canLeft) / 80))
  const topPts: Point2D[] = []
  const botPts: Point2D[] = []

  for (let x = canLeft + 2; x <= canRight - 2; x += colStep) {
    // --- top edge: scan down from canTop ---
    let maxGrad = 0
    for (let y = canTop; y < canTop + searchH && y < height - 1; y++) {
      const i0 = (y * width + x) * 4, i1 = ((y + 1) * width + x) * 4
      const g = Math.abs(
        lum(data[i1], data[i1 + 1], data[i1 + 2]) -
        lum(data[i0], data[i0 + 1], data[i0 + 2]),
      )
      if (g > maxGrad) maxGrad = g
    }
    if (maxGrad > 4) {
      const thresh = maxGrad * 0.30
      for (let y = canTop; y < canTop + searchH && y < height - 1; y++) {
        const i0 = (y * width + x) * 4, i1 = ((y + 1) * width + x) * 4
        const g = Math.abs(
          lum(data[i1], data[i1 + 1], data[i1 + 2]) -
          lum(data[i0], data[i0 + 1], data[i0 + 2]),
        )
        if (g >= thresh) { topPts.push({ x, y }); break }
      }
    }

    // --- bottom edge: scan up from canBot ---
    maxGrad = 0
    for (let y = canBot; y > canBot - searchH && y > 0; y--) {
      const i0 = ((y - 1) * width + x) * 4, i1 = (y * width + x) * 4
      const g = Math.abs(
        lum(data[i1], data[i1 + 1], data[i1 + 2]) -
        lum(data[i0], data[i0 + 1], data[i0 + 2]),
      )
      if (g > maxGrad) maxGrad = g
    }
    if (maxGrad > 4) {
      const thresh = maxGrad * 0.30
      for (let y = canBot; y > canBot - searchH && y > 0; y--) {
        const i0 = ((y - 1) * width + x) * 4, i1 = (y * width + x) * 4
        const g = Math.abs(
          lum(data[i1], data[i1 + 1], data[i1 + 2]) -
          lum(data[i0], data[i0 + 1], data[i0 + 2]),
        )
        if (g >= thresh) { botPts.push({ x, y }); break }
      }
    }
  }

  const totalCols = Math.ceil((canRight - canLeft) / colStep)
  const confidence = Math.min(topPts.length, botPts.length) / totalCols
  if (confidence < MIN_CONFIDENCE) return null

  return { left: canLeft, right: canRight, topPts, botPts, confidence }
}

// ─── Convert edge data to 6 named points ──────────────────────────────────────

interface SixPoints { A: Point2D; B: Point2D; C: Point2D; D: Point2D; E: Point2D; F: Point2D }

function edgesToSixPoints(edges: LabelEdgeResult): SixPoints | null {
  const tc = fitParabola(edges.topPts)
  const bc = fitParabola(edges.botPts)
  if (!tc || !bc) return null

  const evalT = (x: number) => tc.a * x * x + tc.b * x + tc.c
  const evalB = (x: number) => bc.a * x * x + bc.b * x + bc.c

  const L = edges.left, R = edges.right
  const tApexX = Math.abs(tc.a) > 1e-8 ? clamp(-tc.b / (2 * tc.a), L, R) : (L + R) / 2
  const bApexX = Math.abs(bc.a) > 1e-8 ? clamp(-bc.b / (2 * bc.a), L, R) : (L + R) / 2

  return {
    A: { x: L,      y: evalT(L)      },
    B: { x: tApexX, y: evalT(tApexX) },
    C: { x: R,      y: evalT(R)      },
    D: { x: R,      y: evalB(R)      },
    E: { x: bApexX, y: evalB(bApexX) },
    F: { x: L,      y: evalB(L)      },
  }
}

// ─── Per-frame unwrap (same algorithm as unwrap.worker.ts) ────────────────────

function makeArcFn(left: Point2D, apex: Point2D): (x: number) => number {
  const dx = left.x - apex.x
  const p = dx * dx > 0.01 ? (left.y - apex.y) / (dx * dx) : 0
  return (x: number) => p * (x - apex.x) * (x - apex.x) + apex.y
}

function buildArcPoints(xStart: number, xEnd: number, count: number, fn: (x: number) => number): Point2D[] {
  const pts: Point2D[] = []
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0
    const x = xStart + t * (xEnd - xStart)
    pts.push({ x, y: fn(x) })
  }
  return pts
}

function sampleBilinear(
  data: Uint8ClampedArray, w: number, h: number,
  sx: number, sy: number,
  out: Uint8ClampedArray, oi: number,
): void {
  const x0 = Math.max(0, Math.min(Math.floor(sx), w - 1))
  const y0 = Math.max(0, Math.min(Math.floor(sy), h - 1))
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const fx = sx - Math.floor(sx), fy = sy - Math.floor(sy)
  const cx = 1 - fx, cy = 1 - fy
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4
  out[oi]     = cx*cy*data[i00]     + fx*cy*data[i10]     + cx*fy*data[i01]     + fx*fy*data[i11]
  out[oi + 1] = cx*cy*data[i00 + 1] + fx*cy*data[i10 + 1] + cx*fy*data[i01 + 1] + fx*fy*data[i11 + 1]
  out[oi + 2] = cx*cy*data[i00 + 2] + fx*cy*data[i10 + 2] + cx*fy*data[i01 + 2] + fx*fy*data[i11 + 2]
  out[oi + 3] = cx*cy*data[i00 + 3] + fx*cy*data[i10 + 3] + cx*fy*data[i01 + 3] + fx*fy*data[i11 + 3]
}

function unwrapFrame(frame: ImageData, pts: SixPoints): ImageData {
  const { A, B, C, D, E, F } = pts
  const topFn = makeArcFn(A, B)
  const botFn = makeArcFn(F, E)
  const topPts = buildArcPoints(A.x, C.x, COLS, topFn)
  const botPts = buildArcPoints(F.x, D.x, COLS, botFn)

  const mesh: Point2D[][] = []
  for (let ci = 0; ci < COLS; ci++) {
    mesh[ci] = []
    for (let ri = 0; ri < ROWS; ri++) {
      const t = ROWS > 1 ? ri / (ROWS - 1) : 0
      mesh[ci][ri] = {
        x: topPts[ci].x + t * (botPts[ci].x - topPts[ci].x),
        y: topPts[ci].y + t * (botPts[ci].y - topPts[ci].y),
      }
    }
  }

  const outW = Math.max(1, Math.round(Math.abs(C.x - A.x)))
  const outH = Math.max(1, Math.round((Math.abs(F.y - A.y) + Math.abs(D.y - C.y) + Math.abs(E.y - B.y)) / 3))
  const outData = new Uint8ClampedArray(outW * outH * 4)
  const src = frame.data as Uint8ClampedArray

  for (let dy = 0; dy < outH; dy++) {
    const rowF = (outH > 1 ? dy / (outH - 1) : 0) * (ROWS - 1)
    const ri = Math.min(Math.floor(rowF), ROWS - 2)
    const rv = rowF - ri
    for (let dx = 0; dx < outW; dx++) {
      const colF = (outW > 1 ? dx / (outW - 1) : 0) * (COLS - 1)
      const ci = Math.min(Math.floor(colF), COLS - 2)
      const cv = colF - ci
      const tl = mesh[ci][ri], tr = mesh[ci + 1][ri]
      const bl = mesh[ci][ri + 1], br = mesh[ci + 1][ri + 1]
      const sx = (1-cv)*(1-rv)*tl.x + cv*(1-rv)*tr.x + (1-cv)*rv*bl.x + cv*rv*br.x
      const sy = (1-cv)*(1-rv)*tl.y + cv*(1-rv)*tr.y + (1-cv)*rv*bl.y + cv*rv*br.y
      if (sx < 0 || sx >= frame.width || sy < 0 || sy >= frame.height) continue
      sampleBilinear(src, frame.width, frame.height, sx, sy, outData, (dy * outW + dx) * 4)
    }
  }
  return new ImageData(outData, outW, outH)
}

// ─── Height-normalise flat frames (scale to median height) ────────────────────

function resizeHeight(img: ImageData, targetH: number): ImageData {
  if (img.height === targetH) return img
  const { width, data } = img
  const out = new Uint8ClampedArray(width * targetH * 4)
  for (let dy = 0; dy < targetH; dy++) {
    const sy = (dy / (targetH - 1)) * (img.height - 1)
    const y0 = Math.max(0, Math.min(Math.floor(sy), img.height - 1))
    const y1 = Math.min(y0 + 1, img.height - 1)
    const fy = sy - y0
    for (let x = 0; x < width; x++) {
      const i0 = (y0 * width + x) * 4
      const i1 = (y1 * width + x) * 4
      const oi = (dy * width + x) * 4
      for (let c = 0; c < 4; c++) out[oi + c] = data[i0 + c] * (1 - fy) + data[i1 + c] * fy
    }
  }
  return new ImageData(out, width, targetH)
}

// ─── Stitch flat frames via 1-D NCC on luminance profiles ────────────────────

/**
 * Returns the per-column average luminance (middle 60% of rows).
 * Used as a 1-D signature for cross-correlation.
 */
function luminanceProfile(img: ImageData): Float32Array {
  const { width, height, data } = img
  const yStart = Math.floor(height * 0.20)
  const yEnd   = Math.floor(height * 0.80)
  const rows = yEnd - yStart
  const prof = new Float32Array(width)
  for (let x = 0; x < width; x++) {
    let s = 0
    for (let y = yStart; y < yEnd; y++) {
      const i = (y * width + x) * 4
      s += lum(data[i], data[i + 1], data[i + 2])
    }
    prof[x] = s / rows
  }
  return prof
}

/**
 * NCC(s) = Σ_i profA[i] * profB[i − s]
 *
 * Returns s such that profA[i] ≈ profB[i − s], meaning
 * offset[B] = offset[A] + s in the panorama.
 */
function findShift(profA: Float32Array, profB: Float32Array): { shift: number; score: number } {
  const n = Math.min(profA.length, profB.length)
  const maxShift = Math.min(Math.round(n * 0.80), 400)

  let bestShift = 0, bestScore = -Infinity

  for (let s = -maxShift; s <= maxShift; s++) {
    let mA = 0, mB = 0, cnt = 0
    for (let i = 0; i < n; i++) {
      const j = i - s
      if (j < 0 || j >= n) continue
      mA += profA[i]; mB += profB[j]; cnt++
    }
    if (cnt < 10) continue
    mA /= cnt; mB /= cnt
    let num = 0, dA = 0, dB = 0
    for (let i = 0; i < n; i++) {
      const j = i - s
      if (j < 0 || j >= n) continue
      const da = profA[i] - mA, db = profB[j] - mB
      num += da * db; dA += da * da; dB += db * db
    }
    const score = (dA * dB) < 1e-12 ? 0 : num / Math.sqrt(dA * dB)
    if (score > bestScore) { bestScore = score; bestShift = s }
  }
  return { shift: bestShift, score: bestScore }
}

function stitchFlatFrames(
  flatFrames: ImageData[],
): { result: ImageData; offsets: number[]; nccScores: number[] } {
  if (flatFrames.length === 1) {
    return { result: flatFrames[0], offsets: [0], nccScores: [1] }
  }

  const profiles   = flatFrames.map(luminanceProfile)
  const offsets    = new Array<number>(flatFrames.length).fill(0)
  const nccScores  = new Array<number>(flatFrames.length).fill(1)

  for (let i = 1; i < flatFrames.length; i++) {
    const { shift, score } = findShift(profiles[i - 1], profiles[i])
    nccScores[i] = score
    // Only advance if NCC is reliable; otherwise don't extend the panorama
    offsets[i] = score >= MIN_NCC_SCORE ? offsets[i - 1] + shift : offsets[i - 1]
  }

  // Normalise so min offset = 0
  const minOff = Math.min(...offsets)
  for (let i = 0; i < offsets.length; i++) offsets[i] -= minOff

  const outH = flatFrames[0].height
  const outW = Math.max(1, Math.max(...flatFrames.map((f, i) => offsets[i] + f.width)))

  // Composite with per-pixel average blending
  const accR = new Float64Array(outW * outH)
  const accG = new Float64Array(outW * outH)
  const accB = new Float64Array(outW * outH)
  const accN = new Float64Array(outW * outH)

  for (let fi = 0; fi < flatFrames.length; fi++) {
    const frame = flatFrames[fi]
    const xOff  = offsets[fi]
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const ox = x + xOff
        if (ox < 0 || ox >= outW) continue
        const si = (y * frame.width + x) * 4
        const di = y * outW + ox
        accR[di] += frame.data[si]
        accG[di] += frame.data[si + 1]
        accB[di] += frame.data[si + 2]
        accN[di] += 1
      }
    }
  }

  const outData = new Uint8ClampedArray(outW * outH * 4)
  for (let i = 0; i < outW * outH; i++) {
    if (accN[i] > 0) {
      outData[i * 4]     = accR[i] / accN[i]
      outData[i * 4 + 1] = accG[i] / accN[i]
      outData[i * 4 + 2] = accB[i] / accN[i]
      outData[i * 4 + 3] = 255
    }
  }

  return { result: new ImageData(outData, outW, outH), offsets, nccScores }
}

// ─── Message handler ─────────────────────────────────────────────────────────

self.addEventListener('message', (event: MessageEvent<AutoUnwrapInput>) => {
  const msg = event.data
  if (msg.type !== 'autoUnwrap') {
    self.postMessage({ type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` } as WorkerOutput)
    return
  }

  try {
    const { frames, debugMode } = msg
    if (!frames || frames.length < 1) {
      self.postMessage({ type: 'error', message: 'No frames received.' } as WorkerOutput)
      return
    }

    const post = (o: WorkerOutput) => self.postMessage(o)
    const n = frames.length

    // ── Phase 1: Background ──────────────────────────────────────────────────
    post({ type: 'progress', step: 'Detecting background…', percent: 5 })
    const bg = sampleBackground(frames[0])

    // ── Phase 2: Per-frame edge detection + unwrap ───────────────────────────
    post({ type: 'progress', step: 'Detecting label edges…', percent: 10 })

    const flatFrames: ImageData[]      = []
    const frameDebug: FrameDebugInfo[] = []

    for (let i = 0; i < n; i++) {
      const pct = Math.round(10 + (i / n) * 50)
      post({ type: 'progress', step: `Unwrapping frame ${i + 1} / ${n}…`, percent: pct })

      const edges = detectLabelEdges(frames[i], bg)
      if (!edges) { frameDebug.push({ frameIndex: i, detected: false, confidence: 0, xOffset: -1 }); continue }

      const pts = edgesToSixPoints(edges)
      if (!pts)  { frameDebug.push({ frameIndex: i, detected: false, confidence: 0, xOffset: -1 }); continue }

      const flat = unwrapFrame(frames[i], pts)
      flatFrames.push(flat)
      frameDebug.push({ frameIndex: i, detected: true, confidence: edges.confidence, xOffset: -1 })
    }

    if (flatFrames.length === 0) {
      post({ type: 'error', message: 'Could not detect label edges in any frame. Try better lighting or a plainer background.' })
      return
    }

    // ── Phase 3: Height normalisation ────────────────────────────────────────
    post({ type: 'progress', step: 'Normalising frame heights…', percent: 62 })
    const heights = flatFrames.map(f => f.height).sort((a, b) => a - b)
    const medH    = heights[Math.floor(heights.length / 2)]
    const normFrames = flatFrames.map(f => resizeHeight(f, medH))

    // ── Phase 4: Stitch ──────────────────────────────────────────────────────
    post({ type: 'progress', step: `Stitching ${normFrames.length} unwrapped frames…`, percent: 65 })
    const { result, offsets, nccScores } = stitchFlatFrames(normFrames)

    // Fill in x offsets for debug info
    let flatIdx = 0
    for (const fd of frameDebug) {
      if (fd.detected) fd.xOffset = offsets[flatIdx++]
    }

    post({ type: 'progress', step: 'Done!', percent: 100 })

    const debugInfo: AutoUnwrapDebugInfo = {
      totalFrames:   n,
      detectedFrames: normFrames.length,
      panoramaWidth:  result.width,
      panoramaHeight: result.height,
      frames: frameDebug.map((fd, _, arr) => {
        // Attach NCC score to detected frames
        const detectedIndex = arr.filter(f => f.detected).findIndex(f => f === fd)
        return {
          ...fd,
          nccScore: fd.detected && detectedIndex > 0 ? nccScores[detectedIndex] : 1,
        } as FrameDebugInfo & { nccScore: number }
      }),
    }

    // Send flat frames first (transfer buffers — they're no longer needed in the worker)
    if (debugMode) {
      const transfer = normFrames.map(f => f.data.buffer as ArrayBuffer)
      self.postMessage({ type: 'flatFrames', frames: normFrames } as WorkerOutput, { transfer })
    }

    self.postMessage(
      { type: 'result', imageData: result, debugInfo } as WorkerOutput,
      { transfer: [result.data.buffer as ArrayBuffer] },
    )

  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } as WorkerOutput)
  }
})

export {}
