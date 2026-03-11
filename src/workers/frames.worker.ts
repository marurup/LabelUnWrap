/**
 * frames.worker.ts
 *
 * Web Worker stub for future heavy image processing.
 *
 * Video decoding requires DOM APIs (<video>, canvas) that are unavailable in a
 * standard Worker context, so frame extraction is handled on the main thread by
 * src/lib/frameSelector.ts.  This worker is reserved for CPU-intensive tasks
 * (e.g. image stitching, colour correction) that will be added in Phase 3.
 */

self.addEventListener('message', (event: MessageEvent<{ type: string }>) => {
  const { type } = event.data
  // No operations implemented yet — acknowledge unknown messages.
  self.postMessage({ type: 'error', message: `Unknown message type: ${type}` })
})

export {}
