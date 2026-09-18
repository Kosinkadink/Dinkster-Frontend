import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import {
  asNodeId,
  COMPOSITOR_BLEND_MODES,
  COMPOSITOR_STATE_PREVIEW_CHANNEL,
  COMPOSITOR_STATE_PREVIEW_STREAM,
  compositorDeltaFromDraft,
  compositorRecipeFingerprint,
  compositorStateOf,
  copyConfiguredCompositorRecipe,
  isConfiguredCompositorRecipe,
  occurrenceKey,
  type CompositorLayer,
  type ConfiguredCompositorRecipe,
  type CompositorState,
  type Json,
} from '@dinkster/core'
import type { PreviewData } from '@dinkster/client'
import { isCompositorEditorTarget, type AppState, type CompositorEditorTarget } from './app-state.js'
import type { EditorHostContext } from './editors.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'

interface RuntimeCompositor {
  readonly state: CompositorState
  readonly frames: readonly (PreviewData | undefined)[]
}

const move = <T,>(values: readonly T[], from: number, to: number): readonly T[] => {
  if (from === to || from < 0 || to < 0 || from >= values.length || to >= values.length) return values
  const next = [...values]
  const [value] = next.splice(from, 1)
  next.splice(to, 0, value!)
  return next
}

const cssBlendMode = (mode: string): string => ({
  normal: 'normal',
  dissolve: 'normal',
  linear_dodge: 'plus-lighter',
  linear_burn: 'multiply',
  vivid_light: 'hard-light',
  linear_light: 'hard-light',
}[mode] ?? mode.replaceAll('_', '-'))

