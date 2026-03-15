/**
 * unwrap.worker.ts
 *
 * Six-point cylindrical label unwrapper.
 *
 * Given a single photo and 6 boundary points (in pixel coordinates):
 *   A = top-left,  B = top-arc apex,    C = top-right
 *   D = bottom-right, E = bottom-arc apex, F = bottom-left
 *
 * Fits parabolic arcs to top (A→B→C) and bottom (F→E→D), builds a
 * COLS×ROWS mesh, and inverse-maps each output pixel through the mesh
 * using bilinear interpolation.
 */

export interface Point2D {
  x: number
  y: number
}

export interface UnwrapInput {
  type: 'unwrap'
  frame: ImageData
  /** 6 points in pixel coordinates: [A, B, C, D, E, F] */
  points: [Point2D, Point2D, Point2D, Point2D, Point2D, Point2D]
}

type WorkerMessage =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'result'; imageData: ImageData }
  | { type: 'error'; message: string }

/** Mesh resolution */
const COLS = 40
const ROWS = 30

/**
 * Fit a parabola through (left, apex, right) where apex is the curve peak.
 * Returns f(x) = p*(x − apex.x)² + apex.y
 */
function makeArcFn(left: Point2D, apex: Point2D, _right: Point2D): (x: number) => number {
  const dx = left.x - apex.x
  const p = dx * dx > 0.01 ? (left.y - apex.y) / (dx * dx) : 0
  return (x: number) => p * (x - apex.x) * (x - apex.x) + apex.y
}

/** Generate count evenly-spaced points in x from xStart→xEnd, y from arcFn. */
function buildArcPoints(xStart: number, xEnd: number, count: number, arcFn: (x: number) => number): Point2D[] {
  const pts: Point2D[] = []
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0
    const x = xStart + t * (xEnd - xStart)
    pts.push({ x, y: arcFn(x) })
  }
  return pts
}

/** Bilinear sample from RGBA data into output buffer at index oi. */
function sampleBilinear(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  out: Uint8ClampedArray,
  oi: number,
): void {
  const x0 = Math.max(0, Math.min(Math.floor(sx), w - 1))
  const y0 = Math.max(0, Math.min(Math.floor(sy), h - 1))
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const fx = sx - Math.floor(sx)
  const fy = sy - Math.floor(sy)
  const cx = 1 - fx
  const cy = 1 - fy
  const i00 = (y0 * w + x0) * 4
  const i10 = (y0 * w + x1) * 4
  const i01 = (y1 * w + x0) * 4
  const i11 = (y1 * w + x1) * 4
  out[oi]     = cx * cy * data[i00]     + fx * cy * data[i10]     + cx * fy * data[i01]     + fx * fy * data[i11]
  out[oi + 1] = cx * cy * data[i00 + 1] + fx * cy * data[i10 + 1] + cx * fy * data[i01 + 1] + fx * fy * data[i11 + 1]
  out[oi + 2] = cx * cy * data[i00 + 2] + fx * cy * data[i10 + 2] + cx * fy * data[i01 + 2] + fx * fy * data[i11 + 2]
  out[oi + 3] = cx * cy * data[i00 + 3] + fx * cy * data[i10 + 3] + cx * fy * data[i01 + 3] + fx * fy * data[i11 + 3]
}

self.onmessage = function (event: MessageEvent<UnwrapInput>) {
  const { frame, points } = event.data
  const [A, B, C, D, E, F] = points

  try {
    postMessage({ type: 'progress', step: 'Building mesh…', percent: 10 } satisfies WorkerMessage)

    // Arc functions: parabola through the 3 control points
    const topFn = makeArcFn(A, B, C)   // top arc: A (left) → B (apex/top) → C (right)
    const botFn = makeArcFn(F, E, D)   // bottom arc: F (left) → E (apex/bottom) → D (right)

    // Arc sample points (COLS each)
    const topPts = buildArcPoints(A.x, C.x, COLS, topFn)
    const botPts = buildArcPoints(F.x, D.x, COLS, botFn)

    // Build COLS × ROWS source mesh: mesh[ci][ri] = pixel coord in source image
    // ri=0 → top arc, ri=ROWS-1 → bottom arc
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

    // Output dimensions — preserve approximate pixel extent of the label
    const outW = Math.max(1, Math.round(Math.abs(C.x - A.x)))
    const labelHLeft  = Math.abs(F.y - A.y)
    const labelHRight = Math.abs(D.y - C.y)
    const labelHMid   = Math.abs(E.y - B.y)
    const outH = Math.max(1, Math.round((labelHLeft + labelHRight + labelHMid) / 3))

    postMessage({ type: 'progress', step: 'Unwrapping…', percent: 20 } satisfies WorkerMessage)

    const outData = new Uint8ClampedArray(outW * outH * 4)
    const srcData = frame.data as Uint8ClampedArray

    for (let dy = 0; dy < outH; dy++) {
      if (dy % 40 === 0) {
        const pct = 20 + Math.round((dy / outH) * 75)
        postMessage({ type: 'progress', step: `Unwrapping… ${Math.round((dy / outH) * 100)}%`, percent: pct } satisfies WorkerMessage)
      }

      // Row position in mesh space
      const rowF = (outH > 1 ? dy / (outH - 1) : 0) * (ROWS - 1)
      const ri = Math.min(Math.floor(rowF), ROWS - 2)
      const rowFrac = rowF - ri

      for (let dx = 0; dx < outW; dx++) {
        // Column position in mesh space
        const colF = (outW > 1 ? dx / (outW - 1) : 0) * (COLS - 1)
        const ci = Math.min(Math.floor(colF), COLS - 2)
        const colFrac = colF - ci

        // Bilinear interpolation through the 4 surrounding mesh vertices
        const tl = mesh[ci][ri]
        const tr = mesh[ci + 1][ri]
        const bl = mesh[ci][ri + 1]
        const br = mesh[ci + 1][ri + 1]
        const u = colFrac, v = rowFrac
        const sx = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + (1 - u) * v * bl.x + u * v * br.x
        const sy = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + (1 - u) * v * bl.y + u * v * br.y

        if (sx < 0 || sx >= frame.width || sy < 0 || sy >= frame.height) continue

        sampleBilinear(srcData, frame.width, frame.height, sx, sy, outData, (dy * outW + dx) * 4)
      }
    }

    postMessage({ type: 'progress', step: 'Done!', percent: 100 } satisfies WorkerMessage)

    const result = new ImageData(outData, outW, outH)
    postMessage(
      { type: 'result', imageData: result } satisfies WorkerMessage,
      [result.data.buffer as ArrayBuffer],
    )
  } catch (err) {
    postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerMessage)
  }
}
