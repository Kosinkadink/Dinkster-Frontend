import { createEffect, createMemo, createSignal, Index, onCleanup, Show } from 'solid-js'
import { asNodeId, canonicalJson, CURVE_HISTOGRAM_PREVIEW_CHANNEL, occurrenceKey, occurrencesForView, type Json } from '@dinkster/core'
import { curveInterpolator, isCurveValue, type CurvePoint, type CurveValue } from '@dinkster/widgets'
import type { AppState } from './app-state.js'
import type { EditorHostContext } from './editors.js'
import { useSignal } from './solid-adapter.js'
import { audioPlayhead } from './AudioTransport.js'
import { liveExactnessFor } from './companion-display.js'
import { useAppMessage } from './locale.js'

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
  const [computed, setComputed] = createSignal<CurveValue>()
  const [computedStatus, setComputedStatus] = createSignal('')
  const [selected, setSelected] = createSignal<number>()
  const [error, setError] = createSignal<string>()
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
    setComputed(undefined)
    setComputedStatus('')
    setDraft(request && request.tabId === active && request.follow === undefined ? copyCurve(request.openedValue) : undefined)
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
  const followContext = createMemo(() => {
    executions()
    const request = currentTarget()
    if (!request?.follow) return undefined
    const tab = tabs().find((candidate) => candidate.id === request.tabId)
    const execution = tab ? props.app.executionForTab(tab) : undefined
    const backend = execution && props.app.backendFor(execution.ref.connection)
    if (!tab || !execution?.artifact || execution.status !== 'completed' || backend?.protocol !== 'dinkster') return undefined
    const runtimeIds = new Set([...Object.keys(execution.nodes), ...Object.keys(execution.outputs)])
    const occurrences = occurrencesForView({
      instancePath: request.instancePath.map(asNodeId),
      runtimeIds,
      toSource: execution.artifact.provenance.toSource,
    })
    const envelopeRuntimeIds = occurrences.own.get(asNodeId(request.follow.envelopeNodeId)) ?? []
    const audioRuntimeIds = occurrences.own.get(asNodeId(request.follow.audioNodeId)) ?? []
    if (envelopeRuntimeIds.length !== 1 || audioRuntimeIds.length !== 1) return undefined
    const envelopeRuntimeId = envelopeRuntimeIds[0]!
    const audioRuntimeId = audioRuntimeIds[0]!
    const compiled = props.app.compileTabCached(tab)
    const exact = compiled?.ok && compiled.artifact.connection === execution.ref.connection
      ? liveExactnessFor(compiled.artifact, execution.artifact)
      : undefined
    if (exact?.(envelopeRuntimeId) !== true || exact(audioRuntimeId) !== true) return undefined
    const aliases = execution.artifact.provenance.outputAliases
    const curveQuery = {
      jobId: execution.ref.prompt,
      nodeId: envelopeRuntimeId,
      outputId: aliases?.[envelopeRuntimeId]?.['curve'] ?? 'curve',
    }
    const audioQuery = {
      jobId: execution.ref.prompt,
      nodeId: audioRuntimeId,
      outputId: aliases?.[audioRuntimeId]?.[request.follow.audioOutputId] ?? request.follow.audioOutputId,
    }
    return { values: backend.connection.values(), curveQuery, audioIdentity: JSON.stringify(audioQuery) }
  })
  const matchingAudioPlayhead = createMemo(() => {
    const context = followContext()
    const playhead = audioPlayhead()
    return context !== undefined && playhead?.identity === context.audioIdentity ? playhead : undefined
  })
  const displayedCurve = createMemo(() => currentTarget()?.follow === undefined ? draft() : computed())
  const positionExtent = () => Math.max(1, matchingAudioPlayhead()?.duration ?? 0, displayedCurve()?.points.at(-1)?.position ?? 0)
  const curveX = (position: number) => pointX(position / positionExtent())
  const readonly = createMemo(() => currentTarget() === undefined || currentTarget()?.follow !== undefined)
  const selectedPoint = createMemo(() => {
    const index = selected()
    return index === undefined ? undefined : displayedCurve()?.points[index]
  })

  createEffect(() => {
    const context = followContext()
    setComputed(undefined)
    if (currentTarget()?.follow === undefined) {
      setComputedStatus('')
      return
    }
    if (!context) {
      setComputedStatus(appMessage('curveEditor.follow.exactRunRequired'))
      return
    }
    const controller = new AbortController()
    setComputedStatus(appMessage('curveEditor.follow.loading'))
    void context.values.peek(context.curveQuery, { signal: controller.signal }).then(async (peek) => {
      if (controller.signal.aborted) return
      const info = peek.available ? peek.renditions.find((entry) =>
        entry.kind === 'curve-points' && entry.mime === 'application/json' && entry.default === true &&
        entry.cacheKey === 'curve-points' && entry.limits?.['points'] === 4096) : undefined
      if (!peek.available || peek.descriptor.typeId !== 'dinkster.curve' || info === undefined) {
        setComputedStatus(peek.available
          ? appMessage('curveEditor.follow.renditionMissing')
          : `${peek.status} ${peek.reason}: ${peek.error}`)
        return
      }
      const rendition = await context.values.rendition(context.curveQuery, info.kind, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (!rendition.available) {
        setComputedStatus(`${rendition.status} ${rendition.reason}: ${rendition.error}`)
        return
      }
      try {
        if (rendition.typeId !== peek.descriptor.typeId || rendition.fingerprint !== peek.descriptor.fingerprint ||
          rendition.reportedKind !== info.kind || rendition.mime !== info.mime) {
          throw new Error(appMessage('curveEditor.follow.renditionMismatch'))
        }
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rendition.bytes))
        if (!isCurveValue(value)) throw new Error(appMessage('curveEditor.follow.payloadInvalid'))
        setComputed(copyCurve(value))
        setComputedStatus(appMessage('curveEditor.follow.active'))
      } catch (reason) {
        setComputedStatus(reason instanceof Error ? reason.message : String(reason))
      }
    }).catch((reason) => {
      if (!controller.signal.aborted) setComputedStatus(reason instanceof Error ? reason.message : String(reason))
    })
    onCleanup(() => controller.abort())
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

  const apply = (): void => {
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
    const outcome = props.app.dispatchTo(tab, {
      command: 'node.setValue',
      params: {
        graphId: request.graphId,
        nodeId: request.nodeId,
        inputId: request.inputId,
        value: copyCurve(value) as unknown as Json,
      },
    })
    if (!outcome.ok) {
      setError(outcome.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? 'Curve update was refused')
      return
    }
    props.app.closeCurveEditor(request)
  }

  return <section class="curve-editor" data-testid="curve-editor">
    <Show when={target()} fallback={<div class="editor-missing">No curve target is active.</div>}>
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
            <Show when={currentTarget()?.follow} fallback={<p>Double-click the graph to add a point. Drag points to adjust them.</p>}>
              <p>{appMessage('curveEditor.follow.readOnly')}</p>
            </Show>
            <p>{currentTarget()?.follow
              ? appMessage('curveEditor.follow.axis', { extent: positionExtent().toFixed(2) })
              : 'Position and value range from 0 to 1.'}</p>
            <Show when={currentTarget()?.follow}>
              <p role="status">{computedStatus()}</p>
              <p>{matchingAudioPlayhead()
                ? appMessage('curveEditor.follow.playhead', {
                    time: matchingAudioPlayhead()!.time.toFixed(2),
                    duration: matchingAudioPlayhead()!.duration.toFixed(2),
                  })
                : appMessage('curveEditor.follow.playLinkedAudio')}</p>
            </Show>
            <Show when={selectedPoint()}>{(point) => <dl class="curve-point-value" data-testid="curve-point-value">
              <div><dt>{currentTarget()?.follow ? 'Position (s)' : 'Position'}</dt><dd>{point().position.toFixed(4)}</dd></div>
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
            <Show when={(matchingAudioPlayhead()?.duration ?? 0) > 0}>
              <rect data-testid="curve-audio-playhead" x={curveX(matchingAudioPlayhead()!.time) - 1.5} y="0" width="3" height="600" fill="#8fc7ff" pointer-events="none" />
            </Show>
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
        <Show when={currentTarget() === undefined}><div class="curve-editor-error" role="alert">{appMessage('curveEditor.follow.relationUnavailable')}</div></Show>
        <Show when={error()}>{(message) => <div class="curve-editor-error" role="alert">{message()}</div>}</Show>
      </>}
    </Show>
  </section>
}