function PreviewLayer(props: {
  readonly layer: () => CompositorLayer
  readonly frame: () => PreviewData | undefined
  readonly canvas: () => ConfiguredCompositorRecipe['canvas']
  readonly selected: () => boolean
  readonly onSelect: (event: PointerEvent) => void
  readonly onMove: (event: PointerEvent) => void
  readonly onFinish: (event: PointerEvent) => void
}) {
  const [url, setUrl] = createSignal<string>()
  createEffect(() => {
    const frame = props.frame()
    const payload = frame?.payload
    const blob = payload instanceof Blob
      ? payload
      : payload instanceof ArrayBuffer
        ? new Blob([payload], { type: frame?.channel ?? 'image/png' })
        : undefined
    if (!blob) {
      setUrl(undefined)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    onCleanup(() => URL.revokeObjectURL(next))
  })
  const style = createMemo<JSX.CSSProperties>(() => {
    const layer = props.layer()
    const canvas = props.canvas()
    return {
      left: `${layer.transform.x / canvas.width * 100}%`,
      top: `${layer.transform.y / canvas.height * 100}%`,
      width: `${layer.transform.width / canvas.width * 100}%`,
      height: `${layer.transform.height / canvas.height * 100}%`,
      opacity: String(layer.opacity),
      display: layer.visible ? 'block' : 'none',
      'mix-blend-mode': cssBlendMode(layer.blend) as JSX.CSSProperties['mix-blend-mode'],
      transform: `rotate(${layer.transform.rotation}rad) scale(${layer.flipH ? -1 : 1}, ${layer.flipV ? -1 : 1})`,
    }
  })
  return <Show when={url()}>
    {(source) => <img
      class="compositor-preview-layer"
      classList={{ selected: props.selected() }}
      src={source()}
      alt=""
      draggable={false}
      style={style()}
      onPointerDown={props.onSelect}
      onPointerMove={props.onMove}
      onPointerUp={props.onFinish}
      onPointerCancel={props.onFinish}
      onLostPointerCapture={props.onFinish}
    />}
  </Show>
}

function NumberField(props: {
  readonly label: string
  readonly value: () => number
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly disabled: () => boolean
  readonly onInput: (value: number) => void
}) {
  return <label>{props.label}<input
    type="number"
    value={props.value()}
    min={props.min}
    max={props.max}
    step={props.step ?? 1}
    disabled={props.disabled()}
    onInput={(event) => {
      const value = event.currentTarget.valueAsNumber
      if (Number.isFinite(value)) props.onInput(value)
    }}
  /></label>
}

export function CompositorEditor(props: { readonly app: AppState; readonly host?: EditorHostContext }) {
  const message = useAppMessage()
  const activeTarget = useSignal(props.app.imageEditorTarget)
  const tabs = useSignal(props.app.tabs)
  const executions = useSignal(props.app.store.executions)
  const globalActiveTabId = useSignal(props.app.activeTabId)
  const activeTabId = (): string => props.host?.tabId() ?? globalActiveTabId()
  const target = createMemo((): CompositorEditorTarget | undefined => {
    const value = activeTarget()
    return value && isCompositorEditorTarget(value) ? value : undefined
  })
  const [documentTick, setDocumentTick] = createSignal(0)
  const [draft, setDraft] = createSignal<ConfiguredCompositorRecipe>()
  const [selectedId, setSelectedId] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  let initializedTarget: CompositorEditorTarget | undefined
  let openedDocumentDigest: string | undefined
  let drag: {
    readonly pointerId: number
    readonly layerId: string
    readonly startX: number
    readonly startY: number
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  } | undefined

  createEffect(() => {
    const request = target()
    const active = activeTabId()
    drag = undefined
    setError(undefined)
    if (request !== initializedTarget || request?.tabId !== active) {
      initializedTarget = undefined
      openedDocumentDigest = undefined
      setDraft(undefined)
      setSelectedId(undefined)
    }
  })

  createEffect(() => {
    const request = target()
    const active = activeTabId()
    const tab = request && request.tabId === active
      ? tabs().find((candidate) => candidate.id === request.tabId)
      : undefined
    if (!tab) return
    const unsubscribe = tab.store.document.subscribe(() => setDocumentTick((tick) => tick + 1))
    onCleanup(unsubscribe)
  })

  const currentTarget = createMemo(() => {
    documentTick()
    const request = target()
    return request && activeTabId() === request.tabId
      ? props.app.validateCompositorTarget(request)
      : undefined
  })

  const runtime = createMemo((): RuntimeCompositor | undefined => {
    executions()
    const request = currentTarget()
    const tab = request && tabs().find((candidate) => candidate.id === request.tabId)
    const execution = tab ? props.app.executionForTab(tab) : undefined
    if (!request || !execution?.artifact) return undefined
    const source = occurrenceKey({
      instancePath: request.instancePath.map(asNodeId),
      node: asNodeId(request.nodeId),
    })
    return (execution.artifact.provenance.fromSource[source] ?? []).flatMap((runtimeNodeId) => {
      const stateFrame = execution.previews[runtimeNodeId]?.[COMPOSITOR_STATE_PREVIEW_STREAM]
      const state = stateFrame?.channel === COMPOSITOR_STATE_PREVIEW_CHANNEL
        ? compositorStateOf(stateFrame.payload)
        : undefined
      return state === undefined ? [] : [{
        state,
        frames: state.layerStreams.map((stream) => execution.previews[runtimeNodeId]?.[stream]),
        timestamp: stateFrame?.timestamp ?? 0,
      }]
    }).sort((left, right) => right.timestamp - left.timestamp)[0]
  })

  createEffect(() => {
    const request = target()
    const currentRequest = currentTarget()
    const current = runtime()
    if (!request || !currentRequest || !current || initializedTarget === request) return
    const value = copyConfiguredCompositorRecipe(current.state)
    initializedTarget = request
    openedDocumentDigest = current.state.documentDigest
    setDraft(value)
    setSelectedId(value.layers.at(-1)?.id)
  })

  const selectedLayer = createMemo(() => draft()?.layers.find((layer) => layer.id === selectedId()))
  const readonly = createMemo(() => currentTarget() === undefined)

  const updateLayer = (layerId: string, update: (layer: CompositorLayer) => CompositorLayer): void => {
    const value = draft()
    if (!value || readonly()) return
    setDraft({ ...value, layers: value.layers.map((layer) => layer.id === layerId ? update(layer) : layer) })
  }
  const updateSelected = (update: (layer: CompositorLayer) => CompositorLayer): void => {
    const layerId = selectedId()
    if (layerId) updateLayer(layerId, update)
  }
  const updateTransform = (field: keyof CompositorLayer['transform'], value: number): void =>
    updateSelected((layer) => ({ ...layer, transform: { ...layer.transform, [field]: value } }))

  const reorder = (direction: -1 | 1): void => {
    const value = draft()
    const layerId = selectedId()
    if (!value || !layerId || readonly()) return
    const from = value.layers.findIndex((layer) => layer.id === layerId)
    const to = from + direction
    if (to < 0 || to >= value.layers.length) return
    setDraft({ ...value, layers: move(value.layers, from, to) })
  }

  const startDrag = (event: PointerEvent, layer: CompositorLayer): void => {
    const value = draft()
    const surface = (event.currentTarget as HTMLElement).parentElement
    if (!value || !surface || readonly()) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedId(layer.id)
    try {
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    } catch {
      return
    }
    drag = {
      pointerId: event.pointerId,
      layerId: layer.id,
      startX: event.clientX,
      startY: event.clientY,
      x: layer.transform.x,
      y: layer.transform.y,
      width: surface.clientWidth,
      height: surface.clientHeight,
    }
  }

  const moveDrag = (event: PointerEvent): void => {
    const active = drag
    const value = draft()
    if (!active || !value || active.pointerId !== event.pointerId || active.width <= 0 || active.height <= 0) return
    updateLayer(active.layerId, (layer) => ({
      ...layer,
      transform: {
        ...layer.transform,
        x: active.x + (event.clientX - active.startX) * value.canvas.width / active.width,
        y: active.y + (event.clientY - active.startY) * value.canvas.height / active.height,
      },
    }))
  }

  const finishDrag = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return
    drag = undefined
    const element = event.currentTarget as HTMLElement
    try {
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already have been revoked by the browser.
    }
  }

  const apply = (): void => {
    const request = target()
    const current = request ? props.app.validateCompositorTarget(request) : undefined
    const value = draft()
    const state = runtime()?.state
    const tab = current && tabs().find((candidate) => candidate.id === current.tabId)
    if (!request || !current || !tab || !value || !isConfiguredCompositorRecipe(value)) {
      setError(message('compositor.error.invalidInput'))
      return
    }
    if (!state || openedDocumentDigest !== state.documentDigest) {
      setError(message('compositor.error.sourcesChanged'))
      return
    }
    const expectedRecipeFingerprint = compositorRecipeFingerprint(request.openedStoredValue)
    if (expectedRecipeFingerprint === undefined) {
      setError(message('compositor.error.invalidRecipe'))
      return
    }
    const recipe = compositorDeltaFromDraft(state, value)
    if (!recipe) {
      setError(message('compositor.error.documentMismatch'))
      return
    }
    const outcome = props.app.dispatchTo(tab, {
      command: 'image.compositorApply',
      params: {
        graphId: request.graphId,
        nodeId: request.nodeId,
        inputId: request.inputId,
        instancePath: request.instancePath,
        expectedRecipeFingerprint,
        recipe: recipe as unknown as Json,
      },
    })
    if (!outcome.ok) {
      setError(outcome.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? message('compositor.error.refused'))
      return
    }
    props.app.closeImageEditor(request)
  }

  const background = createMemo(() => {
    const value = draft()?.background
    if (!value?.visible) return 'transparent'
    const red = Number.parseInt(value.color.slice(1, 3), 16)
    const green = Number.parseInt(value.color.slice(3, 5), 16)
    const blue = Number.parseInt(value.color.slice(5, 7), 16)
    return `rgba(${red}, ${green}, ${blue}, ${value.opacity})`
  })

  return <section class="image-editor compositor-editor" data-testid="compositor-editor">
    <Show when={target()} fallback={<div class="editor-missing">{message('compositor.noTarget')}</div>}>
      {(request) => <>
        <header class="image-editor-header">
          <div><strong>{message('compositor.editor')}</strong><span>{message('compositor.title')}</span><small>{request().nodeId} / {request().inputId}</small></div>
          <div class="image-editor-actions">
            <button onClick={() => props.app.closeImageEditor(request())}>{message('compositor.action.cancel')}</button>
            <button class="primary" disabled={readonly() || !isConfiguredCompositorRecipe(draft())} onClick={apply}>{message('compositor.action.apply')}</button>
          </div>
        </header>
        <Show when={draft()} fallback={
          <div class="compositor-empty" data-testid="compositor-empty">
            <strong>{message('compositor.empty.title')}</strong>
            <p>{message('compositor.empty.detail')}</p>
          </div>
        }>
          {(recipe) => <div class="compositor-editor-body">
            <aside class="compositor-layer-panel" aria-label={message('compositor.layers.ariaLabel')}>
              <header><strong>{message('compositor.layers.title')}</strong><small>{recipe().layers.length} / 50</small></header>
              <div class="compositor-layer-list">
                <For each={[...recipe().layers].reverse()}>{(layer) =>
                  <button
                    class="compositor-layer-row"
                    classList={{ selected: selectedId() === layer.id }}
                    onClick={() => setSelectedId(layer.id)}
                  >
                    <span classList={{ hidden: !layer.visible }}>{message(layer.visible ? 'compositor.layer.visible' : 'compositor.layer.hidden')}</span>
                    <strong>{layer.name}</strong>
                    <small>{layer.blend.replaceAll('_', ' ')}</small>
                  </button>
                }</For>
              </div>
              <div class="compositor-layer-order">
                <button disabled={!selectedLayer() || recipe().layers.at(-1)?.id === selectedId()} onClick={() => reorder(1)}>{message('compositor.layer.raise')}</button>
                <button disabled={!selectedLayer() || recipe().layers[0]?.id === selectedId()} onClick={() => reorder(-1)}>{message('compositor.layer.lower')}</button>
              </div>
            </aside>
            <main class="compositor-preview-panel">
              <Show when={runtime()?.state.stale}>
                <div class="compositor-stale" role="status">{message('compositor.stale')}</div>
              </Show>
              <div class="compositor-preview-viewport">
                <div
                  class="compositor-preview-canvas"
                  data-testid="compositor-preview-canvas"
                  style={{ 'aspect-ratio': `${recipe().canvas.width} / ${recipe().canvas.height}`, 'background-color': background() }}
                >
                  <For each={recipe().layers}>{(layer) => <PreviewLayer
                    layer={() => layer}
                    frame={() => runtime()?.frames[layer.source]}
                    canvas={() => recipe().canvas}
                    selected={() => selectedId() === layer.id}
                    onSelect={(event) => startDrag(event, layer)}
                    onMove={moveDrag}
                    onFinish={finishDrag}
                  />}</For>
                </div>
              </div>
              <p>{message('compositor.preview.help')}</p>
            </main>
            <aside class="compositor-properties" aria-label={message('compositor.properties.ariaLabel')}>
              <fieldset>
                <legend>{message('compositor.canvas.title')}</legend>
                <div class="compositor-field-grid">
                  <NumberField label={message('compositor.field.width')} value={() => recipe().canvas.width} min={1} max={16384} disabled={readonly}
                    onInput={(width) => setDraft({ ...recipe(), canvas: { ...recipe().canvas, width: Math.round(width) } })} />
                  <NumberField label={message('compositor.field.height')} value={() => recipe().canvas.height} min={1} max={16384} disabled={readonly}
                    onInput={(height) => setDraft({ ...recipe(), canvas: { ...recipe().canvas, height: Math.round(height) } })} />
                </div>
                <label class="compositor-check"><input type="checkbox" checked={recipe().background.visible} disabled={readonly()}
                  onChange={(event) => setDraft({ ...recipe(), background: { ...recipe().background, visible: event.currentTarget.checked } })} />{message('compositor.background.enabled')}</label>
                <label>{message('compositor.background.color')}<input type="color" value={recipe().background.color} disabled={readonly()}
                  onInput={(event) => setDraft({ ...recipe(), background: { ...recipe().background, color: event.currentTarget.value.toLowerCase() } })} /></label>
                <label>{message('compositor.background.opacity')}<input type="range" min="0" max="1" step="0.01" value={recipe().background.opacity} disabled={readonly()}
                  onInput={(event) => setDraft({ ...recipe(), background: { ...recipe().background, opacity: event.currentTarget.valueAsNumber } })} /></label>
              </fieldset>
              <Show when={selectedLayer()}>{(layer) => <fieldset>
                <legend>{message('compositor.selected.title')}</legend>
                <label>{message('compositor.field.name')}<input value={layer().name} maxlength="256" disabled={readonly()}
                  onInput={(event) => updateSelected((value) => ({ ...value, name: event.currentTarget.value }))} /></label>
                <label class="compositor-check"><input type="checkbox" checked={layer().visible} disabled={readonly()}
                  onChange={(event) => updateSelected((value) => ({ ...value, visible: event.currentTarget.checked }))} />{message('compositor.layer.visible')}</label>
                <label>{message('compositor.field.opacity')}<input type="range" min="0" max="1" step="0.01" value={layer().opacity} disabled={readonly()}
                  onInput={(event) => updateSelected((value) => ({ ...value, opacity: event.currentTarget.valueAsNumber }))} /></label>
                <label>{message('compositor.field.blendMode')}<select value={layer().blend} disabled={readonly()}
                  onChange={(event) => updateSelected((value) => ({ ...value, blend: event.currentTarget.value as CompositorLayer['blend'] }))}>
                  <For each={COMPOSITOR_BLEND_MODES}>{(mode) => <option value={mode}>{mode.replaceAll('_', ' ')}</option>}</For>
                </select></label>
                <div class="compositor-field-grid">
                  <NumberField label={message('compositor.field.x')} value={() => layer().transform.x} disabled={readonly} onInput={(value) => updateTransform('x', value)} />
                  <NumberField label={message('compositor.field.y')} value={() => layer().transform.y} disabled={readonly} onInput={(value) => updateTransform('y', value)} />
                  <NumberField label={message('compositor.field.width')} value={() => layer().transform.width} min={1} max={16384} disabled={readonly} onInput={(value) => updateTransform('width', value)} />
                  <NumberField label={message('compositor.field.height')} value={() => layer().transform.height} min={1} max={16384} disabled={readonly} onInput={(value) => updateTransform('height', value)} />
                </div>
                <NumberField label={message('compositor.field.rotationDegrees')} value={() => layer().transform.rotation * 180 / Math.PI} step={0.1} disabled={readonly}
                  onInput={(value) => updateTransform('rotation', value * Math.PI / 180)} />
                <div class="compositor-flips">
                  <button classList={{ selected: layer().flipH }} onClick={() => updateSelected((value) => ({ ...value, flipH: !value.flipH }))}>{message('compositor.flip.horizontal')}</button>
                  <button classList={{ selected: layer().flipV }} onClick={() => updateSelected((value) => ({ ...value, flipV: !value.flipV }))}>{message('compositor.flip.vertical')}</button>
                </div>
              </fieldset>}</Show>
            </aside>
          </div>}
        </Show>
        <Show when={error()}>{(message) => <div class="image-editor-error" role="alert">{message()}</div>}</Show>
      </>}
    </Show>
  </section>
}
