/**
 * test-stitch.cjs
 *
 * Standalone Node.js test harness for the stitching algorithm.
 * Usage:  node test-data/test-stitch.cjs test-data/myvideo.mp4
 */

'use strict'
const { spawnSync } = require('child_process')
const path  = require('path')
const fs    = require('fs')
const { Jimp } = require('jimp')

const FFMPEG  = 'C:\\local\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe'
const FFPROBE = 'C:\\local\\ffmpeg-8.0.1-full_build\\bin\\ffprobe.exe'

const TARGET_FRAMES = 12
const BG_THRESH_SQ  = 50 * 50

// Vertical-shift search range in thumbnail rows (±MAX_DY).
const MAX_DY = 5

// ---------------------------------------------------------------------------
// Algorithm helpers
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

function ncc(a, b) {
  const n = a.length
  let sA = 0, sB = 0
  for (let i = 0; i < n; i++) { sA += a[i]; sB += b[i] }
  const mA = sA / n, mB = sB / n
  let num = 0, dA = 0, dB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB
    num += da * db; dA += da * da; dB += db * db
  }
  const den = Math.sqrt(dA * dB)
  return den < 1e-6 ? 0 : num / den
}

function sampleBackground(img) {
  const { width, height, data } = img
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

/** Background-subtracted luminance thumbnail. Used for the column-presence mask. */
function buildLumThumb(img, TW, TH, bg) {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg
  const out = new Float32Array(TW * TH)
  for (let ty = 0; ty < TH; ty++) {
    const y0 = Math.floor((ty / TH) * height)
    const y1 = Math.floor(((ty + 1) / TH) * height)
    for (let tx = 0; tx < TW; tx++) {
      const x0 = Math.floor((tx / TW) * width)
      const x1 = Math.floor(((tx + 1) / TW) * width)
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
      out[ty * TW + tx] = fgCnt > 0 ? sum / fgCnt : 0
    }
  }
  return out
}

/**
 * Horizontal-gradient magnitude of the luminance thumbnail.
 * White paper → near-zero; coloured line edges → strong peak.
 * This makes NCC peaks sharp only where features align.
 */
function buildGradThumb(lum, TW, TH) {
  const grad = new Float32Array(TW * TH)
  for (let ty = 0; ty < TH; ty++) {
    for (let tx = 0; tx < TW; tx++) {
      const l = tx > 0    ? lum[ty * TW + tx - 1] : lum[ty * TW + tx]
      const r = tx < TW-1 ? lum[ty * TW + tx + 1] : lum[ty * TW + tx]
      grad[ty * TW + tx] = Math.abs(r - l)
    }
  }
  return grad
}

function buildColMask(lum, TW, TH) {
  const mask = new Uint8Array(TW)
  const maxRow = Math.floor(TH * 0.75)  // ignore bottom 25% — hands
  for (let ty = 0; ty < maxRow; ty++)
    for (let tx = 0; tx < TW; tx++)
      if (lum[ty * TW + tx] > 0) mask[tx] = 1
  return mask
}

function colCentroid(mask, TW) {
  let xSum = 0, n = 0
  for (let x = 0; x < TW; x++) if (mask[x]) { xSum += x; n++ }
  return n > 0 ? xSum / n : TW / 2
}

/**
 * Estimate the scroll direction between two frames using 1-D cross-correlation
 * of column-gradient sums.
 *
 * Returns the shift (in thumb columns) of B relative to A:
 *   positive → features moved RIGHT (label scrolls right, use rev direction)
 *   negative → features moved LEFT  (label scrolls left,  use fwd direction)
 */
function estimateColShift(tA, tB, TW, TH) {
  // Column-sum of the gradient thumbnail (1-D feature profile)
  const sA = new Float32Array(TW)
  const sB = new Float32Array(TW)
  const maxRow = Math.floor(TH * 0.75)
  for (let tx = 0; tx < TW; tx++)
    for (let ty = 0; ty < maxRow; ty++) {
      sA[tx] += tA[ty * TW + tx]
      sB[tx] += tB[ty * TW + tx]
    }

  // 1-D NCC across all shifts  [-TW+1 .. TW-1]
  // We search only the inner range to avoid the boundary artefact
  const maxShift = Math.round(TW * 0.80)  // can't shift by >80% of width
  let bestShift = 0, bestNCC = -Infinity
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    let n = 0, mA = 0, mB = 0
    for (let x = 0; x < TW; x++) {
      const xB = x + shift
      if (xB < 0 || xB >= TW) continue
      mA += sA[x]; mB += sB[xB]; n++
    }
    if (n < 10) continue
    mA /= n; mB /= n
    let num = 0, dA = 0, dB = 0
    for (let x = 0; x < TW; x++) {
      const xB = x + shift
      if (xB < 0 || xB >= TW) continue
      const da = sA[x] - mA, db = sB[xB] - mB
      num += da * db; dA += da * da; dB += db * db
    }
    const den = Math.sqrt(dA * dB)
    const s = den < 1e-6 ? 0 : num / den
    if (s > bestNCC) { bestNCC = s; bestShift = shift }
  }
  return bestShift
}

