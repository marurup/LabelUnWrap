/**
 * test-stitch.cjs
 *
 * Standalone Node.js test harness for the stitching algorithm.
 * Usage:  node test-data/test-stitch.cjs test-data/myvideo.mp4
 *
 * Approach: full-resolution 1-D column-gradient cross-correlation.
 * Computes ∑|∂lum/∂x| per column (middle 60% of rows) then finds the
 * horizontal shift that maximises NCC of the two 1-D profiles.
 * Avoids the cylindrical-distortion problem of 2-D strip NCC: a feature
 * at the edge of frame A (foreshortened) matches a centrally placed
 * feature in frame B by its *column position*, not its appearance.
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

// ---------------------------------------------------------------------------
// Background sampling
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

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

// ---------------------------------------------------------------------------
// Full-resolution column gradient profile
//   Returns Float32Array[width] where profile[x] = mean |∂lum/∂x| for
//   non-background pixels in column x, using the middle 60% of rows.
// ---------------------------------------------------------------------------
function columnProfile(img, bg) {
  const { width, height, data } = img
  const [bgR, bgG, bgB] = bg
  const yStart = Math.floor(height * 0.15)
  const yEnd   = Math.floor(height * 0.75)   // avoid hands at bottom
  const prof = new Float32Array(width)

  for (let x = 1; x < width - 1; x++) {
    let sum = 0, cnt = 0
    for (let y = yStart; y < yEnd; y++) {
      const i  = (y * width + x) * 4
      const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB
      if (dr * dr + dg * dg + db * db < BG_THRESH_SQ) continue  // background

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
//   shift > 0 means profB's features are shifted RIGHT compared to profA
//             → label scrolled right in the camera (reverse direction)
//   shift < 0 → label scrolled left (forward direction)
//   pixel offset for placing B relative to A = -shift
// ---------------------------------------------------------------------------
function crossCorrelate1D(profA, profB, maxShift) {
  const n = profA.length
  let bestShift = 0, bestScore = -Infinity
  const topCandidates = []

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
    topCandidates.push({ shift, score: s })
    if (s > bestScore) { bestScore = s; bestShift = shift }
  }

  topCandidates.sort((a, b) => b.score - a.score)
  return { shift: bestShift, score: bestScore, top: topCandidates.slice(0, 5) }
}

// ---------------------------------------------------------------------------
// Find pixel offset between two adjacent frames using 1-D column profiles.
// Returns signed pixel offset for placing frameB relative to frameA.
// ---------------------------------------------------------------------------
function findOffset(profA, profB, fw, verbose) {
  // Allow up to 80% shift (can can't rotate more than 80% of frame per step)
  const maxShift = Math.round(fw * 0.80)
  const result = crossCorrelate1D(profA, profB, maxShift)

  if (verbose) {
    console.log('  Top 5 shift candidates:')
    for (const c of result.top) {
      console.log(
        '    shift=' + c.shift + 'px' +
        '  offset=' + (-c.shift) + 'px' +
        '  NCC=' + c.score.toFixed(3)
      )
    }
  }

  return { offset: -result.shift, nccScore: result.score }
}

// ---------------------------------------------------------------------------
// Save a Float32Array profile as a simple bar-chart PNG (for debugging)
// ---------------------------------------------------------------------------
async function saveProfileImage(prof, outPath, label) {
  const W = prof.length
  const H = 120
  const maxVal = Math.max(...prof, 1e-6)
  const img = new Jimp({ width: W, height: H, color: 0xffffffff })
  for (let x = 0; x < W; x++) {
    const barH = Math.round((prof[x] / maxVal) * (H - 4))
    for (let y = H - 1; y >= H - barH; y--) {
      img.setPixelColor(0x2266aaff, x, y)
    }
  }
  await img.write(outPath)
  console.log('  Saved profile: ' + outPath + ' (' + label + ')')
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

  // --- Extract frames ---
  const probe = spawnSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
  ], { encoding: 'utf8' })
  const duration = parseFloat(probe.stdout.trim()) || 10
  const interval = duration / TARGET_FRAMES
  console.log('Video: ' + duration.toFixed(2) + 's, extracting ' + TARGET_FRAMES +
    ' frames every ' + interval.toFixed(2) + 's')

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

  // --- Load frames ---
  const jFrames = await Promise.all(framePaths.map(function(p) { return Jimp.read(p) }))
  const frames  = jFrames.map(jimpToImageData)
  const fw = frames[0].width
  const fh = frames[0].height
  console.log('Frame size: ' + fw + 'x' + fh)

  const bg = sampleBackground(frames[0])
  console.log('Background: rgb(' + bg.map(function(v) { return v.toFixed(0) }).join(', ') + ')\n')

  // --- Build column profiles ---
  console.log('Building column profiles...')
  const profiles = frames.map(function(f) { return columnProfile(f, bg) })

  // Save first 3 profiles as debug images
  const debugDir = path.join(path.dirname(videoPath), '_debug_' + baseName)
  fs.mkdirSync(debugDir, { recursive: true })
  for (let i = 0; i < Math.min(3, profiles.length); i++) {
    await saveProfileImage(profiles[i], path.join(debugDir, 'profile_' + i + '.png'), 'frame ' + i)
  }

  // --- Find offsets ---
  console.log('\nFinding offsets...')
  const xPositions = [0]
  const nccScores  = [0]
  for (let i = 1; i < frames.length; i++) {
    const verbose = (i <= 3)
    if (verbose) console.log('--- Pair ' + (i - 1) + '→' + i + ' ---')
    const r = findOffset(profiles[i - 1], profiles[i], fw, verbose)
    xPositions.push(xPositions[i - 1] + r.offset)
    nccScores.push(r.nccScore)
    const overlapPx  = fw - Math.abs(r.offset)
    const overlapPct = Math.round((overlapPx / fw) * 100)
    if (verbose) {
      console.log(
        '  BEST: offset=' + r.offset + 'px  overlap=' + overlapPct +
        '%  NCC=' + r.nccScore.toFixed(3)
      )
    }
  }

  // --- Summary ---
  const minX = Math.min(...xPositions)
  const normX = xPositions.map(function(x) { return x - minX })

  console.log('\n--- Summary table ---')
  console.log('Frame  X-pos     Overlap  NCC    Quality')
  for (let i = 0; i < frames.length; i++) {
    const overlapPx  = i > 0 ? Math.max(0, fw - Math.abs(xPositions[i] - xPositions[i - 1])) : 0
    const overlapPct = Math.round((overlapPx / fw) * 100)
    const score = nccScores[i]
    const q = score > 0.5 ? 'Good' : score > 0.25 ? 'Fair' : 'Poor'
    console.log(
      String(i).padEnd(7) +
      (normX[i] + 'px').padEnd(10) +
      (overlapPct + '%').padEnd(9) +
      score.toFixed(3).padEnd(7) +
      q
    )
  }

  const totalW = Math.max(...normX) + fw
  const direction = xPositions[xPositions.length - 1] < xPositions[0] ? 'REVERSE (scrolls right)' : 'FORWARD (scrolls left)'
  console.log('\nDetected direction: ' + direction)
  console.log('Panorama: ' + totalW + 'px wide  (' + frames.length + ' frames x ' + fw + 'px each)')
  console.log('Expected: ~' + Math.round(fw * 2.5) + '-' + Math.round(fw * 3.5) + 'px for a full label rotation')

  // --- Composite panorama (scaled down 4x) ---
  const SCALE = 4
  const panW = Math.ceil(totalW / SCALE)
  const panH = Math.ceil(fh   / SCALE)
  console.log('\nCompositing panorama at 1/' + SCALE + ' scale (' + panW + 'x' + panH + ')...')

  const panImg = new Jimp({ width: panW, height: panH, color: 0x000000ff })

  // Composite from back to front so earlier frames aren't overwritten by later ones
  // Sort by xPosition so right-most (last visible) frames are placed first
  const order = normX.map(function(x, i) { return { x, i } })
    .sort(function(a, b) { return a.x - b.x })  // low x first → they go under high x

  for (const { x, i } of order) {
    const scaled = jFrames[i].clone().resize({ w: Math.round(fw / SCALE), h: Math.round(fh / SCALE) })
    panImg.composite(scaled, Math.round(x / SCALE), 0)
  }

  const panPath = path.join(debugDir, 'panorama.jpg')
  await panImg.write(panPath)
  console.log('Panorama saved: ' + panPath)
}

main().catch(function(e) { console.error(e); process.exit(1) })
