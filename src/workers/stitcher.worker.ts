/**
 * stitcher.worker.ts
 *
 * Web Worker: panorama stitching via SAD-based overlap detection + alpha blending.
 * No cylindrical unwarp on the full panorama — phone camera FOV is small enough
 * (~60–70°) that individual frames are already nearly flat. Applying the unwarp
 * to a multi-frame-wide panorama causes extreme tan() divergence at the edges.
 */

type WorkerInput = { type: 'stitch'; frames: ImageData[] }

type WorkerOutput =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'result'; imageData: ImageData }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** Bilinear interpolation of a single channel at fractional (x, y). */
function bilinearSample(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number,
): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, width - 1)
  const y1 = Math.min(y0 + 1, height - 1)
  const fx = x - x0
  const fy = y - y0
  const v00 = data[(y0 * width + x0) * 4 + channel]
  const v10 = data[(y0 * width + x1) * 4 + channel]
  const v01 = data[(y1 * width + x0) * 4 + channel]
  const v11 = data[(y1 * width + x1) * 4 + channel]
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy
}

/** Extract a grayscale (luminance) column strip from an ImageData. */
function extractStrip(
  img: ImageData,
  xStart: number,
  stripW: number,
  yStart: number,
  yEnd: number,
): Float32Array {
  const rows = yEnd - yStart
  const buf = new Float32Array(rows * stripW)
  for (let dy = 0; dy < rows; dy++) {
    for (let dx = 0; dx < stripW; dx++) {
      const x = xStart + dx
      const y = yStart + dy
      if (x < 0 || x >= img.width) { buf[dy * stripW + dx] = 0; continue }
      const i = (y * img.width + x) * 4
      buf[dy * stripW + dx] =
        0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
    }
  }
  return buf
}

/** Normalised cross-correlation between two equal-length Float32Arrays. */
function ncc(a: Float32Array, b: Float32Array): number {
  let sumA = 0, sumB = 0
  const n = a.length
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i] }
  const meanA = sumA / n
  const meanB = sumB / n
  let num = 0, denA = 0, denB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den < 1e-6 ? 0 : num / den
}

// ---------------------------------------------------------------------------
// Step 1 – findOffset
// ---------------------------------------------------------------------------

/**
 * Estimate the horizontal offset between two adjacent frames using NCC.
 *
 * "offset" = how far to the right frameB starts relative to frameA's left edge.
 * A fully non-overlapping pair has offset = frameWidth.
 * A pair with 30% overlap has offset = 0.7 * frameWidth.
 *
 * Strategy:
 *  1. Coarse search (step = 8 px) across 10–80% overlap range
 *  2. Fine search (step = 1 px) in a ±32 px window around the coarse best
 *
 * We compare a 20%-wide strip from the right edge of A against the same-width
 * strip from the left edge of B's overlap region.
 */
function findOffset(frameA: ImageData, frameB: ImageData): number {
  const fw = frameA.width
  const fh = frameA.height

  // Use the middle 60% of rows to avoid letterbox/black borders
  const yStart = Math.floor(fh * 0.2)
  const yEnd = Math.floor(fh * 0.8)

  // Comparison strip width: 20% of frame width
  const stripW = Math.max(16, Math.round(fw * 0.20))

  // Overlap search range: 10% to 80% of frame width
  const minOverlap = Math.round(fw * 0.10)
  const maxOverlap = Math.round(fw * 0.80)

  // Pre-extract a strip from the left edge of frameB (0..stripW)
  const stripB = extractStrip(frameB, 0, stripW, yStart, yEnd)

  let bestOffset = fw  // default: no overlap
  let bestScore = -Infinity

  function evaluate(overlap: number): number {
    if (overlap < minOverlap || overlap > maxOverlap) return -Infinity
    // In frameA, the overlap region starts at (fw - overlap)
    // We compare the LEFT part of the overlap (first stripW pixels)
    const stripA = extractStrip(frameA, fw - overlap, stripW, yStart, yEnd)
    return ncc(stripA, stripB)
  }

  // Coarse pass
  const coarseStep = 8
  for (let overlap = minOverlap; overlap <= maxOverlap; overlap += coarseStep) {
    const score = evaluate(overlap)
    if (score > bestScore) {
      bestScore = score
      bestOffset = fw - overlap
    }
  }

  // Fine pass: ±32 px around coarse best
  const coarseBestOverlap = fw - bestOffset
  const fineStart = Math.max(minOverlap, coarseBestOverlap - 32)
  const fineEnd = Math.min(maxOverlap, coarseBestOverlap + 32)
  for (let overlap = fineStart; overlap <= fineEnd; overlap++) {
    const score = evaluate(overlap)
    if (score > bestScore) {
      bestScore = score
      bestOffset = fw - overlap
    }
  }

  return bestOffset
}

// ---------------------------------------------------------------------------
// Step 3 – per-frame barrel distortion correction (mild)
// ---------------------------------------------------------------------------

/**
 * Correct barrel/pincushion distortion on a single frame before stitching.
 * Uses a simple radial model: r_src = r_dst * (1 + k * r_dst²)
 * k is estimated from frame width assuming a typical phone FOV (~70°).
 * This is much milder than the full cylindrical unwarp and avoids
 * the divergence problem when applied to a wide panorama.
 */
