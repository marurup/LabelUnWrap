/**
 * unwrapper.ts
 *
 * Main-thread coordinator for the six-point label unwrap.
 * Converts a single photo Blob + 6 normalised points → JPEG Blob.
 */

import type { Point2D, UnwrapInput } from '../workers/unwrap.worker'

export type { Point2D }

async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get OffscreenCanvas 2D context')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

async function imageDataToBlob(imageData: ImageData, quality = 0.92): Promise<Blob> {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get OffscreenCanvas 2D context')
  ctx.putImageData(imageData, 0, 0)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

let workerInstance: Worker | null = null

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL('../workers/unwrap.worker.ts', import.meta.url),
      { type: 'module' },
    )
  }
  return workerInstance
}

type WorkerOutput =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'result'; imageData: ImageData }
  | { type: 'error'; message: string }

/**
 * Unwrap a single label photo using the six-point method.
 *
 * @param photo       Single photo Blob
 * @param points      6 normalised points (0..1 relative to image) [A, B, C, D, E, F]
 * @param onProgress  Callback with step label and 0–100 percent
 */
export async function unwrapLabel(
  photo: Blob,
  points: [Point2D, Point2D, Point2D, Point2D, Point2D, Point2D],
  onProgress: (step: string, percent: number) => void,
): Promise<Blob> {
  onProgress('Loading photo…', 5)
  const imageData = await blobToImageData(photo)

  // Scale normalised (0..1) points to pixel coordinates
  const pixelPoints = points.map((p) => ({
    x: p.x * imageData.width,
    y: p.y * imageData.height,
  })) as [Point2D, Point2D, Point2D, Point2D, Point2D, Point2D]

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

    const msg: UnwrapInput = { type: 'unwrap', frame: imageData, points: pixelPoints }
    worker.postMessage(msg, [imageData.data.buffer])
  })
}
