/**
 * stitcher.worker.ts
 *
 * Panorama stitching for cylindrical label unwrapping.
 *
 * Key design decisions:
 * - Background colour is sampled from the corners of the first frame and used
 *   throughout: background pixels are zeroed in NCC thumbnails so only label
 *   features drive overlap detection, and the same colour is used to crop the
 *   final panorama.
 * - Overlap detection uses background-subtracted thumbnails. No cosine
 *   weighting — the label is not always centred, and cosine de-emphasises
 *   off-centre content. Instead, a foreground column mask ensures NCC only
 *   runs at overlap values where label pixels are present in both strips.
 * - Compositing uses a Voronoi centre-strip approach with per-pixel cylindrical
 *   y-correction to remove vertical foreshortening.
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

// Colour distance (squared) threshold for background classification.
// 50 units of Euclidean RGB distance — raised from 40 to eliminate cloth-texture false positives.
const BG_THRESH_SQ = 50 * 50

// Small prior added to NCC score that increases with overlap width.
// Encodes that objects don't usually jump 80% of frame width between frames.
const OVERLAP_PRIOR = 0.10

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Normalised cross-correlation of two equal-length arrays. */
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
 * Sample the background colour from the four corners of a frame.
 * Corners are sampled because the label never reaches the very edges.
 */
