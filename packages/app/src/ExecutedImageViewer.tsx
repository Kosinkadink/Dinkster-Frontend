import { createEffect, createMemo, createSignal as createSolidSignal, For, Show, onCleanup, type JSX } from 'solid-js'
import type { ConnectionStatus, ExecutionState } from '@dinkster/client'
import { executionStatusLabel } from './ExecutionActivityCard.js'
import { ModalSurface } from './ModalSurface.js'
import { executedImageLabel, type ExecutedImage, type ExecutedImageBatch } from './executed-image-inventory.js'
import { DigestValue } from './asset-browser/presentation.js'
import { useAppMessage } from './locale.js'
import './image-compare.css'

export interface ExecutionOutputProvenance {
  readonly backendId: string
  readonly backendLabel: string
  readonly backendAvailable: boolean
  readonly executionId: string
  readonly executionStatus: string
}

export function executionOutputProvenance(
  execution: Pick<ExecutionState, 'ref' | 'status'>,
  backend: {
    readonly label: string
    readonly connection: { readonly status: { get(): ConnectionStatus } }
  } | undefined,
): ExecutionOutputProvenance {
  return {
    backendId: String(execution.ref.connection),
    backendLabel: backend?.label ?? `${execution.ref.connection} - removed or disconnected`,
    backendAvailable: backend?.connection.status.get() === 'connected',
    executionId: execution.ref.prompt,
    executionStatus: executionStatusLabel(execution.status),
  }
}

const clamp = (value: number, count: number): number => Math.max(0, Math.min(Math.trunc(value), Math.max(0, count - 1)))

/** Each mounted tile owns its request and URL; unmounting cancels and releases both. */
function ViewerImage(props: {
  readonly image: ExecutedImage
  readonly alt: string
  readonly fit?: boolean
  readonly style?: JSX.CSSProperties
  readonly onLoad: (element: HTMLImageElement) => void
  readonly onError: (message?: string) => void
}) {
  const [url, setUrl] = createSolidSignal(props.image.url)
  const [color, setColor] = createSolidSignal<string>()
  createEffect(() => {
    const image = props.image
    if (image.load === undefined) { setUrl(image.url); return }
    const controller = new AbortController()
    let ownedUrl: string | undefined
    setUrl('')
    setColor(undefined)
    void image.load(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.available) { props.onError(`${result.reason}: ${result.error}`); return }
      if (!result.mime.startsWith('image/') || result.bytes.byteLength > 64 * 1024 * 1024) {
        props.onError('Image rendition exceeds the preview budget or is not an image.')
        return
      }
      ownedUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }))
      setColor(result.colorTransform)
      setUrl(ownedUrl)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) props.onError(error instanceof Error ? error.message : 'Image unavailable')
    })
    onCleanup(() => {
      controller.abort()
      if (ownedUrl !== undefined) URL.revokeObjectURL(ownedUrl)
    })
  })
  return <>
    <Show when={url()} fallback={<span role="status">Loading image...</span>}>
      <img src={url()} alt={props.alt} classList={{ fit: props.fit === true }} style={props.style}
        onLoad={(event) => props.onLoad(event.currentTarget)} onError={() => props.onError()} />
    </Show>
    <Show when={color()}>{(label) => <span class="output-preview-color">Preview color: {label()} (display only)</span>}</Show>
  </>
}

