/**
 * stitcher.worker.ts
 *
 * Panorama stitching for cylindrical label unwrapping.
 *
 * Key design decisions:
 * - Background colour is sampled from the first-frame corners and used
 *   throughout: background pixels are excluded from feature computation.
 * - Alignment uses FULL-RESOLUTION 1-D column gradient profiles rather than
 *   a downsampled thumbnail with 2-D strip NCC.
 *   Why: 2-D strip NCC assumes the overlap region looks the same in both frames,
 *   but cylindrical perspective distortion makes the same feature appear
 *   compressed at the edge of one frame and full-size near the centre of the
 *   next.  The 1-D approach sums the gradient profile per column; column
 *   *position* is unaffected by cylindrical foreshortening.
 * - 1-D cross-correlation is computed at full frame width, giving precise
 *   sub-pixel-class accuracy without any rescaling bias.
 * - No global scroll-direction assumption: the sign of the cross-correlation
 *   shift is the direction, determined independently per pair.
 * - Frames are sorted by detected panorama position before compositing so
 *   the result is correct regardless of rotation direction.
 * - Compositing uses a Voronoi centre-strip approach with per-pixel
 *   cylindrical y-correction to remove foreshortening.
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

// Colour distance² threshold for background classification.
const BG_THRESH_SQ = 50 * 50

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Sample the background colour from four 12×12 corner patches.
 * Corners are always background because the label never fills the frame edge.
 */
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
        r += data[i]; g += data[i + 1]; b += data[i + 2]
        n++
      }
    }
  }
  return [r / n, g / n, b / n]
}

// ---------------------------------------------------------------------------
// 1-D column gradient profile
// ---------------------------------------------------------------------------

/**
 * Compute a per-column feature profile for horizontal cross-correlation.
 *
 * For each column x, sums |∂lum/∂x| over non-background pixels in the
 * middle 60% of rows (15%–75%), then divides by the count.  The row range
 * avoids hands typically visible at the bottom of the frame.
 *
 * The horizontal gradient fires at vertical feature edges (text, logos, colour
 * boundaries) and is near zero on flat colour regions.  Summing vertically
 * collapses the 2-D image into a 1-D fingerprint of where those edges are.
 * Two frames taken of the same cylinder at slightly different rotation will
 * have the same fingerprint shifted by the rotation amount.
 */
function columnProfile(img: ImageData, bg: BgColor): Float32Array {
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
      if (dr * dr + dg * dg + db * db < BG_THRESH_SQ) continue  // skip background

      const il = (y * width + x - 1) * 4
      const ir = (y * width + x + 1) * 4
      const lumL = 0.299 * data[il] + 0.587 * data[il + 1] + 0.114 * data[il + 2]
      const lumR = 0.299 * data[ir] + 0.587 * data[ir + 1] + 0.114 * data[ir + 2]
      sum += Math.abs(lumR - lumL)
      cnt++
    }
    prof[x] = cnt > 0 ? sum / cnt : 0
  }
  return prof
}

// ---------------------------------------------------------------------------
// 1-D NCC cross-correlation
// ---------------------------------------------------------------------------

/**
 * Find the shift S that maximises NCC(profA[x], profB[x+S]).
 *
 * Interpretation:
 *   S > 0 → profB's features are at higher x than profA → label scrolled right
 *   S < 0 → profB's features are at lower  x than profA → label scrolled left
 *
 * The signed pixel offset for placing frame B relative to frame A = −S.
 */
function crossCorrelate1D(
  profA: Float32Array,
  profB: Float32Array,
  maxShift: number,
): { shift: number; score: number } {
  const n = profA.length
  let bestShift = 0, bestScore = -Infinity

  for (let shift = -maxShift; shift <= maxShift; shift++) {
    let mA = 0, mB = 0, cnt = 0
    for (let x = 0; x < n; x++) {
      const xB = x + shift
      if (xB < 0 || xB >= n) continue
      mA += profA[x]; mB += profB[xB]; cnt++
    }
    if (cnt < 100) continue
    mA /= cnt; mB /= cnt

    let num = 0, dA = 0, dB = 0
    for (let x = 0; x < n; x++) {
      const xB = x + shift
      if (xB < 0 || xB >= n) continue
      const da = profA[x] - mA, db = profB[xB] - mB
      num += da * db; dA += da * da; dB += db * db
    }
    const den = Math.sqrt(dA * dB)
    const s = den < 1e-6 ? 0 : num / den
    if (s > bestScore) { bestScore = s; bestShift = shift }
  }
  return { shift: bestShift, score: bestScore }
}

