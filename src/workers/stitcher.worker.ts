/**
 * stitcher.worker.ts
 *
 * Panorama stitching for cylindrical label unwrapping.
 *
 * Key design decisions:
 * - Overlap detection uses downsampled full-frame thumbnails with a cosine
 *   horizontal weight. This makes the bottle (centre of frame) dominate the
 *   NCC comparison and suppresses the static background (frame edges).
 * - No barrel correction — it creates transparent edge artefacts and makes
 *   the matching harder without meaningful quality benefit for phone cameras.
 * - Compositing uses a per-pixel cosine centre-weight so background pixels at
 *   the frame edges contribute less to the final blend.
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
 * Downsample an ImageData to a grayscale Float32Array of size tw×th,
 * then multiply each column by a cosine horizontal weight so that the
 * centre columns (where the bottle lives) have weight ≈1 and the edge
 * columns (background) have weight ≈0.
 */
function buildWeightedThumb(img: ImageData, tw: number, th: number): Float32Array {
  const { width, height, data } = img
  const out = new Float32Array(tw * th)

  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty / th) * height)
    const y1 = Math.floor(((ty + 1) / th) * height)

    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx / tw) * width)
      const x1 = Math.floor(((tx + 1) / tw) * width)

      let sum = 0, cnt = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          cnt++
        }
      }

      // Cosine centre-weight: 0 at edges, 1 at centre
      const w = 0.5 - 0.5 * Math.cos(Math.PI * tx / (tw - 1))
      out[ty * tw + tx] = (cnt > 0 ? sum / cnt : 0) * w
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

/**
 * Find the horizontal offset between two adjacent frames using NCC on
 * downsampled, centre-weighted thumbnails.
 *
 * "offset" = how far right frameB starts relative to frameA's left edge.
 * overlap  = frameWidth − offset.
 */
function findOffset(frameA: ImageData, frameB: ImageData): { offset: number; nccScore: number } {
  const fw = frameA.width

  // Thumbnail: 96 columns × 54 rows preserves 16:9 structure and is fast
  const TW = 96, TH = 54
  const tA = buildWeightedThumb(frameA, TW, TH)
  const tB = buildWeightedThumb(frameB, TW, TH)

  // Search overlap from 10% to 80% of frame width
  const minOvlp = Math.round(TW * 0.10)
  const maxOvlp = Math.round(TW * 0.80)

  let bestOvlp = minOvlp
  let bestScore = -Infinity

  for (let ovlp = minOvlp; ovlp <= maxOvlp; ovlp++) {
    // Extract the right `ovlp` columns of tA and left `ovlp` columns of tB
    const rA = new Float32Array(ovlp * TH)
    const rB = new Float32Array(ovlp * TH)
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < ovlp; x++) {
        rA[y * ovlp + x] = tA[y * TW + (TW - ovlp + x)]
        rB[y * ovlp + x] = tB[y * TW + x]
      }
    }
    const s = ncc(rA, rB)
    if (s > bestScore) { bestScore = s; bestOvlp = ovlp }
  }

  // Scale back to full frame pixels
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
 *      label features (like the yellow line) appear to curve up/down at
 *      the edges of the cylinder.
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
  // Focal length in pixels for the given FOV
  const f = fw / (2 * Math.tan(FOV_RAD / 2))

  // Determine each frame's ownership zone in panorama coordinates
  // (midpoint between adjacent frame centres)
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
        // Source x in frame i's local coordinates
        const srcX = (gx + panoOrigin) - xPositions[i]
        if (srcX < 0 || srcX >= fw - 1) continue

        // Cylindrical y-correction
        const theta = Math.atan((srcX - cx) / f)
        const srcY = cy + (oy - cy) / Math.cos(theta)
        if (srcY < 0 || srcY >= fh - 1) continue

        // Bilinear interpolation
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

    // Phase 1: find overlaps (30%–70%)
    const xPositions: number[] = [0]
    const nccScores: number[] = [0]
    for (let i = 1; i < n; i++) {
      const pct = Math.round(30 + ((i - 1) / (n - 1)) * 40)
      post({ type: 'progress', step: `Aligning frame ${i + 1} of ${n}…`, percent: pct })
      const { offset, nccScore } = findOffset(frames[i - 1], frames[i])
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
    const result = cropToContent(stitched)

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
