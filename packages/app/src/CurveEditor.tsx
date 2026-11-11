import { createEffect, createMemo, createSignal, Index, onCleanup, Show } from 'solid-js'
import { asNodeId, canonicalJson, CURVE_HISTOGRAM_PREVIEW_CHANNEL, occurrenceKey, type Json } from '@dinkster/core'
import { curveInterpolator, isCurveValue, type CurvePoint, type CurveValue } from '@dinkster/widgets'
import type { AppState } from './app-state.js'
import type { EditorHostContext } from './editors.js'
import { useSignal } from './solid-adapter.js'
import { useAppMessage } from './locale.js'
import { ProductEmptyState } from './ProductSurfaces.js'

const clamp = (value: number): number => Math.max(0, Math.min(1, value))
const CURVE_WIDTH = 1000
const CURVE_HEIGHT = 600
const POINT_RADIUS = 10
const POINT_INSET = POINT_RADIUS + 8
const pointX = (position: number): number => POINT_INSET + clamp(position) * (CURVE_WIDTH - POINT_INSET * 2)
const pointY = (value: number): number => POINT_INSET + (1 - clamp(value)) * (CURVE_HEIGHT - POINT_INSET * 2)

const copyCurve = (value: CurveValue): CurveValue => ({
  interpolation: value.interpolation ?? 'linear',
  points: value.points.map((point) => ({ ...point })),
})

const histogramOf = (value: unknown): readonly number[] | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const histogram = (value as Readonly<Record<string, unknown>>)['histogram']
  return Array.isArray(histogram) && histogram.length === 256 && histogram.every((entry) =>
    typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0)
    ? histogram
    : undefined
}

