import { Show, createResource, onCleanup } from 'solid-js'

/**
 * Poster still for a GLB or splat PLY source, rendered lazily through the
 * 3D viewer chunk. Used by asset-picker selection panes; node previews and
 * browser thumbnails go through the preview loader and collection
 * thumbRender instead.
 */
export function Model3dPosterImage(props: {
  readonly src: string
  readonly name: string
  readonly mime?: string | undefined
}) {
  let request = 0
  onCleanup(() => { request += 1 })
  const [poster] = createResource(
    () => ({ src: props.src, mime: props.mime }),
    async (source) => {
      const current = ++request
      const viewer = await import('./model3d-viewer.js')
      if (current !== request) return undefined
      return viewer.renderModel3dPosterUrl(source.src, source.mime)
    },
  )
  const url = (): string | undefined => (poster.state === 'ready' ? poster() : undefined)
  return (
    <Show when={url()} fallback={
      <Show when={poster.state === 'errored'} fallback={
        <div class="asset-preview asset-preview-fallback" data-testid="asset-model3d-loading" role="status">
          <span>Rendering 3D preview...</span>
        </div>
      }>
        <div class="asset-preview asset-preview-fallback" data-testid="asset-model3d-fallback" role="status">
          <span>3D preview unavailable.</span>
          <a href={props.src} download={props.name}>Download model</a>
        </div>
      </Show>
    }>
      {(value) => (
        <img class="asset-preview" data-testid="asset-model3d-preview" src={value()} alt="3D model preview" />
      )}
    </Show>
  )
}
