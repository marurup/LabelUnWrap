import { useRef, useState, useCallback, useEffect, type RefObject } from 'react'

export interface UseCameraReturn {
  stream: MediaStream | null
  error: string | null
  isLoading: boolean
  startCamera: () => Promise<void>
  stopCamera: () => void
  capturePhoto: () => Promise<Blob | null>
  videoRef: RefObject<HTMLVideoElement>
}

export function useCamera(): UseCameraReturn {
  // Cast so the returned type matches React 18's JSX ref prop (RefObject<HTMLVideoElement>)
  const videoRef = useRef<HTMLVideoElement>(null) as RefObject<HTMLVideoElement>
  const streamRef = useRef<MediaStream | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const startCamera = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    const constraints: MediaStreamConstraints[] = [
      {
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // @ts-expect-error — focusMode is not yet in TypeScript's MediaTrackConstraints but is supported on Android Chrome
          focusMode: 'continuous',
        },
        audio: false,
      },
      { video: { facingMode: 'environment' }, audio: false },
      { video: true, audio: false },
    ]

    let acquiredStream: MediaStream | null = null

    for (const constraint of constraints) {
      try {
        acquiredStream = await navigator.mediaDevices.getUserMedia(constraint)
        break
      } catch (err) {
        if (
          err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
        ) {
          setError('Camera permission denied. Please allow camera access and try again.')
          setIsLoading(false)
          return
        }
        // Try next constraint
      }
    }

    if (!acquiredStream) {
      setError('Unable to access camera. Please ensure a camera is connected and try again.')
      setIsLoading(false)
      return
    }

    // Apply continuous autofocus after stream is acquired (works on Android Chrome)
    const videoTrack = acquiredStream.getVideoTracks()[0]
    if (videoTrack) {
      const capabilities = videoTrack.getCapabilities() as MediaTrackCapabilities & { focusMode?: string[] }
      if (capabilities.focusMode?.includes('continuous')) {
        videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {
          // Not all devices support this — ignore silently
        })
      }
    }

    streamRef.current = acquiredStream
    setStream(acquiredStream)

    if (videoRef.current) {
      videoRef.current.srcObject = acquiredStream
      try {
        await videoRef.current.play()
      } catch {
        // Play may fail if the component unmounts quickly; ignore
      }
    }

    setIsLoading(false)
  }, [])

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setStream(null)
  }, [])

  const capturePhoto = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current
    if (!video || !streamRef.current) return null

    const width = video.videoWidth || 1280
    const height = video.videoHeight || 720

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0, width, height)

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob),
        'image/jpeg',
        0.92,
      )
    })
  }, [])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
    }
  }, [])

  return { stream, error, isLoading, startCamera, stopCamera, capturePhoto, videoRef }
}