/**
 * Find the signed pixel offset for placing frame B relative to frame A.
 * Uses pre-computed column profiles.
 */
function findOffset(
  profA: Float32Array,
  profB: Float32Array,
  fw: number,
): { offset: number; nccScore: number } {
  const maxShift = Math.round(fw * 0.80)
  const { shift, score } = crossCorrelate1D(profA, profB, maxShift)
  return {
    offset: -shift,
    nccScore: Math.round(score * 1000) / 1000,
  }
}

// ---------------------------------------------------------------------------
// Compositing — cylindrical centre-strip projection
// ---------------------------------------------------------------------------

const FOV_DEG = 60
const FOV_RAD = (FOV_DEG * Math.PI) / 180

/**
 * Composite sorted frames into a flat panorama.
 * Frames must be sorted by ascending xPosition.
 *
 * Each output pixel is owned by the frame whose centre is closest horizontally
 * (Voronoi partition).  For each owned pixel we un-project through the
 * cylindrical model: a column srcX maps to angle θ = atan((srcX−cx)/f), and
 * the source y is corrected by 1/cos(θ) to compensate for foreshortening.
 */
function composite(
  frames: ImageData[],
  xPositions: number[],
): ImageData {
  const n = frames.length
  const fw = frames[0].width
  const fh = frames[0].height
  const cx = fw / 2
  const cy = fh / 2
  const f  = fw / (2 * Math.tan(FOV_RAD / 2))

  // Voronoi ownership boundaries between consecutive frames
  const leftBound: number[] = []
  const rightBound: number[] = []
  for (let i = 0; i < n; i++) {
    leftBound.push(i === 0
      ? xPositions[0]
      : (xPositions[i] + xPositions[i - 1]) / 2)
    rightBound.push(i === n - 1
      ? xPositions[n - 1] + fw
      : (xPositions[i] + xPositions[i + 1]) / 2)
  }

  const totalW = Math.round(rightBound[n - 1] - leftBound[0])
  const panoOrigin = leftBound[0]
  const out = new ImageData(totalW, fh)

  for (let i = 0; i < n; i++) {
    const lx = Math.round(leftBound[i]  - panoOrigin)
    const rx = Math.round(rightBound[i] - panoOrigin)

    for (let oy = 0; oy < fh; oy++) {
      for (let gx = lx; gx < rx; gx++) {
        const srcX = (gx + panoOrigin) - xPositions[i]
        if (srcX < 0 || srcX >= fw - 1) continue

        // Cylindrical y-correction: un-project the pixel through the lens model
        const theta = Math.atan((srcX - cx) / f)
        const srcY  = cy + (oy - cy) / Math.cos(theta)
        if (srcY < 0 || srcY >= fh - 1) continue

        const x0 = Math.floor(srcX), x1 = x0 + 1
        const y0 = Math.floor(srcY), y1 = y0 + 1
        const fx = srcX - x0, fy = srcY - y0
        const di = (oy * totalW + gx) * 4

        for (let c = 0; c < 3; c++) {
          const v = frames[i].data[(y0 * fw + x0) * 4 + c] * (1 - fx) * (1 - fy)
                  + frames[i].data[(y0 * fw + x1) * 4 + c] * fx       * (1 - fy)
                  + frames[i].data[(y1 * fw + x0) * 4 + c] * (1 - fx) * fy
                  + frames[i].data[(y1 * fw + x1) * 4 + c] * fx       * fy
          out.data[di + c] = Math.round(clamp(v, 0, 255))
        }
        out.data[di + 3] = 255
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Crop helpers
// ---------------------------------------------------------------------------

function cropToContent(img: ImageData): ImageData {
  const { width, height, data } = img
  let minX = width, maxX = 0, minY = height, maxY = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
      }
    }
  }
  if (minX > maxX || minY > maxY) return img
  const nw = maxX - minX + 1, nh = maxY - minY + 1
  const out = new ImageData(nw, nh)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const si = ((minY + y) * width + (minX + x)) * 4
      const di = (y * nw + x) * 4
      out.data[di]     = data[si]
      out.data[di + 1] = data[si + 1]
      out.data[di + 2] = data[si + 2]
      out.data[di + 3] = data[si + 3]
    }
  }
  return out
}