function correctBarrel(img: ImageData): ImageData {
  const { width, height, data } = img
  const cx = width / 2
  const cy = height / 2
  // Barrel correction coefficient — tuned for ~70° diagonal FOV phone cameras
  // Positive k = barrel (outward), negative = pincushion
  const k = 0.15
  const R2 = Math.max(cx * cx, cy * cy) // normalisation radius²

  const out = new ImageData(width, height)
  const outData = out.data

  for (let oy = 0; oy < height; oy++) {
    for (let ox = 0; ox < width; ox++) {
      const dx = ox - cx
      const dy = oy - cy
      const r2 = (dx * dx + dy * dy) / R2
      const scale = 1 + k * r2
      const srcX = cx + dx * scale
      const srcY = cy + dy * scale

      const dstIdx = (oy * width + ox) * 4
      if (srcX < 0 || srcX >= width - 1 || srcY < 0 || srcY >= height - 1) {
        outData[dstIdx + 3] = 0
        continue
      }
      outData[dstIdx]     = Math.round(bilinearSample(data, width, height, srcX, srcY, 0))
      outData[dstIdx + 1] = Math.round(bilinearSample(data, width, height, srcX, srcY, 1))
      outData[dstIdx + 2] = Math.round(bilinearSample(data, width, height, srcX, srcY, 2))
      outData[dstIdx + 3] = 255
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Crop transparent / black edges
// ---------------------------------------------------------------------------

function cropToContent(img: ImageData): ImageData {
  const { width, height, data } = img
  let minX = width, maxX = 0, minY = height, maxY = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (minX > maxX || minY > maxY) return img

  const nw = maxX - minX + 1
  const nh = maxY - minY + 1
  const cropped = new ImageData(nw, nh)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const si = ((minY + y) * width + (minX + x)) * 4
      const di = (y * nw + x) * 4
      cropped.data[di]     = data[si]
      cropped.data[di + 1] = data[si + 1]
      cropped.data[di + 2] = data[si + 2]
      cropped.data[di + 3] = data[si + 3]
    }
  }
  return cropped
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.addEventListener('message', (event: MessageEvent<WorkerInput>) => {
  const msg = event.data

  if (msg.type !== 'stitch') {
    self.postMessage({ type: 'error', message: `Unknown message type: ${(msg as {type:string}).type}` } as WorkerOutput)
    return
  }

  try {
    const { frames } = msg

    if (!frames || frames.length === 0) {
      self.postMessage({ type: 'error', message: 'No frames provided' } as WorkerOutput)
      return
    }

    const post = (o: WorkerOutput) => self.postMessage(o)
    const n = frames.length

    // Phase 1: barrel correction — 5%–30%, one update per frame
    const corrected: ImageData[] = []
    for (let i = 0; i < n; i++) {
      const pct = Math.round(5 + (i / n) * 25)
      post({ type: 'progress', step: `Correcting frame ${i + 1} of ${n}…`, percent: pct })
      corrected.push(correctBarrel(frames[i]))
    }

    // Phase 2: find overlaps — 30%–60%, one update per frame pair
    const xPositions: number[] = [0]
    for (let i = 1; i < n; i++) {
      const pct = Math.round(30 + ((i - 1) / (n - 1)) * 30)
      post({ type: 'progress', step: `Aligning frame ${i + 1} of ${n}…`, percent: pct })
      const off = findOffset(corrected[i - 1], corrected[i])
      xPositions.push(xPositions[i - 1] + off)
    }

    // Phase 3: composite — 60%–85%, one update per frame
    post({ type: 'progress', step: 'Compositing…', percent: 60 })
    const fh = corrected[0].height
    const fw = corrected[0].width
    const totalW = xPositions[xPositions.length - 1] + fw
    const accum = new Float32Array(totalW * fh * 4)

    for (let fi = 0; fi < n; fi++) {
      const pct = Math.round(60 + (fi / n) * 25)
      post({ type: 'progress', step: `Blending frame ${fi + 1} of ${n}…`, percent: pct })

      const frame = corrected[fi]
      const xStart = xPositions[fi]
      const xEnd = xStart + fw
      const prevEnd = fi > 0 ? xPositions[fi - 1] + fw : xStart
      const overlapStart = xStart
      const overlapEnd = Math.min(prevEnd, xEnd)
      const overlapW = Math.max(0, overlapEnd - overlapStart)

      for (let py = 0; py < fh; py++) {
        for (let px = 0; px < fw; px++) {
          const gx = xStart + px
          if (gx < 0 || gx >= totalW) continue
          const srcIdx = (py * fw + px) * 4
          const dstIdx = (py * totalW + gx) * 4
          let weight = 1.0
          if (overlapW > 0 && gx >= overlapStart && gx < overlapEnd) {
            weight = (gx - overlapStart) / overlapW
          }
          accum[dstIdx]     += frame.data[srcIdx]     * weight
          accum[dstIdx + 1] += frame.data[srcIdx + 1] * weight
          accum[dstIdx + 2] += frame.data[srcIdx + 2] * weight
          accum[dstIdx + 3] += weight
        }
      }
    }

    // Normalise
    const stitched = new ImageData(totalW, fh)
    for (let i = 0; i < totalW * fh; i++) {
      const b = i * 4
      const wt = accum[b + 3]
      if (wt > 0) {
        stitched.data[b]     = Math.round(clamp(accum[b]     / wt, 0, 255))
        stitched.data[b + 1] = Math.round(clamp(accum[b + 1] / wt, 0, 255))
        stitched.data[b + 2] = Math.round(clamp(accum[b + 2] / wt, 0, 255))
        stitched.data[b + 3] = 255
      }
    }

    post({ type: 'progress', step: 'Cropping result…', percent: 88 })
    const result = cropToContent(stitched)

    post({ type: 'progress', step: 'Done', percent: 100 })
    self.postMessage({ type: 'result', imageData: result } as WorkerOutput, {
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
