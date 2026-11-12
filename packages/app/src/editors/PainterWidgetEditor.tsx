import { defaultRenditionOf } from '@dinkster/client'
import { asNodeId, asPortId, buildRerouteIndex, companionSourcesOf, isAssetRefValue, occurrencesForView, portRefKey } from '@dinkster/core'
import { createSignal, onCleanup, onMount, Show, type Component } from 'solid-js'
import { viewInstancePath } from '../app-state.js'
import { liveExactnessFor } from '../companion-display.js'
import { ProductButton, ProductColorInput, ProductFileInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice } from '../ProductForm.js'
import { ProductNumberInput } from '../ProductNumberInput.js'
import { useAppMessage } from '../locale.js'
import { activeProjectId } from '../projects.js'
import { UploadDestination } from '../UploadDestination.js'
import { readUploadDestination, saveUploadDestination } from '../upload-destination.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './painter-widget-editor.css'

const PainterImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const backend = props.editor.app.backendForTab(ed.tab)
  const project = activeProjectId()
  const [destination, setDestination] = createSignal(readUploadDestination(String(backend.id), project))
  const revision = ed.tab.store.revision
  const target = ed.target
  const graphId = target.kind === 'input' ? target.familyOwner?.graphId ?? ed.graphId : ed.graphId
  const graph = ed.tab.store.doc.graphs[graphId]
  const node = target.kind === 'input'
    ? graph?.nodes[target.familyOwner?.nodeId ?? target.nodeId]
    : undefined
  const dimension = (name: string): number => {
    const value = node?.values[name] ?? 512
    return typeof value === 'number' && Number.isSafeInteger(value) && 64 <= value && 4096 >= value ? value : 512
  }
  let width = dimension('width')
  let height = dimension('height')
  const [color, setColor] = createSignal('#ffffff')
  const [size, setSize] = createSignal(24)
  const [erase, setErase] = createSignal(false)
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal<string>()
  let base!: HTMLCanvasElement
  let canvas!: HTMLCanvasElement
  let fileInput!: HTMLInputElement
  let live = true
  let baseReady = false
  let ready = false
  let sourceCurrent = (): boolean => true
  let point: { x: number; y: number } | undefined
  const abort = new AbortController()
  const current = (): boolean => live && !abort.signal.aborted &&
    props.editor.app.backendForTab(ed.tab).connection === backend.connection &&
    activeProjectId() === project && ed.tab.store.revision === revision && sourceCurrent()
  const requireCurrent = (): void => {
    if (!current()) throw new Error(message('painterWidget.stale'))
  }
  onCleanup(() => { live = false; abort.abort() })
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })

  const drawImage = async (blob: Blob): Promise<void> => {
    const image = await createImageBitmap(blob)
    try {
      requireCurrent()
      const context = canvas.getContext('2d')
      if (!context) throw new Error(message('painterWidget.unavailable'))
      context.clearRect(0, 0, width, height)
      context.drawImage(image, 0, 0, width, height)
      ready = baseReady
    } finally { image.close() }
  }
  onMount(() => {
    void (async () => {
      if (backend.protocol !== 'dinkster' || !canvas.getContext('2d')) throw new Error(message('painterWidget.unavailable'))
      const sources = graph && node && companionSourcesOf(graph, undefined, undefined,
        props.editor.app.registryForTab?.(ed.tab)?.resolve).get(node.id)
      const imageSource = sources?.get('image')
      const colorSource = sources?.get('bg_color')
      if (graph && node) {
        const index = buildRerouteIndex(graph)
        for (const input of ['image', 'bg_color']) {
          const key = portRefKey({ node: node.id, port: asPortId(input) })
          if ((index.inputDriverOf.has(key) || index.netSourceOf.has(key)) && !sources?.has(input)) {
            throw new Error(message('painterWidget.sourceUnavailable'))
          }
        }
      }
      const source = imageSource ?? (colorSource?.kind === 'producer' ? colorSource : undefined)
      let background = colorSource?.kind === 'literal' ? colorSource.value : node?.values.bg_color ?? '#000000'
      if (source !== undefined) {
        const unavailable = (): Error => { return new Error(message('painterWidget.sourceUnavailable')) }
        if (source.kind !== 'producer') throw unavailable()
        const execution = props.editor.app.executionForTab(ed.tab)
        const compiled = props.editor.app.compileTabCached(ed.tab)
        const path = viewInstancePath(ed.tab)
        const ownerDepth = ed.tab.graphStack.get().lastIndexOf(graphId)
        if (!execution || execution.status !== 'completed' || !execution.artifact || !compiled?.ok || !path || ownerDepth < 0
          || execution.ref.connection !== backend.id || compiled.artifact.connection !== backend.id
          || execution.artifact.snapshot.lineage !== ed.tab.store.doc.lineage) throw unavailable()
        const runtimeIds = occurrencesForView({ instancePath: path.slice(0, ownerDepth),
          runtimeIds: new Set([...Object.keys(execution.nodes), ...Object.keys(execution.outputs)]),
          toSource: execution.artifact.provenance.toSource }).own.get(asNodeId(source.node)) ?? []
        const runtimeId = runtimeIds.length === 1 ? runtimeIds[0] : undefined
        if (!runtimeId || liveExactnessFor(compiled.artifact, execution.artifact)?.(runtimeId) !== true) throw unavailable()
        sourceCurrent = () => {
          const navigation = viewInstancePath(ed.tab)
          const fresh = props.editor.app.compileTabCached(ed.tab)
          return props.editor.app.executionForTab(ed.tab)?.key === execution.key && fresh?.ok === true
            && fresh.artifact.schemaHash === compiled.artifact.schemaHash && navigation?.length === path.length
            && navigation.every((id, index) => id === path[index])
        }
        const outputId = execution.artifact.provenance.outputAliases?.[runtimeId]?.[source.output] ?? source.output
        const values = backend.connection.values()
        const query = { jobId: execution.ref.prompt, nodeId: runtimeId, outputId }
        const peek = await values.peek(query, { signal: abort.signal })
        if (!peek.available) throw unavailable()
        if (imageSource === undefined) {
          if (peek.descriptor.typeId !== 'COLOR' || typeof peek.descriptor.value !== 'string') throw unavailable()
          background = peek.descriptor.value
        } else {
        if (peek.descriptor.typeId !== 'IMAGE') throw unavailable()
        const rendition = defaultRenditionOf(peek.renditions.filter((entry) => entry.mime === 'image/png'))
        if (!rendition) throw unavailable()
        // The native IMAGE PNG renderer defaults to the first frame, as does Painter.
        await values.read(query, peek.descriptor, async () => {
          requireCurrent()
          const result = await values.rendition(query, rendition.kind, { signal: abort.signal, descriptor: peek.descriptor,
            ...(rendition.parameters?.includes('batch') ? { batch: 0 } : {}),
            ...(rendition.version === undefined ? {} : { rendererVersion: rendition.version }) })
          requireCurrent()
          if (!result?.available || result.mime !== 'image/png' || result.bytes.byteLength > 64 * 1024 * 1024) throw unavailable()
          const bitmap = await createImageBitmap(new Blob([result.bytes], { type: result.mime }))
          try {
            // Native decode may outlive the connection; re-enter admission before drawing.
            await values.read(query, peek.descriptor, async () => {
              requireCurrent()
              if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4096 || bitmap.height > 4096) throw unavailable()
              width = bitmap.width; height = bitmap.height
              base.width = canvas.width = width; base.height = canvas.height = height
              base.getContext('2d')!.drawImage(bitmap, 0, 0)
            })
          } finally { bitmap.close() }
        })
        }
      }
      if (imageSource === undefined) {
        const context = base.getContext('2d')!
        context.fillStyle = typeof background === 'string' ? background : '#000000'
        context.fillRect(0, 0, width, height)
      }
      baseReady = true
      const initial = ed.initial
      if (initial !== undefined && initial !== null && initial !== '') {
        const ref = typeof initial === 'object' && !Array.isArray(initial) ? initial as Record<string, unknown> : undefined
        const local = ref?.verification === 'unverified' && typeof ref.localBinding === 'string' && ref.localBinding !== '' && !('digest' in ref)
          && typeof ref.name === 'string' && typeof ref.mediaType === 'string' && typeof ref.virtualPath === 'string'
          && typeof ref.size === 'number' && Number.isSafeInteger(ref.size) && ref.size >= 0
        if (!ref || !(local || isAssetRefValue(initial))) throw new Error(message('painterWidget.unavailable'))
        const load = async () => {
          requireCurrent()
          const bytes = local
            ? await backend.connection.fetchLocalAssetBytes(ref.localBinding as string, abort.signal)
            : await backend.connection.fetchAssetBytes(ref.digest as string, abort.signal)
          requireCurrent()
          if (!bytes) throw new Error(message('painterWidget.unavailable'))
          await drawImage(new Blob([bytes], { type: ref.mediaType as string }))
        }
        if (local) await load()
        else {
          const reader = props.editor.app.workflowAssetReader(ed.tab, ref.digest as string, abort.signal)
          if (!reader) throw new Error(message('painterWidget.unavailable'))
          const connectedCurrent = sourceCurrent
          sourceCurrent = () => connectedCurrent() && reader.current()
          await reader.read(load)
        }
      }
      ready = true
    })().catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (live) setBusy(false) })
  })
  const pickFile = async (file: File): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      if (!baseReady) throw new Error(message('painterWidget.sourceUnavailable'))
      await drawImage(file)
    }
    catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (live) setBusy(false) }
  }
  const stroke = (event: PointerEvent): void => {
    if (!ready || busy() || !current()) return
    if (event.type === 'pointerdown') {
      if (event.button !== 0) return
      canvas.setPointerCapture(event.pointerId)
      point = undefined
    } else if (!canvas.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    const bounds = canvas.getBoundingClientRect()
    const next = { x: (event.clientX - bounds.left) * width / bounds.width, y: (event.clientY - bounds.top) * height / bounds.height }
    const context = canvas.getContext('2d')!
    context.globalCompositeOperation = erase() ? 'destination-out' : 'source-over'
    context.strokeStyle = color()
    context.fillStyle = color()
    context.lineWidth = size()
    context.lineCap = 'round'
    if (point) {
      context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(next.x, next.y); context.stroke()
    } else {
      context.beginPath(); context.arc(next.x, next.y, size() / 2, 0, Math.PI * 2); context.fill()
    }
    context.globalCompositeOperation = 'source-over'
    point = next
  }
  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      requireCurrent()
      if (!baseReady) throw new Error(message('painterWidget.sourceUnavailable'))
      if (!ready || backend.protocol !== 'dinkster') throw new Error(message('painterWidget.unavailable'))
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value
        ? resolve(value) : reject(new Error(message('painterWidget.unavailable'))), 'image/png'))
      requireCurrent()
      const choice = destination()
      const ref = await backend.connection.uploadMediaAsset(new File([blob], 'painting.png', { type: 'image/png' }),
        { scope: 'local', kind: 'media/image', name: 'painting.png', signal: abort.signal,
          ...(choice.mount ? { mount: choice.mount } : {}), ...(choice.folder ? { folder: choice.folder } : {}) })
      requireCurrent()
      try { saveUploadDestination(String(backend.id), project, choice) } catch { /* Storage failure does not discard a successful upload. */ }
      props.commitValue(ref)
    } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (live) setBusy(false) }
  }

  return <div class="widget-editor painter-widget-editor" data-testid="painter-editor">
    <div class="painter-content">
    <div class="painter-toolbar">
      <ProductField controlId="painter-color" label={message('painterWidget.color')} layout="compact">
        <ProductColorInput id="painter-color" value={color()} disabled={busy()} onInput={(event) => setColor(event.currentTarget.value)} />
      </ProductField>
      <ProductField controlId="painter-size" label={message('painterWidget.size')} layout="compact">
        <ProductNumberInput id="painter-size" value={size()} min={1} max={512} integer disabled={busy()} onCommit={(raw) => setSize(Math.max(1, Math.min(512, Number(raw) || 1)))} />
      </ProductField>
      <ProductButton disabled={busy()} aria-pressed={erase()} onClick={() => setErase(!erase())}>{message('painterWidget.erase')}</ProductButton>
      <ProductButton disabled={busy()} onClick={() => { canvas.getContext('2d')?.clearRect(0, 0, width, height); ready = baseReady; if (baseReady) setError(undefined) }}>{message('painterWidget.clear')}</ProductButton>
      <ProductButton disabled={busy()} onClick={() => fileInput.click()}>{message('painterWidget.choose')}</ProductButton>
      <ProductFileInput ref={fileInput} accept="image/*" onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        if (file) void pickFile(file)
        event.currentTarget.value = ''
      }} />
    </div>
    <div class="painter-stage">
    <canvas ref={base} width={width} height={height} class="painter-base" aria-hidden="true" />
    <canvas ref={canvas} width={width} height={height} class="painter-canvas" data-editor-interactive
      aria-label={message('painterWidget.canvas')} role="img" onPointerDown={stroke} onPointerMove={stroke}
      onPointerUp={(event) => { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); point = undefined }}
      onPointerCancel={() => { point = undefined }} onLostPointerCapture={() => { point = undefined }} />
    </div>
    <UploadDestination connection={backend.connection} machine={backend.label} value={destination()} disabled={busy()} onChange={setDestination} />
    <Show when={error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
    </div>
    <ProductActionFooter>
      <ProductButton onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton variant="primary" disabled={busy()} loading={busy()} onClick={() => void apply()}>{message('common.apply')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const PainterWidgetEditor: Component<WidgetEditorProps> = (props) => {
  const message = useAppMessage()
  return <WidgetEditorController {...props} implementation={PainterImplementation}
    modal={{ type: 'PAINTER', help: <>{message('painterWidget.help')}</> }} />
}