/**
 * Detect global scroll direction from the first few pairs.
 * Returns +1 for "label scrolls right (rev)" or -1 for "label scrolls left (fwd)".
 */
function detectScrollDirection(frames, bg) {
  const TW = 96, TH = 54
  let rightVotes = 0, leftVotes = 0
  const nProbe = Math.min(4, frames.length - 1)
  for (let i = 0; i < nProbe; i++) {
    const lumA = buildLumThumb(frames[i],   TW, TH, bg)
    const lumB = buildLumThumb(frames[i+1], TW, TH, bg)
    const tA   = buildGradThumb(lumA, TW, TH)
    const tB   = buildGradThumb(lumB, TW, TH)
    const shift = estimateColShift(tA, tB, TW, TH)
    console.log('  Direction probe ' + i + '→' + (i+1) + ': colShift=' + shift +
      (shift > 0 ? ' (rev)' : shift < 0 ? ' (fwd)' : ' (ambiguous)'))
    if (shift > 0) rightVotes++
    else if (shift < 0) leftVotes++
  }
  const dir = rightVotes >= leftVotes ? 1 : -1  // 1=rev, -1=fwd in our sign convention
  console.log('  Direction: ' + (dir === 1 ? 'REVERSE (label scrolls right)' : 'FORWARD (label scrolls left)'))
  return dir
}

/**
 * Find the horizontal offset between two adjacent frames.
 *
 * scrollDir:
 *   +1 = label scrolls right → compare A's LEFT strip with B's RIGHT strip,
 *        return negative offset (B is to the LEFT of A in the panorama).
 *   -1 = label scrolls left  → compare A's RIGHT strip with B's LEFT strip,
 *        return positive offset (B is to the RIGHT of A).
 *
 * Returns { offset (signed pixels), nccScore, dy, method }
 */
function findOffset(frameA, frameB, bg, scrollDir, verbose) {
  const TW = 96, TH = 54
  const lumA = buildLumThumb(frameA, TW, TH, bg)
  const lumB = buildLumThumb(frameB, TW, TH, bg)
  const tA   = buildGradThumb(lumA, TW, TH)
  const tB   = buildGradThumb(lumB, TW, TH)
  const maskA = buildColMask(lumA, TW, TH)
  const maskB = buildColMask(lumB, TW, TH)

  // Minimum overlap: 20% avoids label-edge gradient artefacts.
  const minOvlp = Math.round(TW * 0.20)
  const maxOvlp = Math.round(TW * 0.92)

  // dir=1 in NCC terms: right-of-A vs left-of-B (B further right, positive offset)
  // dir=-1 in NCC terms: left-of-A vs right-of-B (B further left, negative offset)
  // scrollDir +1 → use NCC dir=-1 (label scrolls right)
  // scrollDir -1 → use NCC dir=+1 (label scrolls left)
  const nccDir = -scrollDir

  let bestOvlp = -1, bestScore = -Infinity, bestDy = 0
  const candidates = []

  for (let ovlp = minOvlp; ovlp <= maxOvlp; ovlp++) {
    let fgCols = 0
    for (let x = 0; x < ovlp; x++) {
      const colA = nccDir === 1 ? (TW - ovlp + x) : x
      const colB = nccDir === 1 ? x : (TW - ovlp + x)
      if (maskA[colA] && maskB[colB]) fgCols++
    }
    if (fgCols < 3) continue

    let bestSHere = -Infinity, bestDyHere = 0
    for (let dy = -MAX_DY; dy <= MAX_DY; dy++) {
      // Build overlap strips
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
      if (s > bestSHere) { bestSHere = s; bestDyHere = dy }
    }

    candidates.push({ ovlp, score: bestSHere, dy: bestDyHere })
    if (bestSHere > bestScore) { bestScore = bestSHere; bestOvlp = ovlp; bestDy = bestDyHere }
  }

  if (verbose && candidates.length > 0) {
    const sorted = candidates.slice().sort((a, b) => b.score - a.score)
    console.log('  Top 5 candidates:')
    for (const c of sorted.slice(0, 5)) {
      const off = Math.round(((TW - c.ovlp) / TW) * frameA.width) * nccDir
      const pct = Math.round((c.ovlp / TW) * 100)
      console.log(
        '    ovlp=' + c.ovlp + '(' + pct + '%)' +
        '  offset=' + off + 'px' +
        '  dy=' + c.dy +
        '  NCC=' + c.score.toFixed(3)
      )
    }
  }

  if (bestOvlp === -1) {
    const cA = colCentroid(maskA, TW)
    const cB = colCentroid(maskB, TW)
    const rawOffset = Math.round(((cA - cB) / TW) * frameA.width)
    return { offset: rawOffset * nccDir, nccScore: 0, method: 'centroid', dy: 0 }
  }

  const pxOffset = Math.round(((TW - bestOvlp) / TW) * frameA.width) * nccDir
  return { offset: pxOffset, nccScore: Math.round(bestScore * 1000) / 1000, method: 'ncc', dy: bestDy }
}

