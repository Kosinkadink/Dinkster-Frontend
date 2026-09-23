import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import {
  IMAGE_BLEND_MODES,
  IMAGE_FIXED_POINT_SCALE,
  IMAGE_MASK_COMBINE_MODES,
  IMAGE_OPACITY_MAX,
  IMAGE_OUTPUT_FORMATS,
  MAX_IMAGE_CANVAS_DIMENSION,
  asImageResourceId,
  connectSharedImageDocumentSession,
  createLocalImageDocumentSession,
  formatNumber,
  imageOutputPolicyOf,
  orderedImageLayerIds,
  serializeImageDocument,
  type CollabSessionDescriptor,
  type ImageDocument,
  type ImageDocumentCommandInvocation,
  type ImageDocumentSession,
  type ImageLayer,
  type ImageRasterResource,
  type MessageParams,
  type SharedImageDocumentSession,
} from '@dinkster/core'
import {
  IMAGE_DOCUMENT_MEDIA_TYPE,
  type DinksterConnection,
  type LibraryRecord,
} from '@dinkster/client'
import type { AppState } from './app-state.js'
import { COLLAB_SCOPE } from './collab.js'
import {
  ImageDocumentLocalStore,
  importSingleRaster,
  prepareImageRaster,
  type PreparedImageRaster,
  type ImageDocumentDraft,
} from './image-document-local.js'
import {
  type VerifiedImageDocumentRender,
  adoptImageDocumentForRender,
  hydrateImageDocumentResources,
  openImageDocumentFromLibrary,
  renderAdoptedImageDocument,
  saveImageDocumentToLibrary,
  uploadImageDocumentResource,
} from './image-document-library.js'
import { ImageDocumentPreviewRenderer } from './image-document-renderer.js'
import {
  exportImageDocumentRecipe,
  exportImageDocumentSnapshot,
  openGraphImageDocument,
  type GraphImageDocumentRequest,
  type ImageDocumentGraphOrigin,
} from './image-document-graph.js'
import { useAppMessage } from './locale.js'
import { activeProjectId } from './projects.js'
import { ProductButton, ProductCheckbox } from './ProductControls.js'
import { ProductEmptyState } from './ProductSurfaces.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductSlider } from './ProductSlider.js'
import { shortcutSuppressed } from './settings.js'
import { useSignal } from './solid-adapter.js'

const LIBRARY_SCOPE = 'local'

interface OpenImageDocument {
  readonly session: ImageDocumentSession
  readonly stop: () => void
  name: string
  draft: ImageDocumentDraft
  persist: Promise<void>
  hydrate: Promise<void>
  authoritative?: VerifiedImageDocumentRender
  origin?: ImageDocumentGraphOrigin
  readonly collaboration?: {
    readonly descriptor: CollabSessionDescriptor
    readonly baseUrl: string
    readonly session: SharedImageDocumentSession
  }
}

export interface ImageWorkspaceTab {
  readonly id: string
  readonly lineage: string
  readonly kind: 'image'
  readonly title: string
  readonly shared: boolean
  readonly activate: () => void
  readonly close: () => void
}

interface LayerTreeRow {
  readonly layer: ImageLayer
  readonly parentId: string | null
  readonly index: number
  readonly siblingCount: number
  readonly depth: number
}

interface LocalizedImageDocumentError {
  readonly key: string
  readonly params?: MessageParams
}

