/**
 * Extracts evenly-spaced frames from a video Blob using a hidden <video> element
 * and canvas captures. Returns an array of JPEG Blobs.
 */
export async function extractFrames(
  videoBlob: Blob,
  targetCount: number,
): Promise<Blob[]> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(videoBlob)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    video.src = url

    // We need the video dimensions and duration before seeking
    video.addEventListener('loadedmetadata', () => {
      const duration = video.duration
      if (!isFinite(duration) || duration <= 0) {
        cleanup()
        reject(new Error('Invalid video duration'))
        return
      }

      const width = video.videoWidth || 1280
      const height = video.videoHeight || 720
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')

      if (!ctx) {
        cleanup()
        reject(new Error('Could not get canvas context'))
        return
      }

      // Build seek times: evenly distributed across the duration.
      // Avoid the very first and last frame (often black) by using small offsets.
      const count = Math.max(1, targetCount)
      const times: number[] = []
      for (let i = 0; i < count; i++) {
        // Map [0..count-1] to positions between 5% and 95% of duration
        const t = duration * (0.05 + (0.90 * i) / Math.max(count - 1, 1))
        times.push(t)
      }

      const frames: Blob[] = []
      let index = 0

      const seekNext = () => {
        if (index >= times.length) {
          cleanup()
          resolve(frames)
          return
        }
        video.currentTime = times[index]
      }

      const onSeeked = () => {
        ctx.drawImage(video, 0, 0, width, height)
        canvas.toBlob(
          (blob) => {
            if (blob) frames.push(blob)
            index++
            seekNext()
          },
          'image/jpeg',
          0.92,
        )
      }

      video.addEventListener('seeked', onSeeked)
      seekNext()
    })

    video.addEventListener('error', () => {
      cleanup()
      reject(new Error('Failed to load video for frame extraction'))
    })

    function cleanup() {
      URL.revokeObjectURL(url)
      video.src = ''
    }
  })
}
