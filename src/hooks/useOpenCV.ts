/**
 * useOpenCV.ts
 *
 * Lazy-loads OpenCV.js WASM from a CDN on demand.
 * Returns { isReady, isLoading, error, loadOpenCV }.
 */

import { useState, useCallback, useRef } from 'react'

const OPENCV_CDN_URL = 'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js'

interface UseOpenCVResult {
  isReady: boolean
  isLoading: boolean
  error: string | null
  loadOpenCV: () => Promise<void>
}

// Module-level cache so multiple hook instances share state
let cachedPromise: Promise<void> | null = null
let isLoaded = false

export function useOpenCV(): UseOpenCVResult {
  const [isReady, setIsReady] = useState(isLoaded)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadingRef = useRef(false)

  const loadOpenCV = useCallback(async (): Promise<void> => {
    // Already loaded — no-op
    if (isLoaded) {
      setIsReady(true)
      return
    }

    // Another call is already in progress — wait for it
    if (cachedPromise) {
      await cachedPromise
      setIsReady(true)
      return
    }

    // Check if a script tag already exists (e.g. from a previous render cycle)
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${OPENCV_CDN_URL}"]`,
    )
    if (existingScript) {
      cachedPromise = new Promise<void>((resolve, reject) => {
        existingScript.addEventListener('load', () => {
          isLoaded = true
          resolve()
        })
        existingScript.addEventListener('error', () =>
          reject(new Error('OpenCV script failed to load')),
        )
      })
      setIsLoading(true)
      try {
        await cachedPromise
        setIsReady(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load OpenCV')
      } finally {
        setIsLoading(false)
      }
      return
    }

    if (loadingRef.current) return
    loadingRef.current = true
    setIsLoading(true)
    setError(null)

    cachedPromise = new Promise<void>((resolve, reject) => {
      // Set up Module before injecting the script so OpenCV picks it up
      ;(window as unknown as Record<string, unknown>)['Module'] = {
        onRuntimeInitialized: () => {
          isLoaded = true
          resolve()
        },
      }

      const script = document.createElement('script')
      script.src = OPENCV_CDN_URL
      script.async = true
      script.addEventListener('error', () => {
        reject(new Error('Failed to load OpenCV.js from CDN'))
      })
      document.head.appendChild(script)
    })

    try {
      await cachedPromise
      setIsReady(true)
    } catch (err) {
      cachedPromise = null
      setError(err instanceof Error ? err.message : 'Failed to load OpenCV')
    } finally {
      loadingRef.current = false
      setIsLoading(false)
    }
  }, [])

  return { isReady, isLoading, error, loadOpenCV }
}