function layerRows(documentValue: ImageDocument): readonly LayerTreeRow[] {
  const rows: LayerTreeRow[] = []
  const visit = (
    ids: readonly string[],
    parentId: string | null,
    depth: number,
  ): void => {
    orderedImageLayerIds(documentValue, ids)
      .map((id, index) => ({ id, index }))
      .reverse()
      .forEach(({ id, index }) => {
        const layer = documentValue.layers[id]!
        rows.push({ layer, parentId, index, siblingCount: ids.length, depth })
        if (layer.kind === 'group')
          visit(layer.childLayerIds, layer.id, depth + 1)
      })
  }
  visit(documentValue.rootLayerIds, null, 0)
  return rows
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ImageDocumentEditor(props: {
  readonly active: () => boolean
  readonly entry: OpenImageDocument
  readonly store: ImageDocumentLocalStore
  readonly busy: () => boolean
  readonly editingBlocked: () => boolean
  readonly error: () => string | undefined
  readonly metadataTick: () => number
  readonly onError: (message: string | undefined) => void
  readonly onName: (name: string) => void
  readonly onSave: () => Promise<void>
  readonly onPublish: () => Promise<void>
  readonly onExport: () => Promise<void>
  readonly onExportRecipe?: (() => Promise<void>) | undefined
  readonly onRender: (
    document: ImageDocument,
    selector: string,
  ) => Promise<VerifiedImageDocumentRender>
  readonly onResourceReady: (resource: PreparedImageRaster) => Promise<void>
  readonly resourceTick: () => number
}) {
  const message = useAppMessage()
  const documentValue = useSignal(props.entry.session.document)
  const [selectedLayerId, setSelectedLayerId] = createSignal(
    documentValue().rootLayerIds.at(-1) ?? '',
  )
  const [renderError, setRenderError] = createSignal<string>()
  const [authoritativeError, setAuthoritativeError] = createSignal<string>()
  const [authoritativeBusy, setAuthoritativeBusy] = createSignal(false)
  const [authoritativeResult, setAuthoritativeResult] = createSignal<
    VerifiedImageDocumentRender | undefined
  >(props.entry.authoritative)
  const [renderSelector, setRenderSelector] = createSignal('composite')
  const [cropX, setCropX] = createSignal(0)
  const [cropY, setCropY] = createSignal(0)
  const [cropWidth, setCropWidth] = createSignal(documentValue().canvas.width)
  const [cropHeight, setCropHeight] = createSignal(
    documentValue().canvas.height,
  )
  const [resizeWidth, setResizeWidth] = createSignal(
    documentValue().canvas.width,
  )
  const [resizeHeight, setResizeHeight] = createSignal(
    documentValue().canvas.height,
  )
  const renderer = new ImageDocumentPreviewRenderer(props.store)
  let preview!: HTMLCanvasElement
  let layerInput!: HTMLInputElement
  let maskInput!: HTMLInputElement
  let pendingRender: ImageDocument | undefined
  let rendering = false
  let rendererLive = true
  let receivedAuthoritative = props.entry.authoritative
  onCleanup(() => {
    rendererLive = false
    renderer.dispose()
  })

  const entryName = (): string => {
    props.metadataTick()
    return props.entry.name
  }
  const libraryLink = () => {
    props.metadataTick()
    return props.entry.draft.library
  }
  const selected = createMemo((): ImageLayer | undefined => {
    const current = documentValue()
    return (
      current.layers[selectedLayerId()] ??
      current.layers[current.rootLayerIds.at(-1) ?? '']
    )
  })
  const canUndo = (): boolean => {
    documentValue()
    return props.entry.session.canUndo
  }
  const canRedo = (): boolean => {
    documentValue()
    return props.entry.session.canRedo
  }
  const selectedRow = (): LayerTreeRow | undefined =>
    layerRows(documentValue()).find((row) => row.layer.id === selectedLayerId())
  const renderTargets = createMemo(() => [
    {
      id: 'composite',
      label: message('imageDocument.editor.target.composite'),
      value: 'composite',
    },
    ...layerRows(documentValue()).map((row) => ({
      id: `layer:${row.layer.id}`,
      label: message('imageDocument.editor.target.layer', {
        name: row.layer.name || row.layer.id,
      }),
      value: `layer:${row.layer.id}`,
    })),
    ...Object.values(documentValue().masks).map((mask) => ({
      id: `mask:${mask.id}`,
      label: message('imageDocument.editor.target.mask', { id: mask.id }),
      value: `mask:${mask.id}`,
    })),
  ])
  const authoritativeStale = createMemo((): boolean => {
    const result = authoritativeResult()
    return (
      result !== undefined &&
      result.sourceCanonical !== serializeImageDocument(documentValue())
    )
  })
  createEffect(() => {
    props.metadataTick()
    const received = props.entry.authoritative
    if (received !== undefined && received !== receivedAuthoritative) {
      receivedAuthoritative = received
      setRenderSelector('composite')
      setAuthoritativeError(undefined)
      setAuthoritativeResult(received)
    }
  })
  const renderAuthoritative = async (): Promise<void> => {
    if (authoritativeBusy()) return
    const snapshot = documentValue()
    const selector = renderSelector()
    setAuthoritativeBusy(true)
    setAuthoritativeError(undefined)
    try {
      setAuthoritativeResult(await props.onRender(snapshot, selector))
    } catch (error) {
      setAuthoritativeError(messageOf(error))
    } finally {
      setAuthoritativeBusy(false)
    }
  }
  const dispatch = (invocation: ImageDocumentCommandInvocation): boolean => {
    if (props.editingBlocked()) return false
    const outcome = props.entry.session.dispatch(invocation)
    if (outcome.ok) {
      props.onError(undefined)
      return true
    }
    props.onError(
      outcome.diagnostics[0]?.message ??
        message('imageDocument.editor.error.editRefused'),
    )
    return false
  }

  const renderLatest = async (): Promise<void> => {
    if (rendering) return
    rendering = true
    while (rendererLive && pendingRender !== undefined) {
      const current = pendingRender
      pendingRender = undefined
      const rendered = document.createElement('canvas')
      try {
        await renderer.draw(current, rendered)
        if (!rendererLive || pendingRender !== undefined) continue
        preview.width = rendered.width
        preview.height = rendered.height
        preview.getContext('2d')?.drawImage(rendered, 0, 0)
        setRenderError(undefined)
      } catch (error) {
        if (rendererLive && pendingRender === undefined) {
          preview
            .getContext('2d')
            ?.clearRect(0, 0, preview.width, preview.height)
          setRenderError(messageOf(error))
        }
      }
    }
    rendering = false
  }
  createEffect(() => {
    const current = documentValue()
    if (current.layers[selectedLayerId()] === undefined)
      setSelectedLayerId(current.rootLayerIds.at(-1) ?? '')
    if (!renderTargets().some((target) => target.value === renderSelector())) {
      setRenderSelector('composite')
    }
  })
  createEffect(() => {
    props.resourceTick()
    pendingRender = documentValue()
    void renderLatest()
  })

  const onShortcut = (event: KeyboardEvent): void => {
    if (
      !props.active() ||
      event.defaultPrevented ||
      shortcutSuppressed(event) ||
      props.editingBlocked() ||
      event.altKey ||
      !(event.ctrlKey || event.metaKey)
    )
      return
    const key = event.key.toLowerCase()
    if (key === 'z') {
      event.preventDefault()
      if (event.shiftKey) props.entry.session.redo()
      else props.entry.session.undo()
    } else if (key === 'y') {
      event.preventDefault()
      props.entry.session.redo()
    } else if (key === 's') {
      event.preventDefault()
      void props.onSave()
    }
  }
  window.addEventListener('keydown', onShortcut)
  onCleanup(() => window.removeEventListener('keydown', onShortcut))

  const updateLayer = (
    changes: Omit<
      Extract<
        ImageDocumentCommandInvocation,
        { command: 'image.layer.update' }
      >['params'],
      'layerId'
    >,
  ): void => {
    const layer = selected()
    if (layer)
      dispatch({
        command: 'image.layer.update',
        params: { layerId: layer.id, ...changes },
      })
  }
  const commitInteger = (
    raw: string,
    current: number,
    apply: (value: number) => void,
  ): void => {
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isSafeInteger(value)) {
      props.onError(message('imageDocument.editor.error.integerRequired'))
      return
    }
    props.onError(undefined)
    if (value !== current) apply(value)
  }
  const updateTransform = (
    field: 'a' | 'b' | 'c' | 'd' | 'tx' | 'ty',
    value: number,
  ): void => {
    const layer = selected()
    if (!layer || !Number.isFinite(value)) return
    const { a, b, c, d, tx, ty } = layer.transform
    updateLayer({
      transform: {
        a,
        b,
        c,
        d,
        tx,
        ty,
        [field]: Math.round(value * IMAGE_FIXED_POINT_SCALE),
      },
    })
  }
  const moveSelected = (offset: -1 | 1): void => {
    const row = selectedRow()
    if (!row) return
    dispatch({
      command: 'image.layer.move',
      params: {
        layerId: row.layer.id,
        parentId: row.parentId,
        index: row.index + offset,
      },
    })
  }
  const groupSelected = (): void => {
    const row = selectedRow()
    if (!row || props.editingBlocked()) return
    const siblings = layerRows(documentValue()).filter(
      (candidate) => candidate.parentId === row.parentId,
    )
    const below = siblings.find(
      (candidate) => candidate.index === row.index - 1,
    )
    const outcome = props.entry.session.dispatch({
      command: 'image.layer.group',
      params: {
        layerIds:
          below === undefined ? [row.layer.id] : [below.layer.id, row.layer.id],
        name: 'Group',
      },
    })
    if (!outcome.ok)
      props.onError(
        outcome.diagnostics[0]?.message ??
          message('imageDocument.editor.error.groupRefused'),
      )
    else {
      props.onError(undefined)
      if (outcome.created?.layerId) setSelectedLayerId(outcome.created.layerId)
    }
  }
  const prepareAndStage = async (file: File) => {
    const prepared = await prepareImageRaster(file)
    await props.store.stageResource(
      { ...prepared.resource, id: asImageResourceId('r0') },
      prepared.bytes,
      `${prepared.name}.png`,
    )
    await props.onResourceReady(prepared)
    return prepared
  }
  const addLayer = async (file: File): Promise<void> => {
    if (props.editingBlocked()) return
    try {
      const prepared = await prepareAndStage(file)
      if (props.editingBlocked()) return
      const outcome = props.entry.session.dispatch({
        command: 'image.layer.addRaster',
        params: {
          parentId: null,
          index: documentValue().rootLayerIds.length,
          name: prepared.name,
          resource: prepared.resource,
          sourceRect: {
            x: 0,
            y: 0,
            width: prepared.resource.width,
            height: prepared.resource.height,
          },
        },
      })
      if (!outcome.ok)
        throw new Error(
          outcome.diagnostics[0]?.message ??
            message('imageDocument.editor.error.layerImportRefused'),
        )
      if (outcome.created?.layerId) setSelectedLayerId(outcome.created.layerId)
      props.onError(undefined)
    } catch (error) {
      props.onError(messageOf(error))
    } finally {
      layerInput.value = ''
    }
  }
  const addMask = async (file: File): Promise<void> => {
    if (props.editingBlocked()) return
    const layer = selected()
    if (!layer) return
    try {
      const prepared = await prepareAndStage(file)
      if (props.editingBlocked()) return
      const outcome = props.entry.session.dispatch({
        command: 'image.mask.addRaster',
        params: {
          ownerLayerId: layer.id,
          index: layer.maskIds.length,
          resource: prepared.resource,
          sourceRect: {
            x: 0,
            y: 0,
            width: prepared.resource.width,
            height: prepared.resource.height,
          },
        },
      })
      if (!outcome.ok)
        throw new Error(
          outcome.diagnostics[0]?.message ??
            message('imageDocument.editor.error.maskImportRefused'),
        )
      props.onError(undefined)
    } catch (error) {
      props.onError(messageOf(error))
    } finally {
      maskInput.value = ''
    }
  }

  return (
    <section class="image-document-editor" data-testid="image-document-editor">
      <header class="image-document-toolbar">
        <div class="image-document-identity">
          <input
            aria-label={message('imageDocument.editor.field.documentName')}
            value={entryName()}
            disabled={props.editingBlocked()}
            onChange={(event) =>
              props.onName(event.currentTarget.value.trim() || 'Untitled image')
            }
          />
          <span>
            {documentValue().canvas.width} x {documentValue().canvas.height}
          </span>
          <Show when={libraryLink()}>
            <span class="image-document-published">
              {message('imageDocument.editor.status.published')}
            </span>
          </Show>
        </div>
        <div class="image-document-actions">
          <button
            type="button"
            disabled={props.busy() || props.editingBlocked() || !canUndo()}
            onClick={() => props.entry.session.undo()}
          >
            {message('imageDocument.editor.action.undo')}
          </button>
          <button
            type="button"
            disabled={props.busy() || props.editingBlocked() || !canRedo()}
            onClick={() => props.entry.session.redo()}
          >
            {message('imageDocument.editor.action.redo')}
          </button>
          <button
            type="button"
            disabled={props.busy()}
            onClick={() => void props.onSave()}
          >
            {message('imageDocument.editor.action.saveDraft')}
          </button>
          <button
            type="button"
            disabled={props.busy()}
            onClick={() => void props.onExport()}
          >
            {message('imageDocument.editor.action.exportSnapshot')}
          </button>
          <Show when={props.onExportRecipe} keyed>
            {(exportRecipe) => (
              <button
                type="button"
                disabled={props.busy()}
                onClick={() => void exportRecipe()}
              >
                {message('imageDocument.editor.action.exportRecipe')}
              </button>
            )}
          </Show>
          <button
            type="button"
            class="primary"
            disabled={props.busy()}
            onClick={() => void props.onPublish()}
          >
            {props.busy()
              ? message('imageDocument.editor.action.publishing')
              : libraryLink()
                ? message('imageDocument.editor.action.updateLibrary')
                : message('imageDocument.editor.action.publish')}
          </button>
        </div>
      </header>
      <div class="image-document-body">
        <aside
          class="image-document-layers"
          aria-label={message('imageDocument.editor.region.layers')}
        >
          <header>
            <strong>{message('imageDocument.editor.title.layers')}</strong>
            <button
              type="button"
              disabled={props.editingBlocked()}
              onClick={() => layerInput.click()}
            >
              {message('imageDocument.editor.action.addRaster')}
            </button>
          </header>
          <input
            ref={layerInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) void addLayer(file)
            }}
          />
          <div class="image-document-layer-list">
            <For each={layerRows(documentValue()).map((row) => row.layer.id)}>
              {(layerId) => {
                const row = () =>
                  layerRows(documentValue()).find(
                    (candidate) => candidate.layer.id === layerId,
                  )!
                return (
                  <button
                    type="button"
                    class="image-document-layer-row"
                    classList={{ selected: layerId === selectedLayerId() }}
                    aria-pressed={layerId === selectedLayerId()}
                    style={{ 'padding-left': `${10 + row().depth * 14}px` }}
                    onClick={() => setSelectedLayerId(layerId)}
                  >
                    <span>
                      {row().layer.visible
                        ? message('imageDocument.editor.status.on')
                        : message('imageDocument.editor.status.off')}
                    </span>
                    <strong>
                      {row().layer.name ||
                        message('imageDocument.editor.status.unnamedLayer')}
                    </strong>
                    <small>
                      {row().layer.kind} -{' '}
                      {Math.round(
                        (row().layer.opacity / IMAGE_OPACITY_MAX) * 100,
                      )}
                      %
                    </small>
                  </button>
                )
              }}
            </For>
          </div>
          <div class="image-document-layer-actions">
            <button
              type="button"
              disabled={
                !selectedRow() ||
                selectedRow()!.index >= selectedRow()!.siblingCount - 1
              }
              onClick={() => moveSelected(1)}
            >
              {message('imageDocument.editor.action.raise')}
            </button>
            <button
              type="button"
              disabled={!selectedRow() || selectedRow()!.index === 0}
              onClick={() => moveSelected(-1)}
            >
              {message('imageDocument.editor.action.lower')}
            </button>
            <button
              type="button"
              class="danger"
              disabled={!selected()}
              onClick={() => {
                const layer = selected()
                if (
                  layer &&
                  dispatch({
                    command: 'image.layer.remove',
                    params: { layerId: layer.id },
                  })
                ) {
                  setSelectedLayerId(documentValue().rootLayerIds.at(-1) ?? '')
                }
              }}
            >
              {message('imageDocument.editor.action.remove')}
            </button>
            <button
              type="button"
              style={{ 'grid-column': '1 / -1' }}
              disabled={!selectedRow() || props.editingBlocked()}
              onClick={groupSelected}
            >
              {selectedRow()?.index === 0
                ? message('imageDocument.editor.action.wrapGroup')
                : message('imageDocument.editor.action.groupBelow')}
            </button>
          </div>
        </aside>
        <section
          class="image-document-preview"
          aria-label={message('imageDocument.editor.region.preview')}
        >
          <div class="image-document-preview-stage">
            <canvas ref={preview} data-testid="image-document-preview" />
          </div>
          <p>{message('imageDocument.editor.description.preview')}</p>
          <Show when={renderError()}>
            {(value) => (
              <div role="alert">
                {message('imageDocument.editor.error.previewFailed', {
                  reason: value(),
                })}
              </div>
            )}
          </Show>
          <section
            class="image-document-authoritative"
            aria-label={message('imageDocument.editor.region.authoritative')}
          >
            <header>
              <div>
                <strong>
                  {message('imageDocument.editor.title.authoritative')}
                </strong>
                <Show when={authoritativeResult()}>
                  <span classList={{ stale: authoritativeStale() }}>
                    {authoritativeStale()
                      ? message('imageDocument.editor.status.stale')
                      : authoritativeResult()!.response.cached
                        ? message('imageDocument.editor.status.cacheHit')
                        : message('imageDocument.editor.status.freshRender')}
                  </span>
                </Show>
              </div>
              <div class="image-document-render-actions">
                <ProductSelect
                  ariaLabel={message('imageDocument.editor.aria.renderTarget')}
                  options={renderTargets()}
                  selectedId={renderSelector()}
                  disabled={authoritativeBusy() || props.busy()}
                  onSelect={(option) => setRenderSelector(option.value)}
                />
                <button
                  type="button"
                  class="primary"
                  disabled={authoritativeBusy() || props.busy()}
                  onClick={() => void renderAuthoritative()}
                >
                  {authoritativeBusy()
                    ? message('imageDocument.editor.action.rendering')
                    : message('imageDocument.editor.action.render')}
                </button>
              </div>
            </header>
            <Show
              when={authoritativeResult()}
              keyed
              fallback={
                <p>
                  {message('imageDocument.editor.description.authoritative')}
                </p>
              }
            >
              {(result) => (
                <div
                  class="image-document-render-result"
                  data-testid="authoritative-image-document-render"
                >
                  <a href={result.assetUrl} download={`${entryName()}.png`}>
                    <img
                      src={result.assetUrl}
                      alt={message(
                        'imageDocument.editor.region.authoritativeOutput',
                      )}
                    />
                  </a>
                  <dl>
                    <div>
                      <dt>
                        {message('imageDocument.editor.provenance.output')}
                      </dt>
                      <dd>
                        {result.response.provenance.output.width} x{' '}
                        {result.response.provenance.output.height},{' '}
                        {formatNumber(
                          result.response.provenance.output.byteSize,
                        )}{' '}
                        bytes
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {message('imageDocument.editor.provenance.target')}
                      </dt>
                      <dd>{result.response.provenance.selector}</dd>
                    </div>
                    <div>
                      <dt>
                        {message('imageDocument.editor.provenance.profile')}
                      </dt>
                      <dd>{result.response.provenance.profile}</dd>
                    </div>
                    <div>
                      <dt>
                        {message('imageDocument.editor.provenance.renderer')}
                      </dt>
                      <dd>{result.response.provenance.rendererContract}</dd>
                    </div>
                    <div>
                      <dt>
                        {message('imageDocument.editor.provenance.source')}
                      </dt>
                      <dd>
                        <code>{result.response.provenance.documentDigest}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {message(
                          'imageDocument.editor.provenance.outputDigest',
                        )}
                      </dt>
                      <dd>
                        <code>{result.response.asset.digest}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {message('imageDocument.editor.provenance.cacheKey')}
                      </dt>
                      <dd>
                        <code>{result.response.cacheKey}</code>
                      </dd>
                    </div>
                  </dl>
                  <a
                    class="image-document-download"
                    href={result.assetUrl}
                    download={`${entryName()}.png`}
                  >
                    {message('imageDocument.editor.action.downloadPng')}
                  </a>
                </div>
              )}
            </Show>
            <Show when={authoritativeError()}>
              {(value) => (
                <div class="image-document-render-error" role="alert">
                  {message('imageDocument.editor.error.authoritativeFailed', {
                    reason: value(),
                  })}
                </div>
              )}
            </Show>
          </section>
        </section>
        <aside
          class="image-document-properties"
          aria-label={message('imageDocument.editor.region.properties')}
        >
          <fieldset>
            <legend>{message('imageDocument.editor.title.canvas')}</legend>
            <div class="image-document-field-grid">
              <For each={['width', 'height'] as const}>
                {(field) => (
                  <label>
                    {message(`imageDocument.editor.field.${field}`)}
                    <ProductNumberInput
                      ariaLabel={message(
                        `imageDocument.editor.aria.canvas.${field}`,
                      )}
                      step={1}
                      value={documentValue().canvas[field]}
                      commitUnchanged
                      onRevert={() => props.onError(undefined)}
                      onCommit={(raw) =>
                        commitInteger(
                          raw,
                          documentValue().canvas[field],
                          (value) =>
                            dispatch({
                              command: 'image.canvas.update',
                              params: {
                                width: documentValue().canvas.width,
                                height: documentValue().canvas.height,
                                [field]: value,
                              },
                            }),
                        )
                      }
                    />
                  </label>
                )}
              </For>
            </div>
            <label class="image-document-check">
              <ProductCheckbox
                ariaLabel={message('imageDocument.editor.aria.linearColor')}
                checked={
                  documentValue().canvas.compositing ===
                  'linear-premultiplied-alpha'
                }
                onChange={(linear) =>
                  dispatch({
                    command: 'image.canvas.update',
                    params: {
                      width: documentValue().canvas.width,
                      height: documentValue().canvas.height,
                      compositing: linear
                        ? 'linear-premultiplied-alpha'
                        : 'premultiplied-alpha',
                    },
                  })
                }
              />{' '}
              {message('imageDocument.editor.field.linearColor')}
            </label>
          </fieldset>
          <fieldset data-testid="image-document-crop-controls">
            <legend>{message('imageDocument.editor.title.crop')}</legend>
            <div class="image-document-field-grid">
              <For
                each={[
                  {
                    id: 'x',
                    value: cropX,
                    set: setCropX,
                    max: () => documentValue().canvas.width - 1,
                  },
                  {
                    id: 'y',
                    value: cropY,
                    set: setCropY,
                    max: () => documentValue().canvas.height - 1,
                  },
                  {
                    id: 'width',
                    value: cropWidth,
                    set: setCropWidth,
                    max: () => documentValue().canvas.width - cropX(),
                  },
                  {
                    id: 'height',
                    value: cropHeight,
                    set: setCropHeight,
                    max: () => documentValue().canvas.height - cropY(),
                  },
                ]}
              >
                {(field) => (
                  <label>
                    {message(`imageDocument.editor.field.${field.id}`)}
                    <ProductNumberInput
                      ariaLabel={message(
                        `imageDocument.editor.aria.crop.${field.id}`,
                      )}
                      integer
                      min={field.id === 'x' || field.id === 'y' ? 0 : 1}
                      max={field.max()}
                      step={1}
                      value={field.value()}
                      onInput={(raw) => field.set(Number(raw))}
                    />
                  </label>
                )}
              </For>
            </div>
            <button
              type="button"
              disabled={props.editingBlocked()}
              onClick={() => {
                if (
                  dispatch({
                    command: 'image.canvas.crop',
                    params: {
                      x: cropX(),
                      y: cropY(),
                      width: cropWidth(),
                      height: cropHeight(),
                    },
                  })
                ) {
                  setCropX(0)
                  setCropY(0)
                  setCropWidth(documentValue().canvas.width)
                  setCropHeight(documentValue().canvas.height)
                  setResizeWidth(documentValue().canvas.width)
                  setResizeHeight(documentValue().canvas.height)
                }
              }}
            >
              {message('imageDocument.editor.action.applyCrop')}
            </button>
          </fieldset>
          <fieldset data-testid="image-document-resize-controls">
            <legend>{message('imageDocument.editor.title.resize')}</legend>
            <div class="image-document-field-grid">
              <label>
                {message('imageDocument.editor.field.width')}
                <ProductNumberInput
                  ariaLabel={message('imageDocument.editor.aria.resize.width')}
                  integer
                  min={1}
                  max={MAX_IMAGE_CANVAS_DIMENSION}
                  step={1}
                  value={resizeWidth()}
                  onInput={(raw) => setResizeWidth(Number(raw))}
                />
              </label>
              <label>
                {message('imageDocument.editor.field.height')}
                <ProductNumberInput
                  ariaLabel={message('imageDocument.editor.aria.resize.height')}
                  integer
                  min={1}
                  max={MAX_IMAGE_CANVAS_DIMENSION}
                  step={1}
                  value={resizeHeight()}
                  onInput={(raw) => setResizeHeight(Number(raw))}
                />
              </label>
            </div>
            <button
              type="button"
              disabled={props.editingBlocked()}
              onClick={() => {
                if (
                  dispatch({
                    command: 'image.canvas.resize',
                    params: { width: resizeWidth(), height: resizeHeight() },
                  })
                ) {
                  setCropX(0)
                  setCropY(0)
                  setCropWidth(documentValue().canvas.width)
                  setCropHeight(documentValue().canvas.height)
                }
              }}
            >
              {message('imageDocument.editor.action.applyResize')}
            </button>
          </fieldset>
          <fieldset data-testid="image-document-output-controls">
            <legend>{message('imageDocument.editor.title.output')}</legend>
            <label>
              {message('imageDocument.editor.field.format')}
              <ProductSelect
                ariaLabel={message('imageDocument.editor.aria.outputFormat')}
                selectedId={imageOutputPolicyOf(documentValue()).format}
                options={IMAGE_OUTPUT_FORMATS.map((format) => ({
                  id: format,
                  label: format.toUpperCase(),
                  value: format,
                }))}
                onSelect={(option) =>
                  dispatch({
                    command: 'image.output.update',
                    params: {
                      ...imageOutputPolicyOf(documentValue()),
                      format: option.value,
                    },
                  })
                }
              />
            </label>
            <label>
              {message('imageDocument.editor.field.quality')}
              <ProductNumberInput
                ariaLabel={message('imageDocument.editor.aria.outputQuality')}
                integer
                min={0}
                max={100}
                step={1}
                disabled={imageOutputPolicyOf(documentValue()).format === 'png'}
                value={imageOutputPolicyOf(documentValue()).quality}
                onCommit={(raw) =>
                  dispatch({
                    command: 'image.output.update',
                    params: {
                      ...imageOutputPolicyOf(documentValue()),
                      quality: Number(raw),
                    },
                  })
                }
              />
            </label>
            <small>{message('imageDocument.editor.description.quality')}</small>
          </fieldset>
          <Show
            when={selected()}
            fallback={
              <p>{message('imageDocument.editor.description.selectLayer')}</p>
            }
          >
            {(layer) => (
              <>
                <fieldset>
                  <legend>{message('imageDocument.editor.title.layer')}</legend>
                  <label>
                    {message('imageDocument.editor.field.name')}
                    <input
                      value={layer().name}
                      onChange={(event) =>
                        updateLayer({ name: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label class="image-document-check">
                    <ProductCheckbox
                      ariaLabel={message(
                        'imageDocument.editor.aria.layerVisibility',
                      )}
                      checked={layer().visible}
                      onChange={(visible) => updateLayer({ visible })}
                    />{' '}
                    {message('imageDocument.editor.field.visible')}
                  </label>
                  <label>
                    {message('imageDocument.editor.field.opacity')}{' '}
                    <output>
                      {Math.round((layer().opacity / IMAGE_OPACITY_MAX) * 100)}%
                    </output>
                    <ProductSlider
                      ariaLabel={message(
                        'imageDocument.editor.aria.layerOpacity',
                      )}
                      min={0}
                      max={100}
                      value={(layer().opacity / IMAGE_OPACITY_MAX) * 100}
                      onInput={() => undefined}
                      onCommit={(value) =>
                        updateLayer({
                          opacity: Math.round(
                            (value / 100) * IMAGE_OPACITY_MAX,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    {message('imageDocument.editor.field.blendMode')}
                    <ProductSelect
                      ariaLabel={message(
                        'imageDocument.editor.aria.layerBlendMode',
                      )}
                      selectedId={layer().blendMode}
                      options={IMAGE_BLEND_MODES.map((mode) => ({
                        id: mode,
                        label: mode,
                        value: mode,
                      }))}
                      onSelect={(option) =>
                        updateLayer({ blendMode: option.value })
                      }
                    />
                  </label>
                  <label class="image-document-check">
                    <ProductCheckbox
                      ariaLabel={message(
                        'imageDocument.editor.aria.clipPrevious',
                      )}
                      checked={layer().clipping === 'clip-to-previous'}
                      onChange={(clip) =>
                        updateLayer({
                          clipping: clip ? 'clip-to-previous' : 'none',
                        })
                      }
                    />{' '}
                    {message('imageDocument.editor.field.clipPrevious')}
                  </label>
                  <label>
                    {message('imageDocument.editor.field.zOrder')}
                    <ProductNumberInput
                      ariaLabel={message(
                        'imageDocument.editor.aria.layerZOrder',
                      )}
                      step={1}
                      value={layer().z_index ?? selectedRow()?.index ?? 0}
                      commitUnchanged
                      onRevert={() => props.onError(undefined)}
                      onCommit={(raw) =>
                        commitInteger(
                          raw,
                          layer().z_index ?? selectedRow()?.index ?? 0,
                          (value) => updateLayer({ z_index: value }),
                        )
                      }
                    />
                  </label>
                  <Show when={layer().kind === 'group'}>
                    <label class="image-document-check">
                      <ProductCheckbox
                        ariaLabel={message(
                          'imageDocument.editor.field.passThrough',
                        )}
                        checked={(() => {
                          const group = layer()
                          return (
                            group.kind === 'group' &&
                            group.isolation === 'pass-through'
                          )
                        })()}
                        onChange={(passThrough) =>
                          updateLayer({
                            isolation: passThrough
                              ? 'pass-through'
                              : 'isolated',
                          })
                        }
                      />{' '}
                      {message('imageDocument.editor.field.passThrough')}
                    </label>
                  </Show>
                </fieldset>
                <fieldset>
                  <legend>
                    {message('imageDocument.editor.title.transform')}
                  </legend>
                  <div class="image-document-field-grid">
                    <For
                      each={
                        [
                          ['tx', 'x'],
                          ['ty', 'y'],
                          ['a', 'scaleX'],
                          ['d', 'scaleY'],
                          ['c', 'skewX'],
                          ['b', 'skewY'],
                        ] as const
                      }
                    >
                      {([field, labelKey]) => (
                        <label>
                          {message(`imageDocument.editor.field.${labelKey}`)}
                          <ProductNumberInput
                            ariaLabel={message(
                              'imageDocument.editor.aria.layerTransform',
                              {
                                field: message(
                                  `imageDocument.editor.field.${labelKey}`,
                                ),
                              },
                            )}
                            step={field === 'tx' || field === 'ty' ? 1 : 0.01}
                            value={
                              layer().transform[field] / IMAGE_FIXED_POINT_SCALE
                            }
                            onCommit={(value) =>
                              updateTransform(field, Number(value))
                            }
                          />
                        </label>
                      )}
                    </For>
                  </div>
                </fieldset>
                <fieldset>
                  <legend>{message('imageDocument.editor.title.masks')}</legend>
                  <button
                    type="button"
                    disabled={props.editingBlocked()}
                    onClick={() => maskInput.click()}
                  >
                    {message('imageDocument.editor.action.addRasterMask')}
                  </button>
                  <input
                    ref={maskInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (file) void addMask(file)
                    }}
                  />
                  <For each={layer().maskIds}>
                    {(maskId) => {
                      const mask = () => documentValue().masks[maskId]!
                      return (
                        <div class="image-document-mask">
                          <strong>
                            {message('imageDocument.editor.field.rasterMask')}
                          </strong>
                          <label class="image-document-check">
                            <ProductCheckbox
                              ariaLabel={message(
                                'imageDocument.editor.aria.maskEnabled',
                              )}
                              checked={mask().enabled}
                              onChange={(enabled) =>
                                dispatch({
                                  command: 'image.mask.update',
                                  params: { maskId, enabled },
                                })
                              }
                            />{' '}
                            {message('imageDocument.editor.field.enabled')}
                          </label>
                          <label class="image-document-check">
                            <ProductCheckbox
                              ariaLabel={message(
                                'imageDocument.editor.aria.maskInvert',
                              )}
                              checked={mask().invert}
                              onChange={(invert) =>
                                dispatch({
                                  command: 'image.mask.update',
                                  params: { maskId, invert },
                                })
                              }
                            />{' '}
                            {message('imageDocument.editor.field.invert')}
                          </label>
                          <label>
                            {message('imageDocument.editor.field.opacity')}{' '}
                            <output>
                              {Math.round(
                                (mask().opacity / IMAGE_OPACITY_MAX) * 100,
                              )}
                              %
                            </output>
                            <ProductSlider
                              ariaLabel={message(
                                'imageDocument.editor.aria.maskOpacity',
                              )}
                              min={0}
                              max={100}
                              value={(mask().opacity / IMAGE_OPACITY_MAX) * 100}
                              onInput={() => undefined}
                              onCommit={(value) =>
                                dispatch({
                                  command: 'image.mask.update',
                                  params: {
                                    maskId,
                                    opacity: Math.round(
                                      (value / 100) * IMAGE_OPACITY_MAX,
                                    ),
                                  },
                                })
                              }
                            />
                          </label>
                          <label>
                            {message('imageDocument.editor.field.combine')}
                            <ProductSelect
                              ariaLabel={message(
                                'imageDocument.editor.aria.maskCombine',
                              )}
                              selectedId={mask().combineMode}
                              options={IMAGE_MASK_COMBINE_MODES.map((mode) => ({
                                id: mode,
                                label: mode,
                                value: mode,
                              }))}
                              onSelect={(option) =>
                                dispatch({
                                  command: 'image.mask.update',
                                  params: { maskId, combineMode: option.value },
                                })
                              }
                            />
                          </label>
                          <label>
                            {message('imageDocument.editor.field.channel')}
                            <ProductSelect
                              ariaLabel={message(
                                'imageDocument.editor.aria.maskChannel',
                              )}
                              selectedId={mask().channel}
                              options={(['alpha', 'luminance'] as const).map(
                                (channel) => ({
                                  id: channel,
                                  label: channel,
                                  value: channel,
                                }),
                              )}
                              onSelect={(option) =>
                                dispatch({
                                  command: 'image.mask.update',
                                  params: { maskId, channel: option.value },
                                })
                              }
                            />
                          </label>
                          <button
                            type="button"
                            class="danger"
                            onClick={() =>
                              dispatch({
                                command: 'image.mask.remove',
                                params: { maskId },
                              })
                            }
                          >
                            {message('imageDocument.editor.action.removeMask')}
                          </button>
                        </div>
                      )
                    }}
                  </For>
                </fieldset>
              </>
            )}
          </Show>
        </aside>
      </div>
      <Show when={props.error()}>
        {(value) => (
          <div class="image-document-error" role="alert">
            {value()}
          </div>
        )}
      </Show>
    </section>
  )
}

export function ImageDocumentWorkspace(props: {
  readonly active: boolean
  readonly activeId?: string | undefined
  readonly createRequest?: number | undefined
  readonly app: AppState
  readonly onBusyChange: (busy: boolean) => void
  readonly onClose: () => void
  readonly onTabsChange?:
    | ((tabs: readonly ImageWorkspaceTab[]) => void)
    | undefined
  readonly onReady?: (() => void) | undefined
  readonly onActivate?: ((id: string) => void) | undefined
  readonly graphRequest?: GraphImageDocumentRequest | undefined
  readonly onGraphRequestHandled?: () => void
}) {
  const message = useAppMessage()
  const store = new ImageDocumentLocalStore(activeProjectId())
  const [documents, setDocuments] = createSignal<readonly OpenImageDocument[]>(
    [],
  )
  const [activeLineage, setActiveLineage] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusySignal] = createSignal(false)
  const [error, setErrorValue] = createSignal<
    string | LocalizedImageDocumentError
  >()
  const [libraryOpen, setLibraryOpen] = createSignal(false)
  const [libraryRecords, setLibraryRecords] = createSignal<
    readonly LibraryRecord[]
  >([])
  const [collaborationOpen, setCollaborationOpen] = createSignal(false)
  const [collaborationSessions, setCollaborationSessions] = createSignal<
    readonly CollabSessionDescriptor[]
  >([])
  const [confirmingEnd, setConfirmingEnd] = createSignal(false)
  const [collaborationTransition, setCollaborationTransition] =
    createSignal(false)
  const [resourceTick, setResourceTick] = createSignal(0)
  const [metadataTick, setMetadataTick] = createSignal(0)
  let importInput!: HTMLInputElement
  let libraryDialog!: HTMLDivElement
  let collaborationDialog!: HTMLDivElement
  let endConfirmButton: HTMLButtonElement | undefined
  let live = true
  let handledCreate = props.createRequest ?? 0
  const leaving = new Set<OpenImageDocument>()

  const setError = (value: string | undefined): void => {
    setErrorValue(value)
  }
  const setLocalizedError = (key: string, params?: MessageParams): void => {
    setErrorValue({ key, ...(params === undefined ? {} : { params }) })
  }
  const errorText = (): string | undefined => {
    const value = error()
    return typeof value === 'string' || value === undefined
      ? value
      : message(value.key, value.params)
  }

  const backendForCollaboration = (baseUrl?: string) => {
    const preferred = props.app.collabBackend?.()
    if (
      preferred?.protocol === 'dinkster' &&
      (baseUrl === undefined || preferred.baseUrl === baseUrl)
    ) {
      return preferred
    }
    return props.app.backends
      ?.get?.()
      .find(
        (backend) =>
          backend.protocol === 'dinkster' &&
          (baseUrl === undefined || backend.baseUrl === baseUrl),
      )
  }

  const setBusy = (value: boolean): void => {
    setBusySignal(value)
    props.onBusyChange(value)
  }

  const refresh = (): void => {
    setDocuments((current) => [...current])
    setMetadataTick((tick) => tick + 1)
  }
  const queuePersist = (
    entry: OpenImageDocument,
    snapshot = entry.session.doc,
    name = entry.name,
  ): void => {
    entry.persist = entry.persist
      .catch(() => undefined)
      .then(async () => {
        const saved = await store.saveDraft(
          snapshot,
          name,
          undefined,
          entry.draft.updatedAt,
        )
        entry.draft = saved
        if (live) refresh()
      })
      .catch((cause) => {
        if (live) setError(`Draft recovery save failed: ${messageOf(cause)}`)
      })
  }
  const scheduleHydrate = (entry: OpenImageDocument): void => {
    const shared = entry.collaboration
    const backend =
      shared === undefined ? undefined : backendForCollaboration(shared.baseUrl)
    if (backend?.protocol !== 'dinkster') return
    entry.hydrate = entry.hydrate
      .catch(() => undefined)
      .then(() =>
        hydrateImageDocumentResources(
          backend.connection,
          store,
          entry.session.doc,
        ),
      )
      .then(() => {
        if (live) setResourceTick((tick) => tick + 1)
      })
      .catch((cause) => {
        if (live) setError(`Shared image resource failed: ${messageOf(cause)}`)
      })
  }
  const attach = (
    draft: ImageDocumentDraft,
    shared?: {
      readonly descriptor: CollabSessionDescriptor
      readonly baseUrl: string
      readonly session: SharedImageDocumentSession
    },
    authoritative?: VerifiedImageDocumentRender,
    origin?: ImageDocumentGraphOrigin,
  ): OpenImageDocument => {
    const session =
      shared?.session ?? createLocalImageDocumentSession(draft.document)
    let entry!: OpenImageDocument
    const stopOperation = session.onOp(() => {
      queuePersist(entry)
      scheduleHydrate(entry)
    })
    let stopStatus = (): void => undefined
    const stop = (): void => {
      stopOperation()
      stopStatus()
    }
    entry = {
      session,
      draft,
      name: draft.name,
      persist: Promise.resolve(),
      hydrate: Promise.resolve(),
      stop,
      ...(authoritative !== undefined ? { authoritative } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(shared !== undefined ? { collaboration: shared } : {}),
    }
    if (shared !== undefined) {
      stopStatus = shared.session.status.subscribe((status) => {
        if (live) refresh()
        if (status === 'closed')
          queueMicrotask(() => void leaveShared(entry, true))
      })
    }
    return entry
  }
  const openDraft = (
    draft: ImageDocumentDraft,
    authoritative?: VerifiedImageDocumentRender,
    origin?: ImageDocumentGraphOrigin,
  ): void => {
    const existing = documents().find(
      (entry) => entry.draft.document.lineage === draft.document.lineage,
    )
    if (existing) {
      if (authoritative !== undefined) {
        existing.authoritative = authoritative
      }
      if (origin !== undefined) existing.origin = origin
      refresh()
      setActiveLineage(existing.draft.document.lineage)
      props.onActivate?.(externalTabId(existing.draft.document.lineage))
      return
    }
    const entry = attach(draft, undefined, authoritative, origin)
    setDocuments((current) => [...current, entry])
    setActiveLineage(draft.document.lineage)
    props.onActivate?.(externalTabId(draft.document.lineage))
  }
  const active = (): OpenImageDocument | undefined =>
    documents().find(
      (entry) => entry.draft.document.lineage === activeLineage(),
    )
  const externalTabId = (lineage: ImageDocument['lineage']): string =>
    `image:${lineage}`
  const closeEntry = (entry: OpenImageDocument): void => {
    entry.stop()
    entry.collaboration?.session.close()
    const remaining = documents().filter((candidate) => candidate !== entry)
    setDocuments(remaining)
    if (activeLineage() === entry.draft.document.lineage) {
      const fallback = remaining.at(-1)
      setActiveLineage(fallback?.draft.document.lineage ?? '')
      if (fallback !== undefined)
        props.onActivate?.(externalTabId(fallback.draft.document.lineage))
    }
  }
  const replaceEntry = (
    previous: OpenImageDocument | undefined,
    next: OpenImageDocument,
  ): void => {
    previous?.stop()
    if (
      previous?.collaboration !== undefined &&
      previous.collaboration.session !== next.collaboration?.session
    ) {
      previous.collaboration.session.close()
    }
    setDocuments((current) =>
      previous === undefined
        ? [...current, next]
        : current.map((entry) => (entry === previous ? next : entry)),
    )
    setActiveLineage(next.draft.document.lineage)
    props.onActivate?.(externalTabId(next.draft.document.lineage))
  }
  const adoptShared = async (
    descriptor: CollabSessionDescriptor,
    baseUrl: string,
    previous?: OpenImageDocument,
  ): Promise<OpenImageDocument> => {
    if (descriptor.documentKind !== 'image')
      throw new Error('collaboration session is not an ImageDocument')
    const backend = backendForCollaboration(baseUrl)
    if (backend?.protocol !== 'dinkster')
      throw new Error(
        message(
          'imageDocument.workspace.error.collaborationBackendDisconnected',
        ),
      )
    const connection = props.app.collabTransport.connect({
      baseUrl,
      sessionId: descriptor.sessionId,
      actorId: props.app.collabActorId,
    })
    let session: SharedImageDocumentSession
    try {
      session = await connectSharedImageDocumentSession(
        connection,
        descriptor,
        {
          actorId: props.app.collabActorId,
          onConflict: (conflict) => {
            if (live)
              setLocalizedError('imageDocument.workspace.error.conflict', {
                reason: conflict.message,
              })
          },
          onError: (reason) => {
            if (live)
              setLocalizedError('imageDocument.workspace.error.sessionFailed', {
                reason,
              })
          },
        },
      )
      if (session.doc.lineage !== descriptor.documentId) {
        throw new Error(
          'shared ImageDocument lineage does not match the session',
        )
      }
      await previous?.persist
      await session.settle()
      const sharedDocument = session.doc
      await hydrateImageDocumentResources(
        backend.connection,
        store,
        sharedDocument,
      )
      if (
        previous !== undefined &&
        serializeImageDocument(previous.session.doc) !==
          serializeImageDocument(sharedDocument)
      ) {
        throw new Error(
          'the local image differs from the shared session; publish or discard it before joining',
        )
      }
      const existing = await store.recoverDraft(session.doc.lineage)
      const saved = await store.saveDraft(
        sharedDocument,
        previous?.name ?? existing?.name ?? descriptor.documentId,
        undefined,
        existing?.updatedAt ?? null,
      )
      const linked = await store.setCollaboration(session.doc.lineage, {
        sessionId: descriptor.sessionId,
        baseUrl,
      })
      const next = attach(
        { ...linked, document: sharedDocument, name: saved.name },
        {
          descriptor,
          baseUrl,
          session,
        },
      )
      replaceEntry(previous, next)
      queuePersist(next, session.doc)
      if (session.doc !== sharedDocument) scheduleHydrate(next)
      setResourceTick((tick) => tick + 1)
      return next
    } catch (cause) {
      connection.close()
      throw cause
    }
  }
  const uploadSharedSnapshotResources = async (
    connection: DinksterConnection,
    documentSnapshot: ImageDocument,
  ): Promise<void> => {
    const uploaded = new Set<string>()
    for (const resource of Object.values(documentSnapshot.resources)) {
      if (uploaded.has(resource.digest)) continue
      await uploadImageDocumentResource(
        connection,
        store,
        resource,
        COLLAB_SCOPE,
      )
      uploaded.add(resource.digest)
    }
  }
  const shareActive = async (): Promise<void> => {
    const entry = active()
    const backend = backendForCollaboration()
    if (
      entry === undefined ||
      entry.collaboration !== undefined ||
      backend?.protocol !== 'dinkster'
    )
      return
    setCollaborationTransition(true)
    setBusy(true)
    setError(undefined)
    let created: CollabSessionDescriptor | undefined
    try {
      await entry.persist
      const expectedSession = entry.session
      const expectedRevision = entry.session.revision
      const documentSnapshot = entry.session.doc
      await uploadSharedSnapshotResources(backend.connection, documentSnapshot)
      created = await props.app.collabTransport.create(backend.baseUrl, {
        scope: COLLAB_SCOPE,
        documentId: entry.session.doc.lineage,
        documentKind: 'image',
        snapshot: documentSnapshot,
      })
      if (
        active() !== entry ||
        entry.session !== expectedSession ||
        entry.session.revision !== expectedRevision
      ) {
        throw new Error(
          message('imageDocument.workspace.error.imageChangedDuringShare'),
        )
      }
      await adoptShared(created, backend.baseUrl, entry)
      setConfirmingEnd(false)
      setCollaborationOpen(false)
      props.app.showTransientStatus(
        message('imageDocument.workspace.status.sharing', { name: entry.name }),
      )
    } catch (cause) {
      if (created !== undefined) {
        void props.app.collabTransport
          .end(backend.baseUrl, created.sessionId)
          .catch(() => undefined)
      }
      if (live)
        setLocalizedError('imageDocument.workspace.error.shareFailed', {
          reason: messageOf(cause),
        })
    } finally {
      if (live) setCollaborationTransition(false)
      if (live) setBusy(false)
    }
  }
  async function leaveShared(
    entry: OpenImageDocument,
    remote = false,
  ): Promise<void> {
    if (
      entry.collaboration === undefined ||
      !documents().includes(entry) ||
      leaving.has(entry)
    )
      return
    leaving.add(entry)
    setCollaborationTransition(true)
    if (!remote) setBusy(true)
    setError(undefined)
    try {
      entry.stop()
      await entry.persist
      const documentSnapshot = entry.session.doc
      entry.collaboration.session.close()
      const current = await store.recoverDraft(documentSnapshot.lineage)
      await store.saveDraft(
        documentSnapshot,
        entry.name,
        undefined,
        current?.updatedAt ?? null,
      )
      const unlinked = await store.setCollaboration(
        documentSnapshot.lineage,
        undefined,
      )
      if (!documents().includes(entry)) return
      const local = attach({
        ...unlinked,
        document: documentSnapshot,
        name: entry.name,
      })
      replaceEntry(entry, local)
      setConfirmingEnd(false)
      props.app.showTransientStatus(
        message(
          remote
            ? 'imageDocument.workspace.status.sharedEnded'
            : 'imageDocument.workspace.status.leftShared',
          { name: entry.name },
        ),
      )
    } catch (cause) {
      if (live)
        setLocalizedError('imageDocument.workspace.error.leaveFailed', {
          reason: messageOf(cause),
        })
    } finally {
      leaving.delete(entry)
      if (live) setCollaborationTransition(false)
      if (!remote && live) setBusy(false)
    }
  }
  const endShared = async (entry: OpenImageDocument): Promise<void> => {
    if (entry.collaboration === undefined) return
    setCollaborationTransition(true)
    setBusy(true)
    setError(undefined)
    try {
      await props.app.collabTransport.end(
        entry.collaboration.baseUrl,
        entry.collaboration.descriptor.sessionId,
      )
      if (documents().includes(entry)) await leaveShared(entry)
    } catch (cause) {
      if (live)
        setLocalizedError('imageDocument.workspace.error.endFailed', {
          reason: messageOf(cause),
        })
    } finally {
      if (live) setCollaborationTransition(false)
      if (live) setBusy(false)
    }
  }
  const askToEndShared = (): void => {
    setConfirmingEnd(true)
    queueMicrotask(() => endConfirmButton?.focus())
  }
  const refreshCollaboration = async (): Promise<void> => {
    const backend = backendForCollaboration()
    if (backend?.protocol !== 'dinkster') {
      setCollaborationSessions([])
      setLocalizedError('imageDocument.workspace.error.sharingRequiresBackend')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const sessions = await props.app.collabTransport.list(
        backend.baseUrl,
        COLLAB_SCOPE,
      )
      setCollaborationSessions(
        sessions.filter((descriptor) => descriptor.documentKind === 'image'),
      )
      setCollaborationOpen(true)
      queueMicrotask(() => collaborationDialog?.focus())
    } catch (cause) {
      if (live)
        setLocalizedError('imageDocument.workspace.error.sharedListFailed', {
          reason: messageOf(cause),
        })
    } finally {
      if (live) setBusy(false)
    }
  }
  const joinShared = async (
    descriptor: CollabSessionDescriptor,
  ): Promise<void> => {
    const backend = backendForCollaboration()
    if (backend?.protocol !== 'dinkster') return
    const duplicate = documents().find(
      (entry) =>
        entry.collaboration?.descriptor.sessionId === descriptor.sessionId &&
        entry.collaboration.baseUrl === backend.baseUrl,
    )
    if (duplicate !== undefined) {
      setActiveLineage(duplicate.draft.document.lineage)
      props.onActivate?.(externalTabId(duplicate.draft.document.lineage))
      setCollaborationOpen(false)
      return
    }
    setCollaborationTransition(true)
    setBusy(true)
    setError(undefined)
    try {
      const previous = documents().find(
        (entry) => entry.draft.document.lineage === descriptor.documentId,
      )
      await adoptShared(descriptor, backend.baseUrl, previous)
      setCollaborationOpen(false)
    } catch (cause) {
      if (live)
        setLocalizedError('imageDocument.workspace.error.joinFailed', {
          reason: messageOf(cause),
        })
    } finally {
      if (live) setCollaborationTransition(false)
      if (live) setBusy(false)
    }
  }
  const tabName = (entry: OpenImageDocument): string => {
    metadataTick()
    return entry.name
  }
  const tabId = (lineage: ImageDocument['lineage']): string =>
    `image-document-tab-${encodeURIComponent(lineage)}`
  const panelId = (lineage: ImageDocument['lineage']): string =>
    `image-document-panel-${encodeURIComponent(lineage)}`
  createEffect(() => {
    const requested = props.activeId
    if (requested?.startsWith('image:')) {
      const lineage = requested.slice('image:'.length)
      if (documents().some((entry) => entry.draft.document.lineage === lineage))
        setActiveLineage(lineage)
    }
  })
  createEffect(() => {
    const request = props.createRequest ?? 0
    if (request === handledCreate) return
    handledCreate = request
    importInput.click()
  })
  createEffect(() => {
    props.onTabsChange?.(
      documents().map((entry) => ({
        id: externalTabId(entry.draft.document.lineage),
        lineage: entry.draft.document.lineage,
        kind: 'image',
        title: tabName(entry),
        shared: entry.collaboration !== undefined,
        activate: () =>
          props.onActivate?.(externalTabId(entry.draft.document.lineage)),
        close: () => closeEntry(entry),
      })),
    )
  })

  onMount(() => {
    void store
      .recoverDrafts()
      .then(async (recovery) => {
        if (!live) return
        const recovered = recovery.drafts.map((draft) => attach(draft))
        setDocuments(recovered)
        setActiveLineage(recovered.at(-1)?.draft.document.lineage ?? '')
        if (recovery.rejectedLineages.length > 0) {
          setLocalizedError('imageDocument.workspace.error.invalidDrafts', {
            count: recovery.rejectedLineages.length,
          })
        }
        for (const draft of recovery.drafts) {
          if (!live || draft.collaboration === undefined) continue
          const previous = documents().find(
            (entry) => entry.draft.document.lineage === draft.document.lineage,
          )
          const backend = backendForCollaboration(draft.collaboration.baseUrl)
          if (previous === undefined || backend?.protocol !== 'dinkster')
            continue
          setCollaborationTransition(true)
          try {
            const descriptor = await props.app.collabTransport.get(
              draft.collaboration.baseUrl,
              draft.collaboration.sessionId,
            )
            if (
              descriptor === undefined ||
              descriptor.documentKind !== 'image' ||
              descriptor.documentId !== draft.document.lineage
            ) {
              previous.draft = await store.setCollaboration(
                draft.document.lineage,
                undefined,
              )
              refresh()
              continue
            }
            await adoptShared(descriptor, draft.collaboration.baseUrl, previous)
          } catch (cause) {
            if (live)
              setLocalizedError('imageDocument.workspace.error.rejoinFailed', {
                reason: messageOf(cause),
              })
          } finally {
            if (live) setCollaborationTransition(false)
          }
        }
      })
      .catch((cause) => {
        if (live)
          setLocalizedError('imageDocument.workspace.error.recoveryFailed', {
            reason: messageOf(cause),
          })
      })
      .finally(() => {
        if (live) {
          setLoading(false)
          props.onReady?.()
        }
      })
  })
  onCleanup(() => {
    live = false
    props.onBusyChange(false)
    const current = documents()
    for (const entry of current) {
      entry.stop()
      entry.collaboration?.session.close()
    }
    void Promise.all(
      current.flatMap((entry) => [
        entry.persist.catch(() => undefined),
        entry.hydrate.catch(() => undefined),
      ]),
    ).finally(() => store.close())
  })

  const importDocument = async (file: File): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      openDraft(await importSingleRaster(file, store))
    } catch (cause) {
      setLocalizedError('imageDocument.workspace.error.imageImportFailed', {
        reason: messageOf(cause),
      })
    } finally {
      importInput.value = ''
      setBusy(false)
      setLoading(false)
    }
  }
  let openingGraph: GraphImageDocumentRequest | undefined
  createEffect(() => {
    const request = props.graphRequest
    if (loading() || request === undefined || openingGraph === request) return
    openingGraph = request
    setBusy(true)
    setError(undefined)
    void (async () => {
      const backend = props.app.backendFor(request.connectionId)
      if (backend?.protocol !== 'dinkster')
        throw new Error(
          message('imageDocument.workspace.error.selectedOwnerUnavailable'),
        )
      await Promise.all(documents().map((entry) => entry.persist))
      const opened = await openGraphImageDocument(
        backend.connection,
        store,
        request.query,
      )
      if (live && props.graphRequest === request)
        openDraft(opened.draft, opened.render, {
          connectionId: request.connectionId,
          sourceTabId: request.sourceTabId,
          graphId: request.graphId,
          sourceNodeId: request.sourceNodeId,
          sourceOutputId: request.sourceOutputId,
          expectedGraphFingerprint: request.expectedGraphFingerprint,
          document: opened.document,
        })
    })()
      .catch((cause) => {
        if (live && props.graphRequest === request)
          setLocalizedError('imageDocument.workspace.error.graphOpenFailed', {
            reason: messageOf(cause),
          })
      })
      .finally(() => {
        if (live && props.graphRequest === request) {
          props.onGraphRequestHandled?.()
          setBusy(false)
        }
      })
  })
  const saveDraft = async (entry: OpenImageDocument): Promise<void> => {
    setBusy(true)
    setError(undefined)
    queuePersist(entry)
    await entry.persist
    if (live && error() === undefined)
      props.app.showTransientStatus(
        message('imageDocument.workspace.status.saved', { name: entry.name }),
      )
    if (live) setBusy(false)
  }
  const publish = async (entry: OpenImageDocument): Promise<void> => {
    const backend = props.app.libraryBackend()
    if (backend === undefined) {
      setLocalizedError(
        'imageDocument.workspace.error.publishingRequiresBackend',
      )
      return
    }
    setBusy(true)
    setError(undefined)
    const task = entry.persist
      .catch(() => undefined)
      .then(async () => {
        const saved = await saveImageDocumentToLibrary(
          backend.connection,
          store,
          entry.session.doc,
          {
            scope: LIBRARY_SCOPE,
            connectionId: backend.id,
            name: entry.name,
            ...(entry.draft.library !== undefined
              ? { link: entry.draft.library }
              : {}),
          },
        )
        entry.draft = saved.draft
        if (live) refresh()
      })
    entry.persist = task.catch(() => undefined)
    try {
      await task
      if (live)
        props.app.showTransientStatus(
          message('imageDocument.workspace.status.published', {
            name: entry.name,
          }),
        )
    } catch (cause) {
      if (live)
        setLocalizedError('imageDocument.workspace.error.publishFailed', {
          reason: messageOf(cause),
        })
    } finally {
      if (live) setBusy(false)
    }
  }
  const renderAuthoritative = async (
    documentSnapshot: ImageDocument,
    selector: string,
  ): Promise<VerifiedImageDocumentRender> => {
    const backend = props.app.libraryBackend()
    if (backend === undefined)
      throw new Error(
        message('imageDocument.workspace.error.renderRequiresBackend'),
      )
    const adopted = await adoptImageDocumentForRender(
      backend.connection,
      store,
      documentSnapshot,
      LIBRARY_SCOPE,
    )
    return renderAdoptedImageDocument(
      backend.connection,
      adopted.digest,
      serializeImageDocument(adopted.document),
      LIBRARY_SCOPE,
      selector,
    )
  }
  const exportSnapshot = async (entry: OpenImageDocument): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await entry.persist
      await exportImageDocumentSnapshot(
        props.app,
        store,
        entry.session.doc,
        entry.name,
      )
      if (live)
        props.app.showTransientStatus(
          message('imageDocument.workspace.status.exportedSnapshot', {
            name: entry.name,
          }),
        )
    } catch (cause) {
      if (live)
        setLocalizedError('imageDocument.workspace.error.graphExportFailed', {
          reason: messageOf(cause),
        })
    } finally {
      if (live) setBusy(false)
    }
  }
  const exportRecipe = async (entry: OpenImageDocument): Promise<void> => {
    if (entry.origin === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await entry.persist
      await exportImageDocumentRecipe(
        props.app,
        entry.origin,
        entry.session.doc,
      )
      if (live)
        props.app.showTransientStatus(
          message('imageDocument.workspace.status.exportedRecipe', {
            name: entry.name,
          }),
        )
    } catch (cause) {
      if (live)
        setLocalizedError('imageDocument.workspace.error.recipeExportFailed', {
          reason: messageOf(cause),
        })
    } finally {
      if (live) setBusy(false)
    }
  }
  const browseLibrary = async (): Promise<void> => {
    const backend = props.app.libraryBackend()
    if (backend === undefined) {
      setLocalizedError(
        'imageDocument.workspace.error.openLibraryRequiresBackend',
      )
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const page = await backend.connection.listLibrary({
        scope: LIBRARY_SCOPE,
        label: 'image-document',
        limit: 100,
      })
      setLibraryRecords(
        page.records.filter(
          (record) =>
            record.mediaType.split(';', 1)[0] === IMAGE_DOCUMENT_MEDIA_TYPE,
        ),
      )
      setLibraryOpen(true)
      queueMicrotask(() => libraryDialog?.focus())
    } catch (cause) {
      setLocalizedError('imageDocument.workspace.error.libraryOpenFailed', {
        reason: messageOf(cause),
      })
    } finally {
      if (live) setBusy(false)
    }
  }
  const openLibraryRecord = async (record: LibraryRecord): Promise<void> => {
    const backend = props.app.libraryBackend()
    if (backend === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const draft = await openImageDocumentFromLibrary(
        backend.connection,
        store,
        record.id,
        LIBRARY_SCOPE,
        backend.id,
      )
      if (draft === undefined)
        throw new Error(
          message('imageDocument.workspace.error.libraryRecordMissing'),
        )
      openDraft(draft)
      setLibraryOpen(false)
    } catch (cause) {
      setLocalizedError('imageDocument.workspace.error.openImageFailed', {
        reason: messageOf(cause),
      })
    } finally {
      if (live) setBusy(false)
    }
  }
  const uploadPreparedResource = async (
    entry: OpenImageDocument,
    prepared: PreparedImageRaster,
  ): Promise<void> => {
    if (entry.collaboration === undefined) return
    const backend = backendForCollaboration(entry.collaboration.baseUrl)
    if (backend?.protocol !== 'dinkster')
      throw new Error(
        message(
          'imageDocument.workspace.error.collaborationBackendDisconnected',
        ),
      )
    await uploadImageDocumentResource(
      backend.connection,
      store,
      {
        ...prepared.resource,
        id: asImageResourceId('pending'),
      } as ImageRasterResource,
      COLLAB_SCOPE,
    )
  }
  const sharedStatus = (entry: OpenImageDocument): string | undefined => {
    metadataTick()
    return entry.collaboration?.session.status.get()
  }

  return (
    <section
      class="image-document-workspace"
      classList={{ 'image-document-hidden': !props.active }}
      data-testid="image-document-workspace"
    >
      <header class="image-document-tabs">
        <button
          type="button"
          onClick={() => importInput.click()}
          disabled={busy()}
        >
          {message('imageDocument.workspace.action.newFromImage')}
        </button>
        <button
          type="button"
          onClick={() => void browseLibrary()}
          disabled={busy()}
        >
          {message('imageDocument.workspace.action.openLibrary')}
        </button>
        <button
          type="button"
          data-testid="image-collab-browse"
          onClick={() => void refreshCollaboration()}
          disabled={busy()}
        >
          {message('imageDocument.workspace.action.sharedImages')}
        </button>
        <Show when={active()} keyed>
          {(entry) => (
            <>
              <Show
                when={entry.collaboration}
                fallback={
                  <button
                    type="button"
                    data-testid="image-collab-share"
                    onClick={() => void shareActive()}
                    disabled={
                      busy() ||
                      backendForCollaboration()?.protocol !== 'dinkster'
                    }
                  >
                    {message('imageDocument.workspace.action.share')}
                  </button>
                }
              >
                <span
                  class="image-document-shared-status"
                  data-status={sharedStatus(entry)}
                >
                  {sharedStatus(entry) === 'live'
                    ? message('imageDocument.workspace.shared.live')
                    : sharedStatus(entry)}
                </span>
                <button
                  type="button"
                  data-testid="image-collab-leave"
                  onClick={() => void leaveShared(entry)}
                  disabled={busy()}
                >
                  {message('imageDocument.workspace.action.leave')}
                </button>
                <button
                  type="button"
                  class="danger"
                  data-testid="image-collab-end"
                  onClick={askToEndShared}
                  disabled={busy()}
                >
                  {message('imageDocument.workspace.action.end')}
                </button>
              </Show>
            </>
          )}
        </Show>
        <input
          ref={importInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file) void importDocument(file)
          }}
        />
      </header>
      <Show
        when={!loading()}
        fallback={
          <ProductEmptyState
            class="image-document-empty"
            tone="loading"
            title={message('imageDocument.workspace.recovering')}
          />
        }
      >
        <Show
          when={active()}
          fallback={
            <ProductEmptyState
              class="image-document-empty"
              title={message('imageDocument.workspace.empty.title')}
              hint={message('imageDocument.workspace.empty.description')}
              action={
                <ProductButton
                  type="button"
                  variant="primary"
                  onClick={() => importInput.click()}
                >
                  {message('imageDocument.workspace.action.chooseImage')}
                </ProductButton>
              }
            />
          }
        >
          <For each={documents()}>
            {(entry) => (
              <section
                id={panelId(entry.draft.document.lineage)}
                role="tabpanel"
                aria-labelledby={tabId(entry.draft.document.lineage)}
                class="image-document-tabpanel"
                hidden={entry.draft.document.lineage !== activeLineage()}
              >
                <ImageDocumentEditor
                  active={() =>
                    props.active &&
                    entry.draft.document.lineage === activeLineage()
                  }
                  entry={entry}
                  store={store}
                  busy={busy}
                  editingBlocked={collaborationTransition}
                  error={errorText}
                  metadataTick={metadataTick}
                  onError={setError}
                  onName={(name) => {
                    entry.name = name
                    refresh()
                    queuePersist(entry, entry.session.doc, name)
                  }}
                  onSave={() => saveDraft(entry)}
                  onPublish={() => publish(entry)}
                  onExport={() => exportSnapshot(entry)}
                  {...(entry.origin === undefined
                    ? {}
                    : { onExportRecipe: () => exportRecipe(entry) })}
                  onRender={renderAuthoritative}
                  onResourceReady={(resource) =>
                    uploadPreparedResource(entry, resource)
                  }
                  resourceTick={resourceTick}
                />
              </section>
            )}
          </For>
        </Show>
      </Show>
      <Show when={errorText() && active() === undefined}>
        <div class="image-document-error" role="alert">
          {errorText()}
        </div>
      </Show>
      <Show when={libraryOpen()}>
        <div
          ref={libraryDialog}
          class="image-document-library"
          role="dialog"
          aria-label={message(
            'imageDocument.workspace.dialog.library.ariaLabel',
          )}
          tabindex="-1"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setLibraryOpen(false)
            }
          }}
        >
          <header>
            <strong>
              {message('imageDocument.workspace.dialog.library.title')}
            </strong>
            <button type="button" onClick={() => setLibraryOpen(false)}>
              {message('imageDocument.workspace.action.close')}
            </button>
          </header>
          <Show
            when={libraryRecords().length > 0}
            fallback={
              <p>{message('imageDocument.workspace.dialog.library.empty')}</p>
            }
          >
            <For each={libraryRecords()}>
              {(record) => (
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void openLibraryRecord(record)}
                >
                  <strong>{record.name}</strong>
                  <small>
                    {message(
                      'imageDocument.workspace.dialog.library.revision',
                      { revision: record.revision },
                    )}
                  </small>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <Show when={collaborationOpen()}>
        <div
          ref={collaborationDialog}
          class="image-document-library image-document-collaboration"
          role="dialog"
          aria-label={message(
            'imageDocument.workspace.dialog.shared.ariaLabel',
          )}
          tabindex="-1"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setCollaborationOpen(false)
            }
          }}
        >
          <header>
            <strong>
              {message('imageDocument.workspace.dialog.shared.title')}
            </strong>
            <button type="button" onClick={() => setCollaborationOpen(false)}>
              {message('imageDocument.workspace.action.close')}
            </button>
          </header>
          <Show
            when={collaborationSessions().length > 0}
            fallback={
              <p>{message('imageDocument.workspace.dialog.shared.empty')}</p>
            }
          >
            <For each={collaborationSessions()}>
              {(descriptor) => (
                <button
                  type="button"
                  disabled={busy()}
                  data-testid="image-collab-join"
                  onClick={() => void joinShared(descriptor)}
                >
                  <strong>{descriptor.documentId}</strong>
                  <small>
                    {message('imageDocument.workspace.dialog.shared.revision', {
                      revision: descriptor.revision,
                    })}
                  </small>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <Show when={confirmingEnd() ? active() : undefined} keyed>
        {(entry) => (
          <div
            class="image-document-library image-document-end-dialog"
            role="dialog"
            aria-labelledby="image-document-end-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !busy()) {
                event.preventDefault()
                setConfirmingEnd(false)
              }
            }}
          >
            <header>
              <strong id="image-document-end-title">
                {message('imageDocument.workspace.dialog.end.title')}
              </strong>
            </header>
            <p>{message('imageDocument.workspace.dialog.end.description')}</p>
            <div class="image-document-end-actions">
              <button
                type="button"
                data-testid="image-collab-end-cancel"
                onClick={() => setConfirmingEnd(false)}
                disabled={busy()}
              >
                {message('imageDocument.workspace.action.cancel')}
              </button>
              <button
                ref={endConfirmButton}
                type="button"
                class="danger"
                data-testid="image-collab-end-confirm"
                onClick={() => void endShared(entry)}
                disabled={busy()}
              >
                {message('imageDocument.workspace.action.endSession')}
              </button>
            </div>
          </div>
        )}
      </Show>
    </section>
  )
}