export function ExecutedImageFacts(props: {
  readonly image: ExecutedImage
  readonly availability: 'Checking' | 'Available' | 'Unavailable'
  readonly dimensions?: { readonly width: number; readonly height: number } | undefined
  readonly onReveal?: (() => void) | undefined
}) {
  const message = useAppMessage()
  return (
    <dl class="output-facts">
      <div><dt>Runtime node</dt><dd>{props.image.runtimeId}</dd></div>
      <div><dt>Output ID</dt><dd>{props.image.outputId}</dd></div>
      <div><dt>Descriptor</dt><dd>{props.image.descriptorIndex + 1}</dd></div>
      <div><dt>Source</dt><dd>{props.image.kind === 'rendition' ? 'Server rendition (display only)' : props.image.kind === 'asset' ? 'Content-addressed asset' : 'Legacy output file'}</dd></div>
      <div><dt>Media kind</dt><dd>Image</dd></div>
      <div><dt>Media type</dt><dd>{props.image.mediaType}</dd></div>
      <Show when={props.image.batchIndex !== undefined}><div><dt>Batch index</dt><dd>{props.image.batchIndex} (zero-based)</dd></div></Show>
      <Show when={props.image.listPath?.length}><div><dt>List path</dt><dd>{props.image.listPath?.join(',')} (zero-based, separate from batch)</dd></div></Show>
      <Show when={props.image.descriptor}>{(descriptor) => <>
        <div><dt>Type</dt><dd>{descriptor().typeId}</dd></div>
        <For each={Object.entries(descriptor().meta ?? {})}>{([key, value]) => <div><dt>{key}</dt><dd>{JSON.stringify(value)}</dd></div>}</For>
      </>}</Show>
      <Show when={props.dimensions}>{(dimensions) => <div><dt>Resolution</dt><dd>{dimensions().width} x {dimensions().height}</dd></div>}</Show>
      <Show when={props.image.name}><div><dt>Name</dt><dd>{props.image.name}</dd></div></Show>
      <Show when={props.image.virtualPath}>{(virtualPath) => <div><dt>{message('outputFile.writtenPath')}</dt><dd>
        <For each={virtualPath().split('/')}>{(segment, index) => <>{index() > 0 && <><span>/</span><wbr /></>}{segment}</>}</For>
      </dd></div>}</Show>
      <Show when={props.image.digest}>{(digest) => <div><dt>Asset digest</dt><dd><DigestValue digest={digest()} /></dd></div>}</Show>
      <Show when={props.image.subfolder !== undefined}><div><dt>Subfolder</dt><dd>{props.image.subfolder || '(root)'}</dd></div></Show>
      <Show when={props.image.fileType}><div><dt>File type</dt><dd>{props.image.fileType}</dd></div></Show>
      <div class="output-availability" data-availability={props.availability.toLowerCase()}>
        <dt>Availability</dt><dd>{props.availability}</dd>
      </div>
      <Show when={props.onReveal}><div><dt>{message('outputFile.file')}</dt><dd><button type="button" onClick={() => props.onReveal?.()}>{message('outputFile.showInFolder')}</button></dd></div></Show>
    </dl>
  )
}

