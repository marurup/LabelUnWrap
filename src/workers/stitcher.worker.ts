/**
 * stitcher.worker.ts
 *
 * Panorama stitching for cylindrical label unwrapping.
 *
 * Key design decisions:
 * - Background colour is sampled from the first-frame corners and used
 *   throughout: background pixels are zeroed in NCC thumbnails so only label
 *   features drive overlap detection.
 * - NCC uses the HORIZONTAL GRADIENT of the background-subtracted luminance
 *   thumbnail, not raw luminance.  Uniform white label surface → zero
 *   gradient → cannot corrupt NCC.  Coloured edges → strong gradient →
 *   NCC peaks only where features truly align.
 * - Overlap search is 2-D: horizontal overlap AND vertical shift (±MAX_DY
 *   thumb rows) to compensate for object tilt between frames.
 * - Scroll direction (label moving left vs right in the camera) is detected
 *   from the 1-D column-shift of the gradient profiles for the first pair,
 *   then enforced globally so the panorama is always consistent.
 * - Frames are sorted by detected panorama position before compositing so
 *   the result is correct regardless of scroll direction.
 * - Compositing uses a Voronoi centre-strip approach with per-pixel
 *   cylindrical y-correction AND per-frame vertical offset correction to
 *   remove both foreshortening and tilt-induced vertical drift.
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

// Vertical-shift search range in thumbnail rows (each row ≈ frameHeight/TH px).
const MAX_DY = 5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function ncc(a: Float32Array, b: Float32Array): number {
  const n = a.length
  let sumA = 0, sumB = 0
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i] }
  const mA = sumA / n, mB = sumB / n
  let num = 0, dA = 0, dB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB
    num += da * db; dA += da * da; dB += db * db
  }
  const den = Math.sqrt(dA * dB)
  return den < 1e-6 ? 0 : num / den
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

/**
 * Background-subtracted luminance thumbnail.
 * Background pixels → 0.  Label pixels → grayscale average of the block.
 * Used for the column-presence mask (which columns contain label content).
 */
function buildLumThumb(
  img: ImageData,
  tw: number,
  th: number,
  bg: BgColor,
): Float32Array {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg
  const out = new Float32Array(tw * th)

  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty / th) * height)
    const y1 = Math.floor(((ty + 1) / th) * height)
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx / tw) * width)
      const x1 = Math.floor(((tx + 1) / tw) * width)
      let sum = 0, fgCnt = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB
          if (dr * dr + dg * dg + db * db >= BG_THRESH_SQ) {
            sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
            fgCnt++
          }
        }
      }
      out[ty * tw + tx] = fgCnt > 0 ? sum / fgCnt : 0
    }
  }
  return out
}

/**
 * Horizontal-gradient magnitude of the luminance thumbnail.
 *
 * Why this instead of raw luminance for NCC?
 * A label on a plain white background creates a nearly uniform luminance
 * thumbnail — any overlap window has a similar mean so NCC is high
 * everywhere.  The horizontal gradient is zero on flat white and spikes at
 * the edges of coloured features (lines, text), so NCC is high only when
 * those feature edges align at the true overlap.
 */
function buildGradThumb(lum: Float32Array, tw: number, th: number): Float32Array {
  const grad = new Float32Array(tw * th)
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const l = tx > 0    ? lum[ty * tw + tx - 1] : lum[ty * tw + tx]
      const r = tx < tw-1 ? lum[ty * tw + tx + 1] : lum[ty * tw + tx]
      grad[ty * tw + tx] = Math.abs(r - l)
    }
  }
  return grad
}

/**
 * Column mask: which thumbnail columns contain label content (non-zero lum).
 * Only the top 75 % of rows — the bottom 25 % often contains hands.
 */
function buildColMask(lum: Float32Array, tw: number, th: number): Uint8Array {
  const mask = new Uint8Array(tw)
  const maxRow = Math.floor(th * 0.75)
  for (let ty = 0; ty < maxRow; ty++)
    for (let tx = 0; tx < tw; tx++)
      if (lum[ty * tw + tx] > 0) mask[tx] = 1
  return mask
}

function colCentroid(mask: Uint8Array, tw: number): number {
  let xSum = 0, n = 0
  for (let x = 0; x < tw; x++) if (mask[x]) { xSum += x; n++ }
  return n > 0 ? xSum / n : tw / 2
}

/**
 * Estimate the 1-D column shift of the gradient profiles between two frames.
 * Positive return → features moved RIGHT (label scrolls right).
 * Negative return → features moved LEFT (label scrolls left).
 */