function sampleBackground(frame: ImageData): BgColor {
  const { width, height, data } = frame
  const PATCH = 12
  let r = 0, g = 0, b = 0, n = 0
  const origins = [
    [0, 0],
    [width - PATCH, 0],
    [0, height - PATCH],
    [width - PATCH, height - PATCH],
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
 * Downsample an ImageData to a background-subtracted grayscale Float32Array.
 *
 * Pixels within BG_THRESH_SQ of the background colour are set to 0.
 * Only label pixels contribute — no cosine weighting, because the label
 * is not always centred and cosine de-emphasises off-centre content.
 */
function buildThumb(
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
          const dr = data[i]     - bgR
          const dg = data[i + 1] - bgG
          const db = data[i + 2] - bgB
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
 * Returns which thumbnail columns contain any foreground pixel.
 * Only considers the top 75% of rows — the bottom quarter often
 * contains hands holding the object, which creates false foreground.
 */
function buildColMask(thumb: Float32Array, tw: number, th: number): Uint8Array {
  const mask = new Uint8Array(tw)
  const maxRow = Math.floor(th * 0.75)
  for (let ty = 0; ty < maxRow; ty++)
    for (let tx = 0; tx < tw; tx++)
      if (thumb[ty * tw + tx] > 0) mask[tx] = 1
  return mask
}

/** Horizontal centroid of the foreground columns (for fallback). */
function colCentroid(mask: Uint8Array, tw: number): number {
  let xSum = 0, n = 0
  for (let x = 0; x < tw; x++) if (mask[x]) { xSum += x; n++ }
  return n > 0 ? xSum / n : tw / 2
}

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

/**
 * Find the horizontal offset between two adjacent frames.
 *
 * Strategy:
 *   1. Build background-subtracted thumbnails (label pixels only, no cosine).
 *   2. For each candidate overlap, check how many columns have foreground
 *      content in BOTH the right-strip of A and left-strip of B.
 *      Skip candidates with fewer than 3 matching foreground columns —
 *      there's no label signal to correlate.
 *   3. Run NCC only on candidates that passed step 2.
 *   4. If no candidate passed (frames share no visible label content),
 *      fall back to the centroid difference as a rough estimate.
 *
 * "offset" = how far right frameB starts relative to frameA's left edge.
 * overlap  = frameWidth − offset.
 */
function findOffset(
  frameA: ImageData,
  frameB: ImageData,
  bg: BgColor,
): { offset: number; nccScore: number } {
  const fw = frameA.width
  const TW = 96, TH = 54

  const tA = buildThumb(frameA, TW, TH, bg)
  const tB = buildThumb(frameB, TW, TH, bg)
  const maskA = buildColMask(tA, TW, TH)
  const maskB = buildColMask(tB, TW, TH)

  const minOvlp = Math.round(TW * 0.05)
  const maxOvlp = Math.round(TW * 0.92)

  let bestOvlp = -1
  let bestScore = -Infinity

  for (let ovlp = minOvlp; ovlp <= maxOvlp; ovlp++) {
    // How many columns in this overlap window have label pixels in BOTH frames?
    let fgCols = 0
    for (let x = 0; x < ovlp; x++)
      if (maskA[TW - ovlp + x] && maskB[x]) fgCols++
    if (fgCols < 3) continue  // no usable label signal at this overlap

    const rA = new Float32Array(ovlp * TH)
    const rB = new Float32Array(ovlp * TH)
    for (let y = 0; y < TH; y++)
      for (let x = 0; x < ovlp; x++) {
        rA[y * ovlp + x] = tA[y * TW + (TW - ovlp + x)]
        rB[y * ovlp + x] = tB[y * TW + x]
      }
    const s = ncc(rA, rB) + OVERLAP_PRIOR * (ovlp / TW)
    if (s > bestScore) { bestScore = s; bestOvlp = ovlp }
  }

  if (bestOvlp === -1) {
    // Fallback: estimate offset from how far the label centroid shifted
    const cA = colCentroid(maskA, TW)
    const cB = colCentroid(maskB, TW)
    const offset = Math.max(0, Math.round(((cA - cB) / TW) * fw))
    return { offset, nccScore: 0 }
  }

  const offset = Math.round(((TW - bestOvlp) / TW) * fw)
  return { offset, nccScore: Math.round(bestScore * 1000) / 1000 }
}

// ---------------------------------------------------------------------------
// Compositing — cylindrical centre-strip projection
// ---------------------------------------------------------------------------

/**
 * Build the flat label image using a centre-strip cylindrical projection.
 *
 * Each frame "owns" the panorama region between the midpoints with its
 * neighbours (Voronoi-style). For each owned output pixel we:
 *   1. Find its source x in the owning frame's local coordinates.
 *   2. Compute the viewing angle: θ = atan((src_x − cx) / f)
 *   3. Apply cylindrical y-correction: src_y = cy + (oy − cy) / cos(θ)
 *      This removes the vertical foreshortening that makes horizontal
 *      label features appear to curve up/down at the cylinder edges.
 *   4. Bilinear-sample from the source frame.
 *
 * Focal length f is estimated assuming 60° horizontal FOV (typical portrait
 * phone). Adjust FOV_DEG if the result looks too compressed or stretched.
 */
const FOV_DEG = 60
const FOV_RAD = (FOV_DEG * Math.PI) / 180

function composite(frames: ImageData[], xPositions: number[]): ImageData {
  const n = frames.length
  const fw = frames[0].width
  const fh = frames[0].height
  const cx = fw / 2
  const cy = fh / 2
  const f = fw / (2 * Math.tan(FOV_RAD / 2))

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

        const theta = Math.atan((srcX - cx) / f)
        const srcY = cy + (oy - cy) / Math.cos(theta)
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
// Crop
// ---------------------------------------------------------------------------

/** Crop to non-transparent pixels (removes gaps left by cylindrical warp). */
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

/**
 * Crop the panorama to the rows that contain the object, removing the
 * uniform background above and below.
 *
 * Uses the pre-sampled background colour (from the source frame corners)
 * rather than sampling the panorama corners, which are black/transparent.
 */
function cropBackground(img: ImageData, bg: BgColor): ImageData {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg

  // A row is "background" if ≥75% of its pixels match the bg colour
  const BG_ROW_FRAC = 0.75
  function isBackgroundRow(y: number): boolean {
    let bgCount = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const dr = data[i]     - bgR
      const dg = data[i + 1] - bgG
      const db = data[i + 2] - bgB
      if (dr * dr + dg * dg + db * db < BG_THRESH_SQ) bgCount++
    }
    return bgCount / width >= BG_ROW_FRAC
  }

  let y0 = 0
  while (y0 < height && isBackgroundRow(y0)) y0++
  let y1 = height - 1
  while (y1 > y0 && isBackgroundRow(y1)) y1--

  // If we couldn't strip at least 5% — background wasn't detectable, return as-is
  if (y0 === 0 && y1 === height - 1) return img
  if (y1 - y0 < height * 0.1) return img

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
    const post = (o: WorkerOutput) => self.postMessage(o)

    // Sample background colour once from the first frame's corners.
    // All subsequent steps (NCC and crop) use this same colour.
    post({ type: 'progress', step: 'Detecting background…', percent: 28 })
    const bg = sampleBackground(frames[0])

    // Phase 1: find overlaps (30%–70%)
    const xPositions: number[] = [0]
    const nccScores: number[] = [0]
    for (let i = 1; i < n; i++) {
      const pct = Math.round(30 + ((i - 1) / (n - 1)) * 40)
      post({ type: 'progress', step: `Aligning frame ${i + 1} of ${n}…`, percent: pct })
      const { offset, nccScore } = findOffset(frames[i - 1], frames[i], bg)
      xPositions.push(xPositions[i - 1] + offset)
      nccScores.push(nccScore)
    }

    // Phase 2: composite (70%–88%)
    for (let fi = 0; fi < n; fi++) {
      const pct = Math.round(70 + (fi / n) * 18)
      post({ type: 'progress', step: `Blending frame ${fi + 1} of ${n}…`, percent: pct })
    }
    const stitched = composite(frames, xPositions)

    post({ type: 'progress', step: 'Cropping…', percent: 90 })
    const cropped = cropToContent(stitched)
    const result = cropBackground(cropped, bg)

    const fw = frames[0].width
    const debugInfo: StitchDebugInfo = {
      frameWidth: fw,
      frameHeight: frames[0].height,
      panoramaWidth: result.width,
      frames: xPositions.map((xPos, i) => {
        const prevEnd = i > 0 ? xPositions[i - 1] + fw : xPos
        const overlapPx = Math.max(0, prevEnd - xPos)
        return {
          frameIndex: i,
          xPosition: xPos,
          overlapWithPrev: overlapPx,
          overlapPct: Math.round((overlapPx / fw) * 100),
          nccScore: nccScores[i],
        }
      }),
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
