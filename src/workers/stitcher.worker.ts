/**
 * stitcher.worker.ts
 *
 * Web Worker that implements panorama stitching + cylindrical unwarp
 * using pure TypeScript (no OpenCV dependency).
 */

type WorkerInput = { type: 'stitch'; frames: ImageData[] }

type WorkerOutput =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'result'; imageData: ImageData }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bilinear interpolation of a single channel value at fractional (x, y). */
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

  const idx00 = (y0 * width + x0) * 4 + channel
  const idx10 = (y0 * width + x1) * 4 + channel
  const idx01 = (y1 * width + x0) * 4 + channel
  const idx11 = (y1 * width + x1) * 4 + channel

  const top = data[idx00] * (1 - fx) + data[idx10] * fx
  const bot = data[idx01] * (1 - fx) + data[idx11] * fx
  return top * (1 - fy) + bot * fy
}

/** Clamp a number to [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

// ---------------------------------------------------------------------------
// Step 1 – findOffset
// ---------------------------------------------------------------------------

/**
 * Estimate the horizontal overlap offset between two adjacent frames.
 * We take a vertical strip from the right edge of frameA and slide it
 * against strips at various positions in frameB, minimising SAD.
 *
 * Returns the number of pixels frameB should be placed to the right of frameA's
 * left edge (i.e., frameA starts at 0, frameB starts at `offset`).
 */
function findOffset(frameA: ImageData, frameB: ImageData): number {
  const w = frameA.width
  const h = frameA.height
  const stripW = Math.max(8, Math.round(w * 0.05)) // 5% strip width
  const maxOverlap = Math.round(w * 0.7) // search up to 70% overlap

  // Vertical sampling: use the middle third to avoid edge artifacts
  const yStart = Math.floor(h * 0.33)
  const yEnd = Math.floor(h * 0.67)
  const rows = yEnd - yStart

  // Pre-extract the reference strip from the RIGHT edge of frameA
  // We'll compare against strips starting at position `s` from the LEFT of frameB
  let bestOffset = w // default: no overlap
  let bestSAD = Infinity

  // offset = how far to the right frameB starts relative to frameA's left
  // overlap = w - offset (pixels that overlap)
  // We want offset in [w - maxOverlap, w]
  const minOffset = w - maxOverlap

  for (let offset = minOffset; offset <= w; offset += 2) {
    const overlap = w - offset
    if (overlap <= 0) break

    // The reference strip position in frameA: right side starting at (w - overlap)
    const refXInA = w - overlap
    // The comparison strip position in frameB: left side, same width (overlap pixels, but we only check stripW of them)
    const checkW = Math.min(stripW, overlap)

    let sad = 0
    for (let dy = 0; dy < rows; dy++) {
      const row = yStart + dy
      for (let dx = 0; dx < checkW; dx++) {
        const axA = refXInA + dx
        const axB = dx // same relative position in frameB's overlap zone
        const idxA = (row * w + axA) * 4
        const idxB = (row * w + axB) * 4
        // Use luminance approximation: 0.299R + 0.587G + 0.114B
        const lumA =
          0.299 * frameA.data[idxA] +
          0.587 * frameA.data[idxA + 1] +
          0.114 * frameA.data[idxA + 2]
        const lumB =
          0.299 * frameB.data[idxB] +
          0.587 * frameB.data[idxB + 1] +
          0.114 * frameB.data[idxB + 2]
        sad += Math.abs(lumA - lumB)
      }
    }

    // Normalize by number of samples
    const normSAD = sad / (rows * checkW)
    if (normSAD < bestSAD) {
      bestSAD = normSAD
      bestOffset = offset
    }
  }

  return bestOffset
}

// ---------------------------------------------------------------------------
// Step 2 – stitchFrames
// ---------------------------------------------------------------------------

