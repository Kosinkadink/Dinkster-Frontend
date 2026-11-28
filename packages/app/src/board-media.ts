import { boardMediaKindOf } from '@dinkster/core'
import type { BoardMediaFile } from './board-workspace.js'

/** Browser metadata is optional; an unsupported codec does not invent dimensions. */
export function inspectBoardMedia(file: File, signal: AbortSignal): Promise<BoardMediaFile> {
  signal.throwIfAborted()
  if (!boardMediaKindOf(file.type)) return Promise.reject(new Error(`Unsupported Board media: ${file.name}`))
  const url = URL.createObjectURL(file)
  return inspectBoardMediaMetadata(url, file.type, signal)
    .then((metadata) => ({ file, ...metadata })).finally(() => URL.revokeObjectURL(url))
}

/** Saved assets and local imports use the same optional browser codec facts. */
export function inspectBoardMediaMetadata(url: string, mediaType: string,
  signal: AbortSignal,
): Promise<Omit<BoardMediaFile, 'file'>> {
  signal.throwIfAborted()
  const kind = boardMediaKindOf(mediaType)
  if (!kind) return Promise.reject(new Error(`Unsupported Board media: ${mediaType}`))
  if (typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve({})
  const element = kind === 'picture' ? new Image() : document.createElement(kind === 'video' ? 'video' : 'audio')
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (metadata: Omit<BoardMediaFile, 'file'> = {}) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(metadata)
    }
    const cancel = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      element.onload = null
      if (element instanceof HTMLMediaElement) element.onloadedmetadata = null
      element.onerror = null
      element.removeAttribute('src')
      if (element instanceof HTMLMediaElement) element.load()
    }
    const timer = setTimeout(() => finish(), 10_000)
    signal.addEventListener('abort', cancel, { once: true })
    element.onerror = () => finish()
    if (element instanceof HTMLImageElement) {
      element.onload = () => finish(element.naturalWidth > 0 && element.naturalHeight > 0
        ? { width: element.naturalWidth, height: element.naturalHeight } : {})
    } else {
      element.preload = 'metadata'
      element.onloadedmetadata = () => finish({
        ...(element instanceof HTMLVideoElement && element.videoWidth > 0 && element.videoHeight > 0
          ? { width: element.videoWidth, height: element.videoHeight } : {}),
        ...(Number.isFinite(element.duration) && element.duration >= 0 ? { duration: element.duration } : {}),
      })
    }
    element.src = url
  })
}
