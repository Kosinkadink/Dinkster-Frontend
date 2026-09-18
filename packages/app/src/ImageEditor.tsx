import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from 'solid-js'
import type { AssetRef } from '@dinkster/core'
import { isCompositorEditorTarget, isMaskPaintEditorTarget, type AppState, type ImageEditorTarget } from './app-state.js'
import type { EditorHostContext } from './editors.js'
import { useSignal } from './solid-adapter.js'
import { CompositorEditor } from './CompositorEditor.js'
import { ProductSlider } from './ProductSlider.js'
import {
  appendImageEditOperation,
  createImageSession,
  maskPaintOperationsJson,
  projectImageMask,
  redoImageEdit,
  restoreMaskPaintSession,
  undoImageEdit,
  type ImageSession,
} from './image-editor.js'
import {
  imagePointerSamples,
  imageWheelNavigationViewport,
  ImageTouchNavigation,
} from './image-input.js'
import { applyMaskToRgba, type ImageEditPoint, type MaskEditOperation } from './image-mask-tool.js'
import { decodePng, encodePng } from './image-png.js'

interface ActiveStroke {
  readonly pointerId: number
  readonly base: ImageSession
  readonly mode: 'paint' | 'erase'
  readonly size: number
  readonly hardness: number
  readonly points: readonly ImageEditPoint[]
}

interface ActivePan {
  readonly pointerId: number
  readonly x: number
  readonly y: number
  readonly originX: number
  readonly originY: number
}