function cropBackground(img: ImageData, bg: BgColor): ImageData {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg
  const BG_ROW_FRAC = 0.75

  function isBackgroundRow(y: number): boolean {
    let bgCount = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB
      if (dr * dr + dg * dg + db * db < BG_THRESH_SQ) bgCount++
    }
    return bgCount / width >= BG_ROW_FRAC
  }

  let y0 = 0
  while (y0 < height && isBackgroundRow(y0)) y0++
  let y1 = height - 1
  while (y1 > y0 && isBackgroundRow(y1)) y1--

  if (y0 === 0 && y1 === height - 1) return img
  if (y1 - y0 < height * 0.1) return img

  const margin = Math.round(height * 0.01)
  y0 = Math.max(0, y0 - margin)
  y1 = Math.min(height - 1, y1 + margin)
  const nh = y1 - y0 + 1

  const out = new ImageData(width, nh)
  for (let y = 0; y < nh; y++) {
    out.data.set(
      data.subarray((y0 + y) * width * 4, (y0 + y + 1) * width * 4),
      y * width * 4,
    )
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
    if (!frames || frames.length === 0) {
      self.postMessage({ type: 'error', message: 'No frames provided' } as WorkerOutput)
      return
    }

    const n = frames.length
    const fw = frames[0].width
    const fh = frames[0].height
    const post = (o: WorkerOutput) => self.postMessage(o)

    post({ type: 'progress', step: 'Detecting background…', percent: 10 })
    const bg = sampleBackground(frames[0])

    // -----------------------------------------------------------------------
    // Phase 1: Build column profiles for all frames
    // -----------------------------------------------------------------------
    post({ type: 'progress', step: 'Analysing frames…', percent: 20 })
    const profiles: Float32Array[] = frames.map(f => columnProfile(f, bg))

    // -----------------------------------------------------------------------
    // Phase 2: Find pairwise offsets via 1-D cross-correlation
    // -----------------------------------------------------------------------
    const xPositions: number[] = [0]
    const nccScores: number[] = [0]

    for (let i = 1; i < n; i++) {
      const pct = Math.round(20 + ((i - 1) / (n - 1)) * 50)
      post({ type: 'progress', step: `Aligning frame ${i + 1} of ${n}…`, percent: pct })
      const { offset, nccScore } = findOffset(profiles[i - 1], profiles[i], fw)
      xPositions.push(xPositions[i - 1] + offset)
      nccScores.push(nccScore)
    }

    // -----------------------------------------------------------------------
    // Phase 3: Sort frames by panorama position, normalise to min = 0
    // -----------------------------------------------------------------------
    const order = xPositions
      .map((x, i) => ({ x, i }))
      .sort((a, b) => a.x - b.x)

    const minX = order[0].x
    const sortedFrames = order.map(o => frames[o.i])
    const sortedX      = order.map(o => o.x - minX)
    const sortedNcc    = order.map(o => nccScores[o.i])

    // -----------------------------------------------------------------------
    // Phase 4: Composite
    // -----------------------------------------------------------------------
    post({ type: 'progress', step: 'Compositing panorama…', percent: 75 })
    const stitched = composite(sortedFrames, sortedX)

    post({ type: 'progress', step: 'Cropping…', percent: 90 })
    const cropped = cropToContent(stitched)
    const result  = cropBackground(cropped, bg)

    // -----------------------------------------------------------------------
    // Debug info — map back to original frame indices
    // -----------------------------------------------------------------------
    const debugFrames: FrameDebugInfo[] = sortedX.map((xPos, si) => {
      const origIdx = order[si].i
      const overlapPx = si > 0 ? Math.max(0, fw - (sortedX[si] - sortedX[si - 1])) : 0
      return {
        frameIndex: origIdx,
        xPosition: xPos,
        overlapWithPrev: overlapPx,
        overlapPct: Math.round((overlapPx / fw) * 100),
        nccScore: sortedNcc[si],
      }
    })

    const debugInfo: StitchDebugInfo = {
      frameWidth: fw,
      frameHeight: fh,
      panoramaWidth: result.width,
      frames: debugFrames,
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
