/**
 * Extracts evenly-spaced frames from a video Blob using a hidden <video> element.
 *
 * MediaRecorder output on Android often has duration=Infinity and non-seekable
 * streams, so we cannot rely on seeking. Instead we play the video at max speed
 * and sample frames at regular playback intervals.
 */
export async function extractFrames(
  videoBlob: Blob,
  targetCount: number,
  onProgress?: (extracted: number, total: number) => void,
): Promise<Blob[]> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(videoBlob)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    // Play as fast as the browser allows so extraction doesn't take long
    video.playbackRate = 16
    video.src = url

    let canvas: HTMLCanvasElement | null = null
    let ctx: CanvasRenderingContext2D | null = null
    const frames: Blob[] = []
    let lastCaptureTime = -Infinity
    let captureInterval = 0
    let duration = 0
    let settled = false

    function cleanup() {
      video.pause()
      video.src = ''
      URL.revokeObjectURL(url)
    }

    function finish() {
      if (settled) return
      settled = true
      cleanup()
      resolve(frames)
    }

    function captureFrame() {
      if (!canvas || !ctx) return
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        (blob) => { if (blob) frames.push(blob) },
        'image/jpeg',
        0.92,
      )
    }

    function startPlayback() {
      const w = video.videoWidth || 1280
      const h = video.videoHeight || 720
      canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      ctx = canvas.getContext('2d')

      // If we know the duration, space frames evenly.
      // If duration is still Infinity, sample every ~0.5 s of real video time.
      duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 0
      captureInterval = duration > 0 ? duration / targetCount : 0.5

      video.play().catch(() => {
        cleanup()
        reject(new Error('Could not play video for frame extraction'))
      })
    }

    video.addEventListener('timeupdate', () => {
      if (!canvas) return
      const t = video.currentTime
      if (t - lastCaptureTime >= captureInterval) {
        lastCaptureTime = t
        captureFrame()
        onProgress?.(frames.length, targetCount)
      }
    })

    video.addEventListener('ended', finish)

    // Safety timeout: if the video never ends (e.g. stalls) resolve with what we have
    video.addEventListener('play', () => {
      const maxWait = Math.max(15_000, (duration || 30) * 1000)
      setTimeout(() => { if (!settled) finish() }, maxWait)
    })

    video.addEventListener('loadeddata', startPlayback)

    video.addEventListener('error', () => {
      if (!settled) {
        settled = true
        cleanup()
        reject(new Error('Failed to load video for frame extraction'))
      }
    })
  })
}