// ---------------------------------------------------------------------------
// ImageData wrapper from Jimp
// ---------------------------------------------------------------------------
function jimpToImageData(j) {
  return {
    width:  j.bitmap.width,
    height: j.bitmap.height,
    data:   new Uint8ClampedArray(j.bitmap.data.buffer),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const videoPath = process.argv[2]
  if (!videoPath || !fs.existsSync(videoPath)) {
    console.error('Usage: node test-data/test-stitch.cjs <path-to-video>')
    process.exit(1)
  }

  const baseName = path.basename(videoPath, path.extname(videoPath))
  const outDir   = path.join(path.dirname(videoPath), '_frames_' + baseName)
  fs.mkdirSync(outDir, { recursive: true })

  const probe = spawnSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
  ], { encoding: 'utf8' })
  const duration = parseFloat(probe.stdout.trim()) || 10
  const interval = duration / TARGET_FRAMES
  console.log('Video duration: ' + duration.toFixed(2) + 's, frame every ' + interval.toFixed(2) + 's')

  console.log('Extracting ' + TARGET_FRAMES + ' frames...')
  const fpsFilter  = 'fps=1/' + interval.toFixed(4)
  const outPattern = path.join(outDir, 'frame_%03d.jpg')
  const ffResult = spawnSync(FFMPEG, [
    '-y', '-i', videoPath, '-vf', fpsFilter,
    '-frames:v', String(TARGET_FRAMES), outPattern,
  ], { stdio: 'inherit' })
  if (ffResult.status !== 0) { console.error('ffmpeg failed'); process.exit(1) }

  const framePaths = fs.readdirSync(outDir)
    .filter(function(f) { return f.endsWith('.jpg') })
    .sort()
    .map(function(f) { return path.join(outDir, f) })
  if (framePaths.length === 0) { console.error('No frames extracted'); process.exit(1) }
  console.log('Extracted ' + framePaths.length + ' frames\n')

  const frames = await Promise.all(framePaths.map(function(p) {
    return Jimp.read(p).then(function(j) { return jimpToImageData(j) })
  }))
  const fw = frames[0].width
  const fh = frames[0].height
  console.log('Frame size: ' + fw + 'x' + fh)

  const bg = sampleBackground(frames[0])
  console.log('Background: rgb(' + bg.map(function(v) { return v.toFixed(0) }).join(', ') + ')\n')

  // --- Detect global scroll direction ---
  console.log('Detecting scroll direction...')
  const scrollDir = detectScrollDirection(frames, bg)
  // scrollDir = +1 → label scrolls right (features move right, B is left of A)
  // scrollDir = -1 → label scrolls left  (features move left,  B is right of A)
  console.log('')

  // Find offsets using the detected direction
  const xPositions = [0]
  const nccScores  = [0]
  const dyOffsets  = [0]
  for (let i = 1; i < frames.length; i++) {
    const verbose = (i <= 2)
    if (verbose) console.log('--- Pair ' + (i-1) + '→' + i + ' ---')
    const r = findOffset(frames[i - 1], frames[i], bg, scrollDir, verbose)
    xPositions.push(xPositions[i - 1] + r.offset)
    nccScores.push(r.nccScore)
    dyOffsets.push(r.dy)
    const overlapPx  = fw - Math.abs(r.offset)
    const overlapPct = Math.round((overlapPx / fw) * 100)
    if (verbose) {
      console.log(
        '  BEST: offset=' + r.offset + 'px  overlap=' + overlapPct +
        '%  NCC=' + r.nccScore.toFixed(3) + '  dy=' + r.dy + '  [' + r.method + ']'
      )
    }
  }

  // Normalise so min xPosition = 0
  const minX = Math.min(...xPositions)
  const normX = xPositions.map(function(x) { return x - minX })

  console.log('\n--- Summary table ---')
  console.log('Frame  X-pos     Overlap  NCC    dy   Quality')
  for (let i = 0; i < frames.length; i++) {
    const prevEnd    = i > 0 ? normX[i - 1] + fw : normX[i]
    const overlapPx  = Math.max(0, prevEnd - normX[i])
    const overlapPct = Math.round((overlapPx / fw) * 100)
    const score = nccScores[i]
    const q = score > 0.5 ? 'Good' : score > 0.2 ? 'Fair' : 'Poor'
    console.log(
      String(i).padEnd(7) +
      (normX[i] + 'px').padEnd(10) +
      (overlapPct + '%').padEnd(9) +
      score.toFixed(3).padEnd(7) +
      String(dyOffsets[i]).padEnd(5) +
      q
    )
  }

  const totalW = Math.max(...normX) + fw
  const cumDy  = dyOffsets.reduce(function(a, b) { return a + b }, 0)
  console.log('\nPanorama: ' + totalW + 'px wide  (' + frames.length + ' frames x ' + fw + 'px each)')
  console.log('Expected: ~' + Math.round(fw * 2.5) + '-' + Math.round(fw * 3.5) + 'px for a full label rotation')
  console.log('Cumulative vertical drift: ' + cumDy + ' thumb-rows (' + Math.round(cumDy * fh / 54) + 'px)')
}

main().catch(function(e) { console.error(e); process.exit(1) })
