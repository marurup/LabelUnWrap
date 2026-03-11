/**
 * stitcher.ts
 *
 * Main-thread coordinator for image stitching and cylindrical unwarp.
 * Converts Blob[] frames → ImageData[], dispatches to stitcher.worker.ts,
 * and resolves with a JPEG Blob when processing is complete.
 */

type WorkerOutput =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'result'; imageData: ImageData }
  | { type: 'error'; message: string }

/**
 * Convert a Blob to ImageData using createImageBitmap + OffscreenCanvas.
 */
async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get OffscreenCanvas 2D context')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/**
 * Convert ImageData to a JPEG Blob via OffscreenCanvas.
 */
async function imageDataToBlob(imageData: ImageData, quality = 0.92): Promise<Blob> {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get OffscreenCanvas 2D context')
  ctx.putImageData(imageData, 0, 0)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

// Singleton worker — created on first call, reused on subsequent calls.
let workerInstance: Worker | null = null

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL('../workers/stitcher.worker.ts', import.meta.url),
      { type: 'module' },
    )
  }
  return workerInstance
}

/**
 * Process a set of image frames:
 * 1. Convert Blobs → ImageData on the main thread
 * 2. Send to stitcher worker
 * 3. Resolve with a JPEG Blob
 *
 * @param frames    Array of image Blobs (JPEG/PNG) captured from camera
 * @param onProgress  Callback invoked with step label and 0-100 percent
 */
export async function processFrames(
  frames: Blob[],
  onProgress: (step: string, percent: number) => void,
): Promise<Blob> {
  if (frames.length === 0) {
    throw new Error('No frames to process')
  }

  // Convert all blobs to ImageData on the main thread
  onProgress('Converting frames...', 5)
  const imageDataFrames: ImageData[] = await Promise.all(frames.map(blobToImageData))

  // Send to worker and wait for result
  return new Promise<Blob>((resolve, reject) => {
    const worker = getWorker()

    const handleMessage = async (event: MessageEvent<WorkerOutput>) => {
      const msg = event.data
      switch (msg.type) {
        case 'progress':
          onProgress(msg.step, msg.percent)
          break
        case 'result': {
          worker.removeEventListener('message', handleMessage)
          worker.removeEventListener('error', handleError)
          try {
            const blob = await imageDataToBlob(msg.imageData)
            resolve(blob)
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
          break
        }
        case 'error':
          worker.removeEventListener('message', handleMessage)
          worker.removeEventListener('error', handleError)
          reject(new Error(msg.message))
          break
      }
    }

    const handleError = (err: ErrorEvent) => {
      worker.removeEventListener('message', handleMessage)
      worker.removeEventListener('error', handleError)
      reject(new Error(err.message ?? 'Worker error'))
    }

    worker.addEventListener('message', handleMessage)
    worker.addEventListener('error', handleError)

    // Transfer the ImageData buffers to the worker for zero-copy
    const transferables = imageDataFrames.map((id) => id.data.buffer)
    worker.postMessage({ type: 'stitch', frames: imageDataFrames }, transferables)
  })
}