export function CurveEditor(props: { readonly app: AppState; readonly host?: EditorHostContext }) {
  const appMessage = useAppMessage()
  const target = useSignal(props.app.curveEditorTarget)
  const tabs = useSignal(props.app.tabs)
  const globalActiveTabId = useSignal(props.app.activeTabId)
  const executions = useSignal(props.app.store.executions)
  const activeTabId = (): string => props.host?.tabId() ?? globalActiveTabId()
  const [documentTick, setDocumentTick] = createSignal(0)
  const [draft, setDraft] = createSignal<CurveValue>()
  const [selected, setSelected] = createSignal<number>()
  const [error, setError] = createSignal<string>()
  const [applying, setApplying] = createSignal(false)
  let live = true
  onCleanup(() => { live = false })
  let drag: { readonly pointerId: number; readonly pointIndex: number } | undefined
  let session: { readonly request: ReturnType<typeof target>; readonly activeTabId: string } | undefined

  createEffect(() => {
    const request = target()
    const active = activeTabId()
    if (session !== undefined && session.request === request && session.activeTabId === active) return
    session = { request, activeTabId: active }
    drag = undefined
    setSelected(undefined)
    setError(undefined)
    setApplying(false)
    setDraft(request && request.tabId === active ? copyCurve(request.openedValue) : undefined)
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

  const currentTarget = () => {
    documentTick()
    const request = target()
    if (!request || activeTabId() !== request.tabId) return undefined
    const tab = tabs().find((candidate) => candidate.id === request.tabId)
    return tab
      ? props.app.curveTargetForInput(
          tab, request.graphId, request.nodeId, request.inputId, request.instancePath,
        )
      : undefined
  }
  const displayedCurve = draft
  const positionExtent = () => Math.max(1, displayedCurve()?.points.at(-1)?.position ?? 0)
  const curveX = (position: number) => pointX(position / positionExtent())
  const readonly = createMemo(() => applying() || currentTarget() === undefined)
  const selectedPoint = createMemo(() => {
    const index = selected()
    return index === undefined ? undefined : displayedCurve()?.points[index]
  })

  const histogram = createMemo((): readonly number[] | undefined => {
    executions()
    const request = currentTarget()
    const tab = request && tabs().find((candidate) => candidate.id === request.tabId)
    const execution = tab ? props.app.executionForTab(tab) : undefined
    if (!request || !execution?.artifact) return undefined
    const source = occurrenceKey({
      instancePath: request.instancePath.map(asNodeId),
      node: asNodeId(request.nodeId),
    })
    const frames = (execution.artifact.provenance.fromSource[source] ?? []).flatMap((runtimeId) => {
      const frame = execution.previews[runtimeId]?.['curve-histogram']
      return frame?.channel === CURVE_HISTOGRAM_PREVIEW_CHANNEL ? [frame] : []
    }).sort((left, right) => right.timestamp - left.timestamp)
    return histogramOf(frames[0]?.payload)
  })

  const curvePath = createMemo(() => {
    const value = displayedCurve()
    if (!value) return ''
    const evaluate = curveInterpolator(value)
    return Array.from({ length: 129 }, (_, index) => {
      const position = index / 128 * positionExtent()
      return `${index === 0 ? 'M' : 'L'}${curveX(position)} ${pointY(evaluate(position))}`
    }).join('')
  })

  const histogramPath = createMemo(() => {
    const bins = histogram()
    const maximum = bins ? Math.max(...bins) : 0
    if (!bins || maximum === 0) return ''
    const width = 1000 / bins.length
    return bins.map((count, index) => {
      const height = count / maximum * 540
      return `M${index * width} 600V${600 - height}H${(index + 1) * width}V600Z`
    }).join('')
  })

  const pointFromEvent = (event: PointerEvent | MouseEvent, surface?: SVGSVGElement): CurvePoint => {
    const svg = surface ?? event.currentTarget as SVGSVGElement
    const rect = svg.getBoundingClientRect()
    const viewX = (event.clientX - rect.left) / rect.width * CURVE_WIDTH
    const viewY = (event.clientY - rect.top) / rect.height * CURVE_HEIGHT
    return {
      position: clamp((viewX - POINT_INSET) / (CURVE_WIDTH - POINT_INSET * 2)) * positionExtent(),
      value: clamp(1 - (viewY - POINT_INSET) / (CURVE_HEIGHT - POINT_INSET * 2)),
    }
  }

  const addPoint = (event: MouseEvent): void => {
    if (readonly()) return
    const value = draft()
    if (!value || value.points.length >= 4096) return
    const added = pointFromEvent(event)
    const next = [...value.points, added].sort((left, right) => left.position - right.position)
    if (next.some((point, index) => index > 0 && point.position === next[index - 1]!.position)) return
    setDraft({ interpolation: value.interpolation ?? 'linear', points: next })
    setSelected(next.indexOf(added))
  }

  const movePoint = (event: PointerEvent, index: number): void => {
    if (readonly() || drag?.pointerId !== event.pointerId || drag.pointIndex !== index) return
    const value = draft()
    const handle = event.currentTarget as SVGCircleElement
    const surface = handle.ownerSVGElement
    const original = value?.points[index]
    if (!value || !surface || !original) return
    const moved = pointFromEvent(event, surface)
    const previous = value.points[index - 1]?.position
    const next = value.points[index + 1]?.position
    const position = (previous !== undefined && moved.position <= previous) ||
      (next !== undefined && moved.position >= next)
      ? original.position
      : moved.position
    setDraft({
      interpolation: value.interpolation ?? 'linear',
      points: value.points.map((point, candidate) => candidate === index
        ? { position, value: moved.value }
        : point),
    })
    setSelected(index)
  }

  const startDrag = (event: PointerEvent, index: number): void => {
    if (readonly()) return
    drag = { pointerId: event.pointerId, pointIndex: index }
    const handle = event.currentTarget as SVGCircleElement
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      drag = undefined
      return
    }
    movePoint(event, index)
  }

  const finishDrag = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return
    drag = undefined
    const handle = event.currentTarget as SVGCircleElement
    try {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Pointer capture may already have been revoked by the browser.
    }
  }

  const apply = async (): Promise<void> => {
    if (applying()) return
    const request = target()
    const value = draft()
    const tab = request && tabs().find((candidate) => candidate.id === request.tabId)
    const valid = request && tab && value && isCurveValue(value)
      ? props.app.curveTargetForInput(
          tab, request.graphId, request.nodeId, request.inputId, request.instancePath,
        )
      : undefined
    if (!request || !tab || !value || !valid ||
      (valid.openedStoredValue === undefined) !== (request.openedStoredValue === undefined) ||
      (valid.openedStoredValue !== undefined && request.openedStoredValue !== undefined &&
        canonicalJson(valid.openedStoredValue) !== canonicalJson(request.openedStoredValue)) ||
      (valid.openedSchemaDefault === undefined) !== (request.openedSchemaDefault === undefined) ||
      (valid.openedSchemaDefault !== undefined && request.openedSchemaDefault !== undefined &&
        canonicalJson(valid.openedSchemaDefault) !== canonicalJson(request.openedSchemaDefault)) ||
      canonicalJson(valid.openedValue) !== canonicalJson(request.openedValue)) {
      setError('The curve input changed or became linked while editing')
      return
    }
    setApplying(true)
    const editing = session
    try {
      const outcome = await props.app.dispatchTo(tab, {
        command: 'node.setValue',
        params: {
          graphId: request.graphId,
          nodeId: request.nodeId,
          inputId: request.inputId,
          value: copyCurve(value) as unknown as Json,
        },
      })
      if (!live || session !== editing || target() !== request || activeTabId() !== request.tabId) return
      if (!outcome.ok) {
        setError(outcome.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? 'Curve update was refused')
        return
      }
      props.app.closeCurveEditor(request)
    } finally {
      if (live && session === editing) setApplying(false)
    }
  }

  return <section class="curve-editor" data-testid="curve-editor">
    <Show when={target()} fallback={<div class="editor-unavailable"><ProductEmptyState title="No curve target is active." /></div>}>
      {(request) => <>
        <header class="curve-editor-header">
          <div><strong>Curve editor</strong><small>{request().nodeId} / {request().inputId}</small></div>
          <div>
            <button onClick={() => props.app.closeCurveEditor(request())}>Cancel</button>
            <button class="primary" disabled={readonly()} onClick={apply}>Apply</button>
          </div>
        </header>
        <div class="curve-editor-body">
          <aside>
            <label>Interpolation<select
              aria-label="Interpolation"
              disabled={readonly()}
              value={draft()?.interpolation ?? 'linear'}
              onChange={(event) => {
                const value = draft()
                if (value) setDraft({ ...value, interpolation: event.currentTarget.value as 'linear' | 'monotone_cubic' })
              }}
            ><option value="linear">Linear</option><option value="monotone_cubic">Monotone cubic</option></select></label>
            <button
              disabled={readonly() || selected() === undefined || draft()!.points.length <= 1}
              onClick={() => {
                const value = draft()
                const index = selected()
                if (!value || index === undefined) return
                setDraft({
                  interpolation: value.interpolation ?? 'linear',
                  points: value.points.filter((_point, candidate) => candidate !== index),
                })
                setSelected(undefined)
              }}
            >Delete point</button>
            <p>Double-click the graph to add a point. Drag points to adjust them.</p>
            <p>Position and value range from 0 to 1.</p>
            <Show when={selectedPoint()}>{(point) => <dl class="curve-point-value" data-testid="curve-point-value">
              <div><dt>Position</dt><dd>{point().position.toFixed(4)}</dd></div>
              <div><dt>Value</dt><dd>{point().value.toFixed(4)}</dd></div>
            </dl>}</Show>
            <Show when={histogram()}><p data-testid="curve-histogram-status">Histogram from the selected run</p></Show>
          </aside>
          <svg
            class="curve-surface"
            data-testid="curve-surface"
            viewBox="0 0 1000 600"
            preserveAspectRatio="none"
            onDblClick={addPoint}
          >
            <path class="curve-histogram" data-testid="curve-histogram" d={histogramPath()} />
            <path class="curve-grid" d="M0 150H1000M0 300H1000M0 450H1000M250 0V600M500 0V600M750 0V600" />
            <path class="curve-line" d={curvePath()} />
            <Index each={displayedCurve()?.points}>{(point, index) => <circle
              classList={{ selected: selected() === index }}
              aria-label={`Curve point ${index + 1}`}
              cx={curveX(point().position)}
              cy={pointY(point().value)}
              r={POINT_RADIUS}
              onPointerDown={(event) => startDrag(event, index)}
              onPointerMove={(event) => movePoint(event, index)}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              onLostPointerCapture={(event) => {
                if (drag?.pointerId === event.pointerId) drag = undefined
              }}
              onDblClick={(event) => event.stopPropagation()}
              onClick={() => setSelected(index)}
            />}</Index>
          </svg>
        </div>
        <Show when={currentTarget() === undefined}><div class="curve-editor-error" role="alert">{appMessage('curveEditor.targetUnavailable')}</div></Show>
        <Show when={error()}>{(message) => <div class="curve-editor-error" role="alert">{message()}</div>}</Show>
      </>}
    </Show>
  </section>
}
