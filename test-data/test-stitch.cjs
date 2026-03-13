/**
 * test-stitch.cjs
 *
 * Standalone Node.js test harness for the stitching algorithm.
 * Drop a video into test-data/ and run:
 *   node test-data/test-stitch.cjs test-data/myvideo.mp4
 *
 * Extracts 12 frames with ffmpeg, runs the overlap-detection algorithm,
 * and prints the same debug table shown in the app.
 */

'use strict'
const { spawnSync } = require('child_process')
const path  = require('path')
const fs    = require('fs')
const { Jimp } = require('jimp')

const FFMPEG  = 'C:\\local\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe'
const FFPROBE = 'C:\\local\\ffmpeg-8.0.1-full_build\\bin\\ffprobe.exe'

const TARGET_FRAMES = 12
const BG_THRESH_SQ  = 50 * 50   // raised from 40 — eliminates cloth-texture false positives

// Small prior added to NCC score that increases with overlap.
// Encodes that objects don't usually jump 80% of frame width between frames.
// At ovlp=88 (92%) adds +0.09; at ovlp=17 (18%) adds +0.018.
const OVERLAP_PRIOR = 0.10

// ---------------------------------------------------------------------------
// Algorithm helpers (mirrors stitcher.worker.ts)
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

function buildThumb(img, TW, TH, bg) {
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

function buildColMask(thumb, TW, TH) {
  const mask = new Uint8Array(TW)
  const maxRow = Math.floor(TH * 0.75)  // ignore bottom 25% — hands
  for (let ty = 0; ty < maxRow; ty++)
    for (let tx = 0; tx < TW; tx++)
      if (thumb[ty * TW + tx] > 0) mask[tx] = 1
  return mask
}

function colCentroid(mask, TW) {
  let xSum = 0, n = 0
  for (let x = 0; x < TW; x++) if (mask[x]) { xSum += x; n++ }
  return n > 0 ? xSum / n : TW / 2
}

function findOffset(frameA, frameB, bg) {
  const TW = 96, TH = 54
  const tA = buildThumb(frameA, TW, TH, bg)
  const tB = buildThumb(frameB, TW, TH, bg)
  const maskA = buildColMask(tA, TW, TH)
  const maskB = buildColMask(tB, TW, TH)

  const minOvlp = Math.round(TW * 0.05)
  const maxOvlp = Math.round(TW * 0.92)
  let bestOvlp = -1, bestScore = -Infinity

  for (let ovlp = minOvlp; ovlp <= maxOvlp; ovlp++) {
    let fgCols = 0
    for (let x = 0; x < ovlp; x++)
      if (maskA[TW - ovlp + x] && maskB[x]) fgCols++
    if (fgCols < 3) continue

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
    const cA = colCentroid(maskA, TW)
    const cB = colCentroid(maskB, TW)
    const offset = Math.max(0, Math.round(((cA - cB) / TW) * frameA.width))
    return { offset, nccScore: 0, method: 'centroid' }
  }

  const offset = Math.round(((TW - bestOvlp) / TW) * frameA.width)
  return { offset, nccScore: Math.round(bestScore * 1000) / 1000, method: 'ncc' }
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

  // Get video duration via ffprobe
  const probe = spawnSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ], { encoding: 'utf8' })
  const duration = parseFloat(probe.stdout.trim()) || 10
  const interval = duration / TARGET_FRAMES
  console.log('Video duration: ' + duration.toFixed(2) + 's, frame every ' + interval.toFixed(2) + 's')

  // Extract frames using fps filter — simpler and more reliable than select
  console.log('Extracting ' + TARGET_FRAMES + ' frames...')
  const fpsFilter  = 'fps=1/' + interval.toFixed(4)
  const outPattern = path.join(outDir, 'frame_%03d.jpg')
  const ffResult = spawnSync(FFMPEG, [
    '-y', '-i', videoPath,
    '-vf', fpsFilter,
    '-frames:v', String(TARGET_FRAMES),
    outPattern,
  ], { stdio: 'inherit' })
  if (ffResult.status !== 0) { console.error('ffmpeg failed'); process.exit(1) }

  const framePaths = fs.readdirSync(outDir)
    .filter(function(f) { return f.endsWith('.jpg') })
    .sort()
    .map(function(f) { return path.join(outDir, f) })

  if (framePaths.length === 0) { console.error('No frames extracted'); process.exit(1) }
  console.log('Extracted ' + framePaths.length + ' frames\n')

  // Load frames
  const frames = await Promise.all(framePaths.map(function(p) {
    return Jimp.read(p).then(function(j) { return jimpToImageData(j) })
  }))
  const fw = frames[0].width
  const fh = frames[0].height
  console.log('Frame size: ' + fw + 'x' + fh)

  // Sample background from first frame corners
  const bg = sampleBackground(frames[0])
  console.log('Background: rgb(' + bg.map(function(v) { return v.toFixed(0) }).join(', ') + ')\n')

  // Find offsets
  const xPositions = [0]
  const nccScores  = [0]
  for (let i = 1; i < frames.length; i++) {
    const r = findOffset(frames[i - 1], frames[i], bg)
    xPositions.push(xPositions[i - 1] + r.offset)
    nccScores.push(r.nccScore)
    const overlap = Math.round(((fw - r.offset) / fw) * 100)
    console.log(
      'Frame ' + i + ': offset=' + r.offset + 'px  overlap=' + overlap +
      '%  NCC=' + r.nccScore.toFixed(3) + '  [' + r.method + ']'
    )
  }

  // Summary table
  console.log('\n--- Debug table ---')
  console.log('Frame  X-pos     Overlap  NCC    Quality')
  for (let i = 0; i < frames.length; i++) {
    const prevEnd    = i > 0 ? xPositions[i - 1] + fw : xPositions[i]
    const overlapPx  = Math.max(0, prevEnd - xPositions[i])
    const overlapPct = Math.round((overlapPx / fw) * 100)
    const score = nccScores[i]
    const q = score > 0.5 ? 'Good' : score > 0.2 ? 'Fair' : 'Poor'
    console.log(
      String(i).padEnd(7) +
      (xPositions[i] + 'px').padEnd(10) +
      (overlapPct + '%').padEnd(9) +
      score.toFixed(3).padEnd(7) +
      q
    )
  }

  const totalW = xPositions[xPositions.length - 1] + fw - xPositions[0]
  console.log('\nPanorama: ' + totalW + 'px wide  (' + frames.length + ' frames x ' + fw + 'px each)')
  console.log('Expected: ~' + Math.round(fw * 2.5) + '-' + Math.round(fw * 3.5) + 'px for a full label rotation')
}

main().catch(function(e) { console.error(e); process.exit(1) })
