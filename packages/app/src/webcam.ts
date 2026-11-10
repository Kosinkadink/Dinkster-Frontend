export interface WebcamDimensions {
  readonly width?: number
  readonly height?: number
}

/** Capture one PNG and release permission-scoped tracks, including late grants. */
export async function captureWebcamFrame(
  dimensions: WebcamDimensions = {},
  signal?: AbortSignal,
): Promise<File> {
  signal?.throwIfAborted()
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('Camera capture requires a secure browser context.', 'NotSupportedError')
  }
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  let stream: MediaStream | undefined
  const release = () => {
    for (const track of stream?.getTracks() ?? []) track.stop()
    video.srcObject = null
  }
  signal?.addEventListener('abort', release, { once: true })
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: true,
    })
    signal?.throwIfAborted()
    video.srcObject = stream
    await video.play()
    signal?.throwIfAborted()
    if (!video.videoWidth || !video.videoHeight) {
      throw new DOMException('Camera returned an empty frame.', 'NotReadableError')
    }
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width || video.videoWidth
    canvas.height = dimensions.width ? dimensions.height ?? 0 : video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Camera capture requires a canvas context.')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error('Camera PNG encoding failed.')),
      'image/png',
    ))
    signal?.throwIfAborted()
    return new File([blob], 'webcam.png', { type: 'image/png' })
  } finally {
    signal?.removeEventListener('abort', release)
    release()
  }
}

export function webcamError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