function estimateColShift(tA: Float32Array, tB: Float32Array, tw: number, th: number): number {
  const maxRow = Math.floor(th * 0.75)
  const sA = new Float32Array(tw)
  const sB = new Float32Array(tw)
  for (let tx = 0; tx < tw; tx++)
    for (let ty = 0; ty < maxRow; ty++) {
      sA[tx] += tA[ty * tw + tx]
      sB[tx] += tB[ty * tw + tx]
    }

  const maxShift = Math.round(tw * 0.80)
  let bestShift = 0, bestNCC = -Infinity
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    let n = 0, mA = 0, mB = 0
    for (let x = 0; x < tw; x++) {
      const xB = x + shift
      if (xB < 0 || xB >= tw) continue
      mA += sA[x]; mB += sB[xB]; n++
    }
    if (n < 10) continue
    mA /= n; mB /= n
    let num = 0, dA = 0, dB = 0
    for (let x = 0; x < tw; x++) {
      const xB = x + shift
      if (xB < 0 || xB >= tw) continue
      const da = sA[x] - mA, db = sB[xB] - mB
      num += da * db; dA += da * da; dB += db * db
    }
    const den = Math.sqrt(dA * dB)
    const s = den < 1e-6 ? 0 : num / den
    if (s > bestNCC) { bestNCC = s; bestShift = shift }
  }
  return bestShift
}

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

/**
 * Find the horizontal offset between two adjacent frames.
 *
 * scrollDir:
 *  +1 = label scrolls right → compare A's LEFT strip with B's RIGHT strip
 *       → returns negative offset (B starts to the LEFT of A in the panorama)
 *  -1 = label scrolls left  → compare A's RIGHT strip with B's LEFT strip
 *       → returns positive offset (B starts to the RIGHT of A)
 *
 * The 2-D search also finds the best vertical shift (dy) to compensate for
 * object tilt; positive dy means B's content is shifted down relative to A.
 */
function findOffset(
  frameA: ImageData,
  frameB: ImageData,
  bg: BgColor,
  scrollDir: number,
): { offset: number; nccScore: number; dy: number } {
  const fw = frameA.width
  const TW = 96, TH = 54

  const lumA = buildLumThumb(frameA, TW, TH, bg)
  const lumB = buildLumThumb(frameB, TW, TH, bg)
  const tA   = buildGradThumb(lumA, TW, TH)
  const tB   = buildGradThumb(lumB, TW, TH)
  const maskA = buildColMask(lumA, TW, TH)
  const maskB = buildColMask(lumB, TW, TH)

  // scrollDir +1 → nccDir -1 (left of A vs right of B)
  // scrollDir -1 → nccDir +1 (right of A vs left of B)
  const nccDir = -scrollDir

  // Minimum overlap 20 % avoids the label-edge gradient artefact
  const minOvlp = Math.round(TW * 0.20)
  const maxOvlp = Math.round(TW * 0.92)

  let bestOvlp = -1, bestScore = -Infinity, bestDy = 0

  for (let ovlp = minOvlp; ovlp <= maxOvlp; ovlp++) {
    let fgCols = 0
    for (let x = 0; x < ovlp; x++) {
      const colA = nccDir === 1 ? (TW - ovlp + x) : x
      const colB = nccDir === 1 ? x : (TW - ovlp + x)
      if (maskA[colA] && maskB[colB]) fgCols++
    }
    if (fgCols < 3) continue

    for (let dy = -MAX_DY; dy <= MAX_DY; dy++) {
      const rA = new Float32Array(ovlp * TH)
      const rB = new Float32Array(ovlp * TH)
      for (let y = 0; y < TH; y++) {
        const yB = clamp(y + dy, 0, TH - 1)
        for (let x = 0; x < ovlp; x++) {
          if (nccDir === 1) {
            rA[y * ovlp + x] = tA[y  * TW + (TW - ovlp + x)]
            rB[y * ovlp + x] = tB[yB * TW + x]
          } else {
            rA[y * ovlp + x] = tA[y  * TW + x]
            rB[y * ovlp + x] = tB[yB * TW + (TW - ovlp + x)]
          }
        }
      }
      const s = ncc(rA, rB)
      if (s > bestScore) { bestScore = s; bestOvlp = ovlp; bestDy = dy }
    }
  }

  if (bestOvlp === -1) {
    const cA = colCentroid(maskA, TW)
    const cB = colCentroid(maskB, TW)
    const rawOff = Math.round(((cA - cB) / TW) * fw)
    return { offset: rawOff * nccDir, nccScore: 0, dy: 0 }
  }

  const pxOffset = Math.round(((TW - bestOvlp) / TW) * fw) * nccDir
  return { offset: pxOffset, nccScore: Math.round(bestScore * 1000) / 1000, dy: bestDy }
}

// ---------------------------------------------------------------------------
// Compositing — cylindrical centre-strip projection with vertical correction
// ---------------------------------------------------------------------------

const FOV_DEG = 60
const FOV_RAD = (FOV_DEG * Math.PI) / 180

/**
 * Composite frames into a flat panorama.
 *
 * Frames must be provided sorted by ascending xPosition.
 * yOffsets[i]: cumulative vertical pixel shift of frame i (positive = frame
 * content shifted down in the panorama, i.e. the object was lower in that
 * frame than in the reference).
 */
