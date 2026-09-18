import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { NodePreviewSurface, PreviewLoader } from './node-previews.js'
import { VideoPreview } from './VideoPreview.js'
import type { VideoPreferences } from './video-preview.js'
import { AudioTransport } from './AudioTransport.js'
import { PreviewDownload } from './PreviewDownload.js'

const LIVE_FRAME_ANNOUNCEMENT_INTERVAL_MS = 2_000

export function AppPreviewSurface(props: {
  readonly surface: NodePreviewSurface
  readonly loader: PreviewLoader
  readonly ariaLabelledBy: string
  readonly videoPreferences?: VideoPreferences | undefined
  readonly onVideoPreferences?: ((preferences: VideoPreferences) => void) | undefined
}) {
  let canvas: HTMLCanvasElement | undefined
  let announcedSourceKey: string | undefined
  let pendingFrameSourceKey: string | undefined
  let frameTimer: ReturnType<typeof setTimeout> | undefined
  let lastFrameAnnouncementAt = 0
  let revision = 0
  const [announcement, setAnnouncement] = createSignal('')
  const [videoDims, setVideoDims] = createSignal<{ width: number; height: number }>()

  const clearFrameTimer = (): void => {
    if (frameTimer === undefined) return
    clearTimeout(frameTimer)
    frameTimer = undefined
  }
  const previewReady = (): boolean => {
    const preview = props.surface.preview
    return preview?.status === undefined && (preview?.image !== undefined || preview?.src !== undefined)
  }
  const announce = (sourceKey: string, liveFrame: boolean): void => {
    announcedSourceKey = sourceKey
    pendingFrameSourceKey = undefined
    if (liveFrame) lastFrameAnnouncementAt = Date.now()
    revision += 1
    setAnnouncement(`Preview updated. Revision ${revision}.`)
  }

  createEffect(() => {
    const sourceKey = props.surface.source?.key
    if (sourceKey === undefined || !previewReady() || sourceKey === announcedSourceKey || sourceKey === pendingFrameSourceKey) return
    if (!sourceKey.startsWith('frame:')) {
      clearFrameTimer()
      pendingFrameSourceKey = undefined
      announce(sourceKey, false)
      return
    }

    const delay = Math.max(0, LIVE_FRAME_ANNOUNCEMENT_INTERVAL_MS - (Date.now() - lastFrameAnnouncementAt))
    if (delay === 0) {
      clearFrameTimer()
      announce(sourceKey, true)
      return
    }
    pendingFrameSourceKey = sourceKey
    if (frameTimer !== undefined) return
    frameTimer = setTimeout(() => {
      frameTimer = undefined
      const pending = pendingFrameSourceKey
      pendingFrameSourceKey = undefined
      if (pending !== undefined && props.surface.source?.key === pending && previewReady()) announce(pending, true)
    }, delay)
  })
  onCleanup(clearFrameTimer)

  createEffect(() => {
    const preview = props.surface.preview
    if (canvas === undefined || preview?.image === undefined || preview.status !== undefined) return
    const width = Math.max(1, Math.round(preview.width ?? 1))
    const height = Math.max(1, Math.round(preview.height ?? 1))
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) return
    context.clearRect(0, 0, width, height)
    try {
      context.drawImage(preview.image, 0, 0, width, height)
    } catch {
      // A detached ImageBitmap is replaced on the next preview refresh.
    }
  })

  const unavailable = (): boolean =>
    props.surface.preview?.status === 'unavailable' || props.surface.preview?.status === 'failed'
  const loadingLabel = (): string => {
    if (props.surface.preview?.statusMessage !== undefined) return props.surface.preview.statusMessage
    const raw = props.surface.preview?.kind
    const kind = raw === 'model3d' ? '3D model' : raw
    if (unavailable()) return kind === undefined ? 'Preview unavailable' : `${kind[0]!.toUpperCase()}${kind.slice(1)} unavailable`
    return kind === undefined ? 'Loading preview...' : `Loading ${kind}`
  }
  const countLabel = (): string | undefined => {
    const preview = props.surface.preview
    if (preview?.kind === 'video') return undefined
    return (preview?.count ?? 0) > 1 ? `${(preview?.index ?? 0) + 1}/${preview!.count}` : undefined
  }
  const dimensionsLabel = (): string | undefined => {
    const preview = props.surface.preview
    if (preview === undefined || preview.status !== undefined) return undefined
    if (preview.kind === 'video') {
      const dims = videoDims()
      return dims === undefined ? undefined : `${dims.width} x ${dims.height}`
    }
    if (preview.width === undefined || preview.height === undefined) return undefined
    return `${Math.round(preview.width)} x ${Math.round(preview.height)}`
  }
  createEffect(() => {
    props.surface.source?.key
    setVideoDims(undefined)
  })
  const mediaError = (): void => {
    const source = props.surface.source
    if (source !== undefined) props.loader.markUnavailable?.(source)
  }

  return (
    <div
      class="app-preview-surface"
      data-testid="app-preview-surface"
      role="region"
      aria-labelledby={props.ariaLabelledBy}
      aria-live="polite"
      aria-atomic="false"
    >
      <span class="app-view-assistive-text" data-testid="app-preview-announcement">{announcement()}</span>
      <Show when={props.surface.preview === undefined && props.surface.text === undefined}>
        <p class="app-preview-status" data-testid="app-preview-status" role="status">Preview appears after execution.</p>
      </Show>
      <Show when={props.surface.preview}>
        {(preview) => (
          <>
            <Show when={preview().src !== undefined && preview().kind === 'video'}>
              <VideoPreview media={preview()} appView preferences={props.videoPreferences}
                onPreferences={props.onVideoPreferences} onMediaError={mediaError} onDimensions={setVideoDims} />
            </Show>
            <Show when={preview().src !== undefined && preview().kind === 'audio'}>
              <AudioTransport media={preview()} onMediaError={mediaError} />
            </Show>
            <Show when={preview().image !== undefined && preview().status === undefined && preview().kind !== 'video'}>
              <canvas
                ref={canvas}
                class="app-preview-image"
                data-testid="app-preview-image"
                role="img"
                aria-label="Image preview"
              />
            </Show>
            <Show when={preview().image === undefined && (preview().src === undefined || preview().kind === 'model3d')}>
              <p class="app-preview-status" data-testid="app-preview-status" role="status">{loadingLabel()}</p>
            </Show>
            <Show when={dimensionsLabel() !== undefined || countLabel() !== undefined || preview().colorTransform !== undefined}>
              <div class="app-preview-caption" data-testid="app-preview-caption">
                <Show when={dimensionsLabel()}>
                  {(label) => <span class="app-preview-dimensions" data-testid="app-preview-dimensions">{label()}</span>}
                </Show>
                <Show when={countLabel()}>
                  {(label) => <span class="app-preview-count">{label()}</span>}
                </Show>
                <Show when={preview().kind !== 'video' && preview().colorTransform}>
                  {(label) => <span data-testid="app-preview-color-transform">Preview color: {label()}</span>}
                </Show>
              </div>
            </Show>
            <Show when={preview().kind !== 'video' && preview().download}>
              {(download) => (
                <PreviewDownload
                  class="app-preview-download"
                  testId="app-preview-download"
                  download={download()}
                  label={download().previewOnly === true || preview().colorTransform !== undefined ? 'Download preview' : 'Download output'}
                />
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={props.surface.text}>
        {(text) => (
          <pre classList={{ 'app-preview-text': true, stale: text().stale === true }} data-testid="app-preview-text">
            {text().text}
          </pre>
        )}
      </Show>
    </div>
  )
}