function MaskImageEditor(props: { readonly app: AppState; readonly host?: EditorHostContext }) {
  const activeTarget = useSignal(props.app.imageEditorTarget)
  const target = (): ImageEditorTarget | undefined => {
    const request = activeTarget()
    return request && !isCompositorEditorTarget(request) ? request : undefined
  }
  const tabs = useSignal(props.app.tabs)
  const globalActiveTabId = useSignal(props.app.activeTabId)
  // When hosted inside a split group, this editor shows the group's active
  // tab, which may differ from the app-global active tab.
  const activeTabId = (): string => props.host?.tabId() ?? globalActiveTabId()
  const [session, setSession] = createSignal<ImageSession>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [erase, setErase] = createSignal(false)
  const [brushSize, setBrushSize] = createSignal(32)
  const [hardness, setHardness] = createSignal(0.8)
  const [zoom, setZoom] = createSignal(1)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  let sourceCanvas!: HTMLCanvasElement
  let overlayCanvas!: HTMLCanvasElement
  let viewportElement!: HTMLDivElement
  let live = true
  let loadGeneration = 0
  let uploadAbort: AbortController | undefined
  let stroke: ActiveStroke | undefined
  let activePan: ActivePan | undefined
  const touchNavigation = new ImageTouchNavigation()

  const capturePointer = (pointerId: number): void => {
    try {
      viewportElement.setPointerCapture(pointerId)
    } catch {
      // Synthetic events and some digitizers do not grant capture.
    }
  }

  const releasePointer = (pointerId: number): void => {
    try {
      if (viewportElement.hasPointerCapture(pointerId)) viewportElement.releasePointerCapture(pointerId)
    } catch {
      // Capture may already have been revoked by the platform.
    }
  }

  const resetInput = (): void => {
    const base = stroke?.base
    const pointerIds = [
      ...(stroke === undefined ? [] : [stroke.pointerId]),
      ...(activePan === undefined ? [] : [activePan.pointerId]),
      ...touchNavigation.clear(),
    ]
    stroke = undefined
    activePan = undefined
    if (base !== undefined) setSession(base)
    if (viewportElement !== undefined) for (const pointerId of pointerIds) releasePointer(pointerId)
  }

  onCleanup(() => {
    resetInput()
    live = false
    uploadAbort?.abort()
  })

  const currentMask = createMemo(() => {
    const value = session()
    return value ? projectImageMask(value) : undefined
  })

  const draw = (): void => {
    const source = session()?.source
    const mask = currentMask()
    if (!source || !mask || !sourceCanvas || !overlayCanvas) return
    for (const canvas of [sourceCanvas, overlayCanvas]) {
      canvas.width = source.width
      canvas.height = source.height
    }
    const opaque = new Uint8ClampedArray(source.rgba)
    for (let pixel = 0; pixel < source.width * source.height; pixel += 1) opaque[pixel * 4 + 3] = 255
    sourceCanvas.getContext('2d')!.putImageData(new ImageData(opaque, source.width, source.height), 0, 0)
    const overlay = new Uint8ClampedArray(source.width * source.height * 4)
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      overlay[pixel * 4] = 255
      overlay[pixel * 4 + 1] = 45
      overlay[pixel * 4 + 2] = 75
      overlay[pixel * 4 + 3] = Math.round(mask[pixel]! * 0.62)
    }
    overlayCanvas.getContext('2d')!.putImageData(new ImageData(overlay, source.width, source.height), 0, 0)
  }

  createEffect(draw)

  createEffect(() => {
    const request = target()
    const generation = ++loadGeneration
    resetInput()
    setSession(undefined)
    setError(undefined)
    if (!request || activeTabId() !== request.tabId) return
    const resolved = untrack(() => {
      const tab = tabs().find((candidate) => candidate.id === request.tabId)
      return tab ? { tab, backend: props.app.backendForTab(tab) } : undefined
    })
    if (!resolved) return
    const { backend } = resolved
    if (backend.protocol !== 'dinkster') {
      setError('Image editing requires a native Dinkster backend')
      return
    }
    void fetch(backend.connection.assetUrl(request.sourceRef.digest)).then(async (response) => {
      if (!response.ok) throw new Error(`Source image fetch failed (${response.status})`)
      const decoded = await decodePng(new Uint8Array(await response.arrayBuffer()))
      if (!live || generation !== loadGeneration || target() !== request) return
      const created = createImageSession(decoded)
      const existingOperations = request.maskPaint?.expectedPaintOperations
      setSession(existingOperations === undefined || existingOperations === null
        ? created
        : restoreMaskPaintSession(created, existingOperations, request.sourceRef.digest))
    }).catch((cause) => {
      if (live && generation === loadGeneration) setError(cause instanceof Error ? cause.message : String(cause))
    })
  })

  const close = (request: ImageEditorTarget): void => {
    if (busy()) return
    props.app.closeImageEditor(request)
  }

  const appendOperation = (operation: MaskEditOperation): void => {
    const editing = session()
    if (editing) setSession(appendImageEditOperation(editing, operation))
  }

  const apply = async (request: ImageEditorTarget): Promise<void> => {
    const editing = session()
    const source = editing?.source
    const mask = currentMask()
    const tab = tabs().find((candidate) => candidate.id === request.tabId)
    if (!source || !mask || !tab || busy()) return
    const backend = props.app.backendForTab(tab)
    if (backend.protocol !== 'dinkster') return
    setBusy(true)
    setError(undefined)
    const abort = new AbortController()
    uploadAbort = abort
    try {
      if (isMaskPaintEditorTarget(request)) {
        const validated = props.app.validateImageTarget(request)
        const currentTab = validated ? props.app.tabs.get().find((candidate) => candidate.id === request.tabId) : undefined
        if (!currentTab || !validated || props.app.backendForTab(currentTab) !== backend) {
          setError('The image destination changed while the mask was being edited')
          return
        }
        const outcome = props.app.dispatchTo(currentTab, {
          command: 'image.applyMaskPaint',
          params: {
            graphId: request.graphId,
            loaderNodeId: request.nodeId,
            inputId: request.inputId,
            expectedSource: request.sourceRef,
            operations: maskPaintOperationsJson(editing, request.sourceRef.digest),
            paintNodeId: request.maskPaint!.paintNodeId,
            expectedPaintOperations: request.maskPaint!.expectedPaintOperations,
            expectedMaskLinkIds: request.maskPaint!.expectedMaskLinkIds,
            expectedMaskNetIds: request.maskPaint!.expectedMaskNetIds,
          },
        })
        if (!outcome.ok) {
          setError(outcome.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? 'Mask apply was rejected')
          return
        }
        props.app.closeImageEditor(request)
        return
      }
      const png = await encodePng(source.width, source.height, applyMaskToRgba(source.rgba, mask))
      const blob = new Blob([new Uint8Array(png).buffer], { type: 'image/png' })
      const digest = await backend.connection.uploadAsset(blob, abort.signal)
      if (!live || abort.signal.aborted || target() !== request) return
      const validated = props.app.validateImageTarget(request)
      const currentTab = validated ? props.app.tabs.get().find((candidate) => candidate.id === request.tabId) : undefined
      if (!currentTab || !validated || props.app.backendForTab(currentTab) !== backend) {
        setError('The image destination changed while the image was uploading')
        return
      }
      const ref: AssetRef = {
        digest,
        name: request.sourceRef.name.replace(/\.[^.]*$/, '') + '-edited.png',
        size: blob.size,
        mediaType: 'image/png',
        virtualPath: '',
      }
      const outcome = props.app.dispatchTo(currentTab, {
        command: 'image.applyAsset',
        params: {
          graphId: request.graphId,
          nodeId: request.nodeId,
          inputId: request.inputId,
          expectedSourceDigest: request.sourceRef.digest,
          asset: ref,
        },
      })
      if (!outcome.ok) {
        setError(outcome.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? 'Image apply was rejected')
        return
      }
      props.app.closeImageEditor(request)
    } catch (cause) {
      if (live && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (uploadAbort === abort) uploadAbort = undefined
      if (live) setBusy(false)
    }
  }

  const appendStrokeSamples = (event: PointerEvent): void => {
    const active = stroke
    const source = session()?.source
    if (!active || !source) return
    const rect = overlayCanvas.getBoundingClientRect()
    const points = imagePointerSamples(event, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      imageWidth: source.width,
      imageHeight: source.height,
    }).filter((point) => {
      const radius = Math.max(0.5, active.size * (0.25 + point.pressure * 0.75) / 2)
      return point.x + radius >= 0.5 && point.x - radius <= source.width - 0.5 &&
        point.y + radius >= 0.5 && point.y - radius <= source.height - 0.5
    })
    if (points.length === 0) return
    stroke = { ...active, points: [...active.points, ...points] }
    setSession(appendImageEditOperation(active.base, {
      kind: 'mask.stroke',
      mode: active.mode,
      size: active.size,
      hardness: active.hardness,
      points: stroke.points,
    }))
  }

  const pointerPoint = (event: PointerEvent): { x: number; y: number } => {
    const rect = viewportElement.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const endPointer = (event: PointerEvent, cancel: boolean, release = true): void => {
    if (touchNavigation.has(event.pointerId)) {
      touchNavigation.end(event.pointerId)
      if (release) releasePointer(event.pointerId)
      return
    }
    if (stroke?.pointerId === event.pointerId) {
      const base = stroke.base
      stroke = undefined
      if (cancel) setSession(base)
      if (release) releasePointer(event.pointerId)
      return
    }
    if (activePan?.pointerId === event.pointerId) {
      activePan = undefined
      if (release) releasePointer(event.pointerId)
    }
  }

  const onPointerDown = (event: PointerEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.pointerType === 'touch') {
      if (stroke !== undefined || activePan !== undefined) return
      if (touchNavigation.start(event.pointerId, pointerPoint(event))) capturePointer(event.pointerId)
      return
    }
    if (stroke !== undefined || activePan !== undefined) return
    const touchPointers = touchNavigation.clear()
    if (touchPointers.length > 0) {
      for (const pointerId of touchPointers) releasePointer(pointerId)
      if (event.pointerType !== 'pen') return
    }
    if (event.button === 1 || event.button === 2 || event.shiftKey) {
      const current = pan()
      activePan = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        originX: current.x,
        originY: current.y,
      }
    } else if (event.button === 0) {
      const base = session()
      if (!base) return
      stroke = {
        pointerId: event.pointerId,
        base,
        mode: erase() ? 'erase' : 'paint',
        size: brushSize(),
        hardness: hardness(),
        points: [],
      }
      appendStrokeSamples(event)
    } else return
    capturePointer(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (touchNavigation.has(event.pointerId)) {
      const rect = viewportElement.getBoundingClientRect()
      const next = touchNavigation.move(
        event.pointerId,
        pointerPoint(event),
        { panX: pan().x, panY: pan().y, scale: zoom() },
        { width: rect.width, height: rect.height },
      )
      if (next) {
        setPan({ x: next.panX, y: next.panY })
        setZoom(next.scale)
      }
      return
    }
    if (stroke?.pointerId === event.pointerId) {
      appendStrokeSamples(event)
      return
    }
    if (activePan?.pointerId === event.pointerId) {
      setPan({
        x: activePan.originX + event.clientX - activePan.x,
        y: activePan.originY + event.clientY - activePan.y,
      })
    }
  }

  return (
    <section class="image-editor" data-testid="image-editor" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <Show when={target()} fallback={<div class="editor-missing">No image target is active.</div>}>
        {(request) => (
          <>
            <header class="image-editor-header">
              <div><strong>Image editor</strong><span>Mask</span><small>{request().sourceRef.name}</small></div>
              <div class="image-editor-actions">
                <button disabled={busy()} onClick={() => close(request())}>Cancel</button>
                <button class="primary" disabled={busy() || !session()} onClick={() => void apply(request())}>{busy() ? 'Applying...' : isMaskPaintEditorTarget(request()) ? 'Apply mask to graph' : 'Bake to asset'}</button>
              </div>
            </header>
            <div class="image-editor-body">
              <aside class="image-mask-tool-rail" aria-label="Mask tools">
                <button classList={{ selected: !erase() }} onClick={() => setErase(false)}>Paint</button>
                <button classList={{ selected: erase() }} onClick={() => setErase(true)}>Erase</button>
                <label>Size <ProductSlider ariaLabel="Brush size" min={1} max={256} value={brushSize()} onInput={setBrushSize} /></label>
                <label>Hardness <ProductSlider ariaLabel="Brush hardness" min={0} max={1} step={0.05} value={hardness()} onInput={setHardness} /></label>
                <button disabled={(session()?.index ?? -1) < 0} onClick={() => { const value = session(); if (value) setSession(undoImageEdit(value)) }}>Undo mask edit</button>
                <button disabled={!session() || session()!.index + 1 >= session()!.operations.length} onClick={() => { const value = session(); if (value) setSession(redoImageEdit(value)) }}>Redo mask edit</button>
                <button disabled={!session()} onClick={() => appendOperation({ kind: 'mask.clear' })}>Clear</button>
                <button disabled={!session()} onClick={() => appendOperation({ kind: 'mask.invert' })}>Invert</button>
                <output>{Math.round(zoom() * 100)}%</output>
              </aside>
              <div
                ref={viewportElement}
                class="image-canvas-viewport"
                data-testid="image-canvas-viewport"
                onWheel={(event) => {
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const next = imageWheelNavigationViewport(
                    { panX: pan().x, panY: pan().y, scale: zoom() },
                    {
                      screenX: event.clientX - rect.left,
                      screenY: event.clientY - rect.top,
                      deltaX: event.deltaX,
                      deltaY: event.deltaY,
                      deltaMode: event.deltaMode,
                      pageWidth: rect.width,
                      pageHeight: rect.height,
                      ctrlKey: event.ctrlKey,
                    },
                    { width: rect.width, height: rect.height },
                    props.app.settings.get<'zoom' | 'pan'>('canvas.scrollBehavior'),
                  )
                  setPan({ x: next.panX, y: next.panY })
                  setZoom(next.scale)
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={(event) => endPointer(event, false)}
                onPointerCancel={(event) => endPointer(event, true)}
                onLostPointerCapture={(event) => endPointer(event, true, false)}
                onContextMenu={(event) => event.preventDefault()}
              >
                <Show when={!session() && !error()}><div class="image-editor-loading">Loading source image...</div></Show>
                <div
                  class="image-canvas-stack"
                  style={{
                    left: `calc(50% + ${pan().x}px)`,
                    top: `calc(50% + ${pan().y}px)`,
                    width: `${session()?.source.width ?? 0}px`,
                    height: `${session()?.source.height ?? 0}px`,
                    transform: `translate(-50%, -50%) scale(${zoom()})`,
                  }}
                >
                  <canvas ref={sourceCanvas} />
                  <canvas ref={overlayCanvas} data-testid="image-mask-surface" />
                </div>
              </div>
            </div>
            <Show when={error()}>{(message) => <div class="image-editor-error" role="alert">{message()}</div>}</Show>
          </>
        )}
      </Show>
    </section>
  )
}

export function ImageEditor(props: { readonly app: AppState; readonly host?: EditorHostContext }) {
  const target = useSignal(props.app.imageEditorTarget)
  return <Show when={target()} fallback={<section class="image-editor"><div class="editor-missing">No image target is active.</div></section>}>
    {(request) => isCompositorEditorTarget(request())
      ? <CompositorEditor app={props.app} {...(props.host ? { host: props.host } : {})} />
      : <MaskImageEditor app={props.app} {...(props.host ? { host: props.host } : {})} />}
  </Show>
}