function stitchFrames(frames: ImageData[]): ImageData {
  if (frames.length === 0) {
    throw new Error('No frames to stitch')
  }
  if (frames.length === 1) {
    return frames[0]
  }

  const h = frames[0].height
  const w = frames[0].width

  // Compute pairwise offsets (where each frame starts relative to the previous)
  const offsets: number[] = [0]
  for (let i = 1; i < frames.length; i++) {
    const off = findOffset(frames[i - 1], frames[i])
    offsets.push(offsets[i - 1] + off)
  }

  // Total canvas width
  const lastFrameEnd = offsets[offsets.length - 1] + w
  const canvasW = lastFrameEnd

  const out = new ImageData(canvasW, h)
  const outData = out.data

  // Accumulator for alpha blending: store [R, G, B, weight] per pixel
  // We'll use two passes: first accumulate, then normalize
  const accum = new Float32Array(canvasW * h * 4).fill(0)

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi]
    const xStart = offsets[fi]
    const xEnd = xStart + w

    // Overlap with previous frame: overlap region is [xStart, prevEnd]
    const prevEnd = fi > 0 ? offsets[fi - 1] + w : xStart
    const overlapStart = xStart
    const overlapEnd = Math.min(prevEnd, xEnd)
    const overlapW = Math.max(0, overlapEnd - overlapStart)

    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const globalX = xStart + px
        if (globalX < 0 || globalX >= canvasW) continue

        const srcIdx = (py * w + px) * 4
        const dstIdx = (py * canvasW + globalX) * 4

        // Compute blend weight based on position within overlap
        let weight = 1.0
        if (overlapW > 0 && globalX < overlapEnd && globalX >= overlapStart) {
          // Linear blend: 0 at start of overlap → 1 at end of overlap
          const t = (globalX - overlapStart) / overlapW
          weight = t
        }

        accum[dstIdx] += frame.data[srcIdx] * weight
        accum[dstIdx + 1] += frame.data[srcIdx + 1] * weight
        accum[dstIdx + 2] += frame.data[srcIdx + 2] * weight
        accum[dstIdx + 3] += weight
      }
    }
  }

  // Normalize
  for (let i = 0; i < canvasW * h; i++) {
    const base = i * 4
    const w4 = accum[base + 3]
    if (w4 > 0) {
      outData[base] = Math.round(clamp(accum[base] / w4, 0, 255))
      outData[base + 1] = Math.round(clamp(accum[base + 1] / w4, 0, 255))
      outData[base + 2] = Math.round(clamp(accum[base + 2] / w4, 0, 255))
      outData[base + 3] = 255
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Step 3 – cylindricalUnwarp
// ---------------------------------------------------------------------------

/**
 * Cylindrical unwarp: maps each output pixel through an inverse cylindrical
 * projection to find its source coordinates, then bilinear-interpolates.
 *
 * Forward model: a point on the cylinder at angle theta maps to image x via
 *   x_img = f * tan(theta) + cx
 *   y_img = y * sec(theta)    (with vertical scaling from cylinder height)
 *
 * Inverse (given output pixel (ox, oy) on the "flat" panorama):
 *   theta = (ox - cx) / f
 *   src_x = f * tan(theta) + cx
 *   src_y = oy / cos(theta)
 */
function cylindricalUnwarp(img: ImageData): ImageData {
  const { width, height, data } = img
  const cx = width / 2
  const cy = height / 2

  // FOV = 60 degrees → f = w / (2 * tan(FOV/2))
  const FOV_RAD = (60 * Math.PI) / 180
  const f = width / (2 * Math.tan(FOV_RAD / 2))

  const out = new ImageData(width, height)
  const outData = out.data

  for (let oy = 0; oy < height; oy++) {
    for (let ox = 0; ox < width; ox++) {
      const theta = (ox - cx) / f
      const srcX = f * Math.tan(theta) + cx
      const srcY = (oy - cy) / Math.cos(theta) + cy

      const dstIdx = (oy * width + ox) * 4

      if (srcX < 0 || srcX >= width - 1 || srcY < 0 || srcY >= height - 1) {
        // Out of bounds — leave transparent black (already 0 from ImageData init)
        outData[dstIdx + 3] = 0
        continue
      }

      outData[dstIdx] = Math.round(bilinearSample(data, width, height, srcX, srcY, 0))
      outData[dstIdx + 1] = Math.round(bilinearSample(data, width, height, srcX, srcY, 1))
      outData[dstIdx + 2] = Math.round(bilinearSample(data, width, height, srcX, srcY, 2))
      outData[dstIdx + 3] = 255
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Crop transparent edges
// ---------------------------------------------------------------------------

function cropToOpaque(img: ImageData): ImageData {
  const { width, height, data } = img
  let minX = width
  let maxX = 0
  let minY = height
  let maxY = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (minX > maxX || minY > maxY) return img // nothing to crop

  const newW = maxX - minX + 1
  const newH = maxY - minY + 1
  const cropped = new ImageData(newW, newH)

  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcIdx = ((minY + y) * width + (minX + x)) * 4
      const dstIdx = (y * newW + x) * 4
      cropped.data[dstIdx] = data[srcIdx]
      cropped.data[dstIdx + 1] = data[srcIdx + 1]
      cropped.data[dstIdx + 2] = data[srcIdx + 2]
      cropped.data[dstIdx + 3] = data[srcIdx + 3]
    }
  }

  return cropped
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.addEventListener('message', (event: MessageEvent<WorkerInput>) => {
  const msg = event.data

  if (msg.type === 'stitch') {
    try {
      const { frames } = msg

      if (!frames || frames.length === 0) {
        const out: WorkerOutput = { type: 'error', message: 'No frames provided' }
        self.postMessage(out)
        return
      }

      const post = (output: WorkerOutput) => self.postMessage(output)

      post({ type: 'progress', step: 'Analyzing frames...', percent: 10 })

      // Short yield to allow the progress message to flush
      // (workers are single-threaded, but postMessage is async on the receiving end)

      post({ type: 'progress', step: 'Finding overlaps...', percent: 30 })

      post({ type: 'progress', step: 'Stitching...', percent: 60 })
      const stitched = stitchFrames(frames)

      post({ type: 'progress', step: 'Unwarping...', percent: 80 })
      const unwarped = cylindricalUnwarp(stitched)
      const cropped = cropToOpaque(unwarped)

      post({ type: 'progress', step: 'Done', percent: 100 })
      const result: WorkerOutput = { type: 'result', imageData: cropped }
      // Transfer the underlying ArrayBuffer to avoid copying large data
      self.postMessage(result, { transfer: [cropped.data.buffer] })
    } catch (err) {
      const out: WorkerOutput = {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      }
      self.postMessage(out)
    }
  } else {
    const out: WorkerOutput = {
      type: 'error',
      message: `Unknown message type: ${(msg as { type: string }).type}`,
    }
    self.postMessage(out)
  }
})

export {}