export function ExecutedImageViewer(props: {
  readonly images: readonly ExecutedImage[]
  readonly batch?: ExecutedImageBatch | undefined
  readonly initialIndex: number
  readonly provenance: ExecutionOutputProvenance
  readonly onReveal?: ((image: ExecutedImage) => void) | undefined
  readonly onRequestClose: () => void
}) {
  const pageZoom = Math.max(1, Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1)
  const compactLayout = window.innerWidth / pageZoom <= 700
  const count = () => props.batch?.count ?? props.images.length
  const imageAt = (index: number) => props.batch?.imageAt(index) ?? props.images[index]
  const [index, setIndex] = createSolidSignal(clamp(props.initialIndex, count()))
  const [rightIndex, setRightIndex] = createSolidSignal(clamp(props.initialIndex + 1, count()))
  const [mode, setMode] = createSolidSignal<'single' | 'grid' | 'slider' | 'side-by-side'>('single')
  const [split, setSplit] = createSolidSignal(50)
  const [gridPage, setGridPage] = createSolidSignal(Math.floor(index() / 4))
  const gridImages = createMemo(() => Array.from({ length: Math.min(4, Math.max(0, count() - gridPage() * 4)) }, (_, slot) => {
    const index = gridPage() * 4 + slot
    return { image: imageAt(index)!, index }
  }))
  const [scale, setScale] = createSolidSignal<'fit' | number>('fit')
  const [failedKeys, setFailedKeys] = createSolidSignal<ReadonlyMap<string, string>>(new Map())
  const [loadedKeys, setLoadedKeys] = createSolidSignal<ReadonlySet<string>>(new Set())
  const [naturalSizes, setNaturalSizes] = createSolidSignal<ReadonlyMap<string, { readonly width: number; readonly height: number }>>(new Map())
  const current = createMemo(() => imageAt(clamp(index(), count())))
  const right = createMemo(() => imageAt(clamp(rightIndex(), count())))
  const availability = (image: ExecutedImage): 'Checking' | 'Available' | 'Unavailable' =>
    failedKeys().has(image.key) ? 'Unavailable' : loadedKeys().has(image.key) ? 'Available' : 'Checking'
  const select = (next: number): void => {
    setIndex(clamp(next, count()))
    setMode('single')
  }
  const markFailed = (key: string, message = 'Image unavailable'): void => {
    setFailedKeys((current) => new Map([...current].slice(-63)).set(key, message))
  }
  const recordSize = (image: ExecutedImage, element: HTMLImageElement): void => {
    setLoadedKeys((current) => new Set([...current].slice(-63)).add(image.key))
    setNaturalSizes((current) => new Map([...current].slice(-63)).set(image.key, { width: element.naturalWidth, height: element.naturalHeight }))
  }
  const imageStyle = (image: ExecutedImage): JSX.CSSProperties => {
    const value = scale()
    const size = naturalSizes().get(image.key)
    if (value === 'fit' || size === undefined) return {}
    return {
      width: `${size.width * value / 100}px`,
      height: `${size.height * value / 100}px`,
      'max-width': 'none',
    }
  }
  const page = (delta: number): void => select(index() + delta)
  createEffect(() => {
    if (index() >= count()) setIndex(Math.max(0, count() - 1))
  })

  const CompareSide = (side: { readonly name: 'Left' | 'Right' }) => {
    const selected = () => side.name === 'Left' ? index() : rightIndex()
    const change = (next: number) => side.name === 'Left' ? setIndex(clamp(next, count())) : setRightIndex(clamp(next, count()))
    return <div class="output-compare-selection" role="group" aria-label={`${side.name} batch selection`}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation(); change(selected() + (event.key === 'ArrowRight' ? 1 : -1))
        }
      }}>
      <strong>{side.name}</strong>
      <button type="button" aria-label={`Previous ${side.name.toLowerCase()} image`} disabled={selected() === 0} onClick={() => change(selected() - 1)}>Previous</button>
      <label>Image <input aria-label={`${side.name} image number`} type="number" min="1" max={count()} value={selected() + 1}
        onChange={(event) => {
          const input = event.currentTarget
          if (Number.isFinite(input.valueAsNumber)) change(input.valueAsNumber - 1)
          input.value = String(selected() + 1)
        }} /></label>
      <span>of {count()}</span>
      <button type="button" aria-label={`Next ${side.name.toLowerCase()} image`} disabled={selected() >= count() - 1} onClick={() => change(selected() + 1)}>Next</button>
    </div>
  }

  return (
    <ModalSurface
      title="Execution outputs"
      ariaLabel="Execution output viewer"
      modalId="execution-images"
      testId="output-viewer"
      style={{
        '--output-page-zoom': String(pageZoom),
        width: `min(1120px, calc(100vw / ${pageZoom} - 24px))`,
        height: `min(820px, calc(100vh / ${pageZoom} - 24px))`,
      }}
      onRequestClose={props.onRequestClose}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return
        if (mode() !== 'single') return
        if (event.key === 'ArrowLeft') { event.preventDefault(); page(-1) }
        if (event.key === 'ArrowRight') { event.preventDefault(); page(1) }
      }}
    >
      <section class="output-execution-provenance" aria-label="Execution provenance">
        <div><span>Backend</span><strong>{props.provenance.backendLabel}</strong></div>
        <div><span>Backend ID</span><strong>{props.provenance.backendId}</strong></div>
        <div><span>Execution</span><strong>{props.provenance.executionId}</strong></div>
        <div><span>Status</span><strong>{props.provenance.executionStatus}</strong></div>
        <Show when={!props.provenance.backendAvailable}>
          <p role="status">Execution owner removed or disconnected. Retained output routes are used when available.</p>
        </Show>
      </section>
      <div class="output-viewer-toolbar" role="toolbar" aria-label="Image viewer controls">
        <button type="button" aria-pressed={mode() === 'single'} onClick={() => setMode('single')}>Single</button>
        <button type="button" aria-label="Show all images" aria-pressed={mode() === 'grid'} onClick={() => { setGridPage(Math.floor(index() / 4)); setMode('grid') }}>Grid</button>
        <button type="button" aria-pressed={mode() === 'slider'} onClick={() => setMode('slider')}>Compare slider</button>
        <button type="button" aria-pressed={mode() === 'side-by-side'} onClick={() => setMode('side-by-side')}>Side by side</button>
        <Show when={mode() === 'single'}>
          <button type="button" aria-label="Previous image" disabled={index() <= 0} onClick={() => page(-1)}>Previous</button>
          <span data-testid="output-viewer-position" aria-live="polite">{index() + 1} / {count()}</span>
          <button type="button" aria-label="Next image" disabled={index() >= count() - 1} onClick={() => page(1)}>Next</button>
          <button type="button" aria-label="Fit image" aria-pressed={scale() === 'fit'} onClick={() => setScale('fit')}>Fit</button>
          <button type="button" aria-label="100%" aria-pressed={scale() === 100} onClick={() => setScale(100)}>100%</button>
          <button type="button" aria-label="Zoom out" onClick={() => setScale((value) => Math.max(25, (value === 'fit' ? 100 : value) - 25))}>-</button>
          <button type="button" aria-label="Zoom in" onClick={() => setScale((value) => Math.min(400, (value === 'fit' ? 100 : value) + 25))}>+</button>
        </Show>
        <Show when={mode() === 'grid'}>
          <button type="button" disabled={gridPage() === 0} onClick={() => setGridPage((page) => page - 1)}>Previous grid page</button>
          <span>{gridPage() * 4 + 1}-{Math.min(count(), gridPage() * 4 + 4)} of {count()}</span>
          <button type="button" disabled={(gridPage() + 1) * 4 >= count()} onClick={() => setGridPage((page) => page + 1)}>Next grid page</button>
        </Show>
      </div>
      <Show when={mode() === 'slider' || mode() === 'side-by-side'}>
        <div class="output-compare-controls"><CompareSide name="Left" /><CompareSide name="Right" /></div>
        <Show when={mode() === 'slider'}>
          <label class="output-compare-range">Compare split: {split()}%
            <input type="range" min="0" max="100" value={split()} aria-label="Compare split" onInput={(event) => setSplit(event.currentTarget.valueAsNumber)} />
          </label>
        </Show>
        <div class="output-compare-stage" classList={{ slider: mode() === 'slider' }} data-testid="output-compare-stage">
          <For each={[current, right]}>{(image, side) => <Show when={image()} keyed>{(selected) =>
            <figure style={mode() === 'slider' && side() === 0 ? { 'clip-path': `inset(0 ${100 - split()}% 0 0)`, 'z-index': 1 } : {}}>
              <Show when={!failedKeys().has(selected.key)} fallback={<span role="alert">{failedKeys().get(selected.key)}</span>}>
              <ViewerImage image={selected} alt={`${side() === 0 ? 'Left' : 'Right'} image ${selected.batchIndex === undefined ? (side() === 0 ? index() : rightIndex()) + 1 : selected.batchIndex + 1}`}
                fit onLoad={(element) => recordSize(selected, element)} onError={(message) => markFailed(selected.key, message)} />
              </Show>
            </figure>
          }</Show>}</For>
        </div>
      </Show>
      <Show when={mode() === 'single' || mode() === 'grid'}>
      <Show when={mode() === 'grid'} fallback={
        <Show when={current()} keyed fallback={<div class="output-viewer-unavailable" role="alert">No execution images are available.</div>}>
          {(image) => (
            <div class="output-viewer-single" classList={{ compact: compactLayout }}>
              <div class="output-viewer-stage" data-testid="output-viewer-image" data-scale={scale()}>
                <Show
                  when={!failedKeys().has(image.key)}
                  fallback={<div class="output-viewer-unavailable" role="alert"><strong>{failedKeys().get(image.key)}</strong><span>{image.name ?? image.digest ?? image.outputId}</span></div>}
                >
                  <ViewerImage
                    image={image}
                    alt={executedImageLabel(image, index(), count())}
                    fit={scale() === 'fit'}
                    style={imageStyle(image)}
                    onLoad={(element) => recordSize(image, element)}
                    onError={(message) => markFailed(image.key, message)}
                  />
                </Show>
              </div>
              <aside class="output-viewer-details" aria-label="Selected output identity">
                <h3>{props.batch === undefined ? 'Output' : 'Batch image'} {index() + 1} of {count()}</h3>
                <ExecutedImageFacts image={image} availability={availability(image)} dimensions={naturalSizes().get(image.key)} {...(props.onReveal === undefined || image.virtualPath === undefined ? {} : { onReveal: () => props.onReveal?.(image) })} />
              </aside>
            </div>
          )}
        </Show>
      }>
        <div class="output-viewer-grid" data-testid="output-viewer-grid" role="list" aria-label={`${count()} execution images`}>
          <For each={gridImages()}>{({ image, index: itemIndex }) => (
            <div role="listitem">
              <button
                type="button"
                aria-label={executedImageLabel(image, itemIndex, count())}
                aria-pressed={itemIndex === index()}
                onClick={() => select(itemIndex)}
              >
                <span class="output-viewer-grid-preview">
                  <Show when={!failedKeys().has(image.key)} fallback={<span class="output-viewer-grid-unavailable">Unavailable</span>}>
                    <ViewerImage image={image} alt="" onLoad={(element) => recordSize(image, element)} onError={(message) => markFailed(image.key, message)} />
                  </Show>
                </span>
                <span class="output-viewer-grid-position">{props.batch === undefined ? 'Output' : 'Batch image'} {itemIndex + 1}</span>
                <span class="output-viewer-grid-identity">{image.name ?? image.digest ?? image.outputId}</span>
                <span class="output-viewer-grid-provenance">Node {image.runtimeId} - {image.outputId} - {availability(image)}</span>
              </button>
            </div>
          )}</For>
        </div>
      </Show>
      </Show>
    </ModalSurface>
  )
}
