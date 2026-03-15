/**
 * autoUnwrapper.ts
 *
 * Main-thread coordinator for the auto-detect → unwrap → stitch pipeline.
 * Mirrors the shape of stitcher.ts but drives autoUnwrap.worker.ts instead.
 */

import type { AutoUnwrapDebugInfo } from '../workers/autoUnwrap.worker'

type WorkerOutput =
  | { type: 'progress'; step: string; percent: number }
  | { type: 'flatFrames'; frames: ImageData[] }
  | { type: 'result'; imageData: ImageData; debugInfo: AutoUnwrapDebugInfo }
  | { type: 'error'; message: string }

let lastDebugInfo: AutoUnwrapDebugInfo | null = null
let lastFlatFrameBlobs: Blob[] = []

export function getLastAutoUnwrapDebugInfo(): AutoUnwrapDebugInfo | null { return lastDebugInfo }
export function getLastFlatFrameBlobs(): Blob[] { return lastFlatFrameBlobs }

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
      new URL('../workers/autoUnwrap.worker.ts', import.meta.url),
      { type: 'module' },
    )
  }
  return workerInstance
}

/**
 * Run the full auto-unwrap pipeline on a set of video frames.
 *
 * @param frames      Blob[] — JPEG/PNG frames extracted from the video
 * @param onProgress  Called with step label and 0–100 percent
 * @param debugMode   When true the worker also sends intermediate flat frames
 */
export async function autoUnwrapFrames(
  frames: Blob[],
  onProgress: (step: string, percent: number) => void,
  debugMode: boolean,
): Promise<Blob> {
  if (frames.length === 0) throw new Error('No frames to process')

  // Reset module-level debug state
  lastDebugInfo = null
  lastFlatFrameBlobs = []

  onProgress('Converting frames…', 3)
  const imageDataFrames = await Promise.all(frames.map(blobToImageData))

  return new Promise<Blob>((resolve, reject) => {
    const worker = getWorker()
    let flatFrameConversionPromise: Promise<Blob[]> | null = null

    const handleMessage = async (event: MessageEvent<WorkerOutput>) => {
      const msg = event.data
      switch (msg.type) {
        case 'progress':
          onProgress(msg.step, msg.percent)
          break

        case 'flatFrames':
          // Convert flat frame ImageData → Blobs asynchronously while the
          // result message is still being processed.
          flatFrameConversionPromise = Promise.all(msg.frames.map(f => imageDataToBlob(f)))
          break

        case 'result': {
          worker.removeEventListener('message', handleMessage)
          worker.removeEventListener('error', handleError)
          lastDebugInfo = msg.debugInfo
          try {
            // Wait for any in-flight flat-frame conversion
            if (flatFrameConversionPromise) {
              lastFlatFrameBlobs = await flatFrameConversionPromise
            }
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

    const transferables = imageDataFrames.map(id => id.data.buffer)
    worker.postMessage(
      { type: 'autoUnwrap', frames: imageDataFrames, debugMode },
      transferables,
    )
  })
}
