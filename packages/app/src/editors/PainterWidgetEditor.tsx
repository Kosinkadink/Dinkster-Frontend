import { isAssetRefValue } from '@dinkster/core'
import { createSignal, onCleanup, onMount, Show, type Component } from 'solid-js'
import { ProductButton, ProductColorInput, ProductFileInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice } from '../ProductForm.js'
import { ProductNumberInput } from '../ProductNumberInput.js'
import { useAppMessage } from '../locale.js'
import { activeProjectId } from '../projects.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './painter-widget-editor.css'

const PainterImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const backend = props.editor.app.backendForTab(ed.tab)
  const project = activeProjectId()
  const revision = ed.tab.store.revision
  const target = ed.target
  const node = target.kind === 'input'
    ? ed.tab.store.doc.graphs[target.familyOwner?.graphId ?? ed.graphId]?.nodes[target.familyOwner?.nodeId ?? target.nodeId]
    : undefined
  const dimension = (name: string): number => {
    const value = node?.values[name] ?? 512
    return typeof value === 'number' && Number.isSafeInteger(value) && 64 <= value && 4096 >= value ? value : 512
  }
  const width = dimension('width')
  const height = dimension('height')
  const [color, setColor] = createSignal('#ffffff')
  const [size, setSize] = createSignal(24)
  const [erase, setErase] = createSignal(false)
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal<string>()
  let canvas!: HTMLCanvasElement
  let fileInput!: HTMLInputElement
  let live = true
  let ready = false
  let point: { x: number; y: number } | undefined
  const abort = new AbortController()
  const current = (): boolean => live && !abort.signal.aborted &&
    props.editor.app.backendForTab(ed.tab).connection === backend.connection &&
    activeProjectId() === project && ed.tab.store.revision === revision
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
      ready = true
    } finally { image.close() }
  }
  onMount(() => {
    void (async () => {
      if (backend.protocol !== 'dinkster' || !canvas.getContext('2d')) throw new Error(message('painterWidget.unavailable'))
      const initial = ed.initial
      if (initial !== undefined && initial !== null && initial !== '') {
        if (!isAssetRefValue(initial)) throw new Error(message('painterWidget.unavailable'))
        const ref = initial as { digest: string; mediaType: string }
        const bytes = await backend.connection.fetchAssetBytes(ref.digest)
        requireCurrent()
        if (!bytes) throw new Error(message('painterWidget.unavailable'))
        await drawImage(new Blob([bytes], { type: ref.mediaType }))
      }
      ready = true
    })().catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (live) setBusy(false) })
  })
  const pickFile = async (file: File): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try { await drawImage(file) }
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
      if (!ready || backend.protocol !== 'dinkster') throw new Error(message('painterWidget.unavailable'))
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value
        ? resolve(value) : reject(new Error(message('painterWidget.unavailable'))), 'image/png'))
      requireCurrent()
      const ref = await backend.connection.uploadMediaAsset(new File([blob], 'painting.png', { type: 'image/png' }),
        { scope: 'local', kind: 'media/image', name: 'painting.png', signal: abort.signal })
      requireCurrent()
      props.commitValue(ref)
    } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (live) setBusy(false) }
  }

  return <div class="widget-editor painter-widget-editor" data-testid="painter-editor">
    <div class="painter-toolbar">
      <ProductField controlId="painter-color" label={message('painterWidget.color')} layout="compact">
        <ProductColorInput id="painter-color" value={color()} disabled={busy()} onInput={(event) => setColor(event.currentTarget.value)} />
      </ProductField>
      <ProductField controlId="painter-size" label={message('painterWidget.size')} layout="compact">
        <ProductNumberInput id="painter-size" value={size()} min={1} max={512} integer disabled={busy()} onCommit={(raw) => setSize(Math.max(1, Math.min(512, Number(raw) || 1)))} />
      </ProductField>
      <ProductButton disabled={busy()} aria-pressed={erase()} onClick={() => setErase(!erase())}>{message('painterWidget.erase')}</ProductButton>
      <ProductButton disabled={busy()} onClick={() => { canvas.getContext('2d')?.clearRect(0, 0, width, height); ready = true; setError(undefined) }}>{message('painterWidget.clear')}</ProductButton>
      <ProductButton disabled={busy()} onClick={() => fileInput.click()}>{message('painterWidget.choose')}</ProductButton>
      <ProductFileInput ref={fileInput} accept="image/*" onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        if (file) void pickFile(file)
        event.currentTarget.value = ''
      }} />
    </div>
    <canvas ref={canvas} width={width} height={height} class="painter-canvas" data-editor-interactive
      aria-label={message('painterWidget.canvas')} role="img" onPointerDown={stroke} onPointerMove={stroke}
      onPointerUp={(event) => { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); point = undefined }}
      onPointerCancel={() => { point = undefined }} onLostPointerCapture={() => { point = undefined }} />
    <Show when={error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
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