function composite(
  frames: ImageData[],
  xPositions: number[],
  yOffsets: number[],
): ImageData {
  const n = frames.length
  const fw = frames[0].width
  const fh = frames[0].height
  const cx = fw / 2
  const cy = fh / 2
  const f  = fw / (2 * Math.tan(FOV_RAD / 2))

  // Voronoi ownership boundaries
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

  // Panorama height expands to contain all vertical drift
  const maxYOff = Math.max(...yOffsets)
  const minYOff = Math.min(...yOffsets)
  const totalH = fh + Math.ceil(maxYOff - minYOff)

  const out = new ImageData(totalW, totalH)

  for (let i = 0; i < n; i++) {
    const lx = Math.round(leftBound[i]  - panoOrigin)
    const rx = Math.round(rightBound[i] - panoOrigin)
    // Vertical canvas offset for this frame: shift output rows so that the
    // frame's reference row cy lands at cy + (yOffsets[i] - minYOff).
    const yShift = Math.round(yOffsets[i] - minYOff)

    for (let oy = 0; oy < totalH; oy++) {
      for (let gx = lx; gx < rx; gx++) {
        const srcX = (gx + panoOrigin) - xPositions[i]
        if (srcX < 0 || srcX >= fw - 1) continue

        // Cylindrical y-correction + vertical-drift correction
        const theta  = Math.atan((srcX - cx) / f)
        const srcY   = cy + (oy - yShift - cy) / Math.cos(theta)
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
    const TW = 96, TH = 54
    const post = (o: WorkerOutput) => self.postMessage(o)

    post({ type: 'progress', step: 'Detecting background…', percent: 15 })
    const bg = sampleBackground(frames[0])

    // -----------------------------------------------------------------------
    // Phase 1: Detect global scroll direction from the first frame pair.
    // -----------------------------------------------------------------------
    post({ type: 'progress', step: 'Detecting scroll direction…', percent: 25 })
    const lum0 = buildLumThumb(frames[0], TW, TH, bg)
    const lum1 = buildLumThumb(frames[1], TW, TH, bg)
    const grad0 = buildGradThumb(lum0, TW, TH)
    const grad1 = buildGradThumb(lum1, TW, TH)
    const colShift = estimateColShift(grad0, grad1, TW, TH)
    // positive colShift → features moved right → label scrolls right (scrollDir=+1)
    // negative colShift → features moved left  → label scrolls left  (scrollDir=-1)
    const scrollDir = colShift >= 0 ? 1 : -1

    // -----------------------------------------------------------------------
    // Phase 2: Find overlaps (25%–70%)
    // -----------------------------------------------------------------------
    const xPositions: number[] = [0]
    const dyRaw: number[] = [0]         // per-frame dy (thumb rows)
    const nccScores: number[] = [0]

    for (let i = 1; i < n; i++) {
      const pct = Math.round(25 + ((i - 1) / (n - 1)) * 45)
      post({ type: 'progress', step: `Aligning frame ${i + 1} of ${n}…`, percent: pct })
      const { offset, nccScore, dy } = findOffset(frames[i - 1], frames[i], bg, scrollDir)
      xPositions.push(xPositions[i - 1] + offset)
      nccScores.push(nccScore)
      dyRaw.push(dy)
    }

    // -----------------------------------------------------------------------
    // Phase 3: Sort frames by panorama position, normalise to min = 0.
    // -----------------------------------------------------------------------
    const order = xPositions
      .map((x, i) => ({ x, i }))
      .sort((a, b) => a.x - b.x)

    const minX = order[0].x
    const sortedFrames  = order.map(o => frames[o.i])
    const sortedX       = order.map(o => o.x - minX)
    const sortedNcc     = order.map(o => nccScores[o.i])

    // Accumulate vertical offsets in the sorted order and convert to pixels.
    // dyRaw[i] is the dy needed to align frame i to frame i-1.
    // We accumulate in TIME order, then reorder for compositing.
    const dyAccTime: number[] = [0]  // cumulative dy in time order (thumb rows)
    for (let i = 1; i < n; i++) dyAccTime.push(dyAccTime[i - 1] + dyRaw[i])
    const fh = frames[0].height
    const sortedYOff = order.map(o => Math.round(dyAccTime[o.i] * (fh / TH)))

    // -----------------------------------------------------------------------
    // Phase 4: Composite (70%–88%)
    // -----------------------------------------------------------------------
    for (let fi = 0; fi < n; fi++) {
      post({ type: 'progress', step: `Blending frame ${fi + 1} of ${n}…`, percent: Math.round(70 + (fi / n) * 18) })
    }
    const stitched = composite(sortedFrames, sortedX, sortedYOff)

    post({ type: 'progress', step: 'Cropping…', percent: 90 })
    const cropped = cropToContent(stitched)
    const result  = cropBackground(cropped, bg)

    // -----------------------------------------------------------------------
    // Debug info — map back to original frame order.
    // -----------------------------------------------------------------------
    const fw = frames[0].width
    const debugFrames: FrameDebugInfo[] = sortedX.map((xPos, si) => {
      const origIdx = order[si].i
      const prevEnd = si > 0 ? sortedX[si - 1] + fw : xPos
      const overlapPx = Math.max(0, prevEnd - xPos)
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
