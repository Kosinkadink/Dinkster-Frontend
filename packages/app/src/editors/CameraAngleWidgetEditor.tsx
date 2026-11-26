import { asPortId, buildRerouteIndex, companionSourcesOf, defaultValuesOf, portRefKey, type CommandInvocation } from '@dinkster/core'
import { createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { partRow, WidgetEditorController, withMaterializeFrames, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './camera-angle-widget-editor.css'

const fields = ['horizontal_angle', 'vertical_angle', 'zoom'] as const
const limits = { horizontal_angle: [0, 360], vertical_angle: [-30, 60], zoom: [0, 10] } as const

const CameraAngleImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const target = ed.target.kind === 'input' ? ed.target : undefined
  const graphId = target?.familyOwner?.graphId ?? ed.graphId
  const nodeId = target?.familyOwner?.nodeId ?? target?.nodeId
  const graph = ed.tab.store.doc.graphs[graphId]
  const node = nodeId === undefined ? undefined : graph?.nodes[nodeId]
  const resolve = props.editor.app.registryForTab(ed.tab)?.resolve
  const index = graph && buildRerouteIndex(graph)
  const schema = node && resolve?.(node.type)
  const defaults = schema && defaultValuesOf(schema)
  // Each angle is the row the widget writes under that part. A part the widget
  // does not name, or whose row has a wire, is not editable and not written.
  const rows = Object.fromEntries(fields.map((field) => [field, partRow(ed.target, field)])) as Record<typeof fields[number], string | undefined>
  const wired = (field: typeof fields[number]): boolean => {
    const key = node && rows[field] !== undefined ? portRefKey({ node: node.id, port: asPortId(rows[field]) }) : undefined
    return key !== undefined && (index?.inputDriverOf.has(key) === true || index?.netSourceOf.has(key) === true)
  }
  const editable = fields.filter((field) => rows[field] !== undefined && !wired(field))
  const sources = graph && node && companionSourcesOf(graph, index, undefined, resolve).get(node.id)
  // A wired angle shows the value its wire carries when that is a literal the
  // editor can read, and never the stored value underneath the wire.
  const linked = (field: typeof fields[number]): unknown => {
    const source = rows[field] === undefined ? undefined : sources?.get(rows[field])
    return source?.kind === 'literal' && typeof source.value === 'number' ? source.value : undefined
  }
  const values = Object.fromEntries(fields.map((field) => [field, editable.includes(field)
    ? node?.values[rows[field]!] ?? defaults?.[rows[field]!]
    : wired(field) ? linked(field) : undefined]))
  const missing = fields.filter((field) => typeof values[field] !== 'number')
  const available = editable.length > 0 && editable.every((field) => typeof values[field] === 'number')
  const [draft, setDraft] = createSignal<Record<typeof fields[number], string>>({
    horizontal_angle: String(values.horizontal_angle ?? ''),
    vertical_angle: String(values.vertical_angle ?? ''),
    zoom: String(values.zoom ?? ''),
  })
  const valid = () => available && editable.every((field) => {
    const value = Number(draft()[field])
    return draft()[field].trim() !== '' && Number.isFinite(value)
      && value >= limits[field][0] && value <= limits[field][1]
      && (field === 'zoom' || Number.isInteger(value))
  })
  const position = () => {
    const yaw = Number(draft().horizontal_angle) * Math.PI / 180
    const pitch = Number(draft().vertical_angle) * Math.PI / 180
    return { x: 6 * Math.cos(pitch) * Math.sin(yaw), y: 6 * Math.sin(pitch), z: 6 * Math.cos(pitch) * Math.cos(yaw) }
  }
  const revision = ed.tab.store.revision
  const commit = () => {
    if (!valid() || !node || !target) return
    if (ed.tab.store.revision !== revision) { props.close(); return }
    const invocations = editable.map((field) => ({ command: 'node.setValue', params: { graphId, nodeId: node.id, inputId: rows[field]!, value: Number(draft()[field]) } }))
    void props.commitCommand(withMaterializeFrames(graphId, node.id, target.materialize,
      { command: 'batch', params: { invocations } } as unknown as CommandInvocation))
  }
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover" data-testid="camera-angle-editor" role="dialog" aria-label={message('cameraAngleWidget.title')}>
    <props.header type="CAMERA_ANGLE_VIEW" />
    <Show when={valid() && fields.every((field) => draft()[field].trim() !== '')}>
      <svg class="camera-angle-preview" viewBox="0 0 300 150" role="img" aria-label={message('cameraAngleWidget.preview')}>
        <ellipse cx="90" cy="76" rx="62" ry="50" fill="none" stroke="currentColor" />
        <path d="M78 68 L90 61 L102 68 L102 84 L90 91 L78 84 Z M78 68 L90 75 L102 68 M90 75 L90 91" fill="none" stroke="currentColor" />
        <line x1="90" y1="76" x2={90 + position().x * 10} y2={76 + position().z * 8} stroke="currentColor" />
        <circle cx={90 + position().x * 10} cy={76 + position().z * 8} r="5" fill="currentColor" />
        <text x="90" y="144" text-anchor="middle">{message('cameraAngleWidget.front')}</text>
        <text x="90" y="16" text-anchor="middle">{message('cameraAngleWidget.back')}</text>
        <text x="160" y="80">{message('cameraAngleWidget.right')}</text>
        <line x1="218" y1="108" x2="288" y2="108" stroke="currentColor" />
        <line x1="226" y1="108" x2={226 + Math.cos(Number(draft().vertical_angle) * Math.PI / 180) * 54} y2={108 - position().y * 9} stroke="currentColor" />
        <circle cx={226 + Math.cos(Number(draft().vertical_angle) * Math.PI / 180) * 54} cy={108 - position().y * 9} r="5" fill="currentColor" />
        <text x="252" y="144" text-anchor="middle">{message('cameraAngleWidget.elevation')}</text>
      </svg>
      <output class="camera-angle-position">{message('cameraAngleWidget.position', { x: position().x.toFixed(2), y: position().y.toFixed(2), z: position().z.toFixed(2) })}</output>
    </Show>
    <Show when={fields.some(wired)}><ProductNotice tone="info">{message('cameraAngleWidget.connected')}</ProductNotice></Show>
    <Show when={missing.length > 0}><ProductNotice tone="info">{message('cameraAngleWidget.missing', { fields: missing.map((field) => message(`cameraAngleWidget.${field}`)).join(', ') })}</ProductNotice></Show>
    <For each={fields}>{(field) => {
      const id = `camera-angle-${field}`
      return <ProductField controlId={id} label={message(`cameraAngleWidget.${field}`)} layout="compact">
        <ProductTextInput id={id} aria-labelledby={productFieldIds(id).label} value={draft()[field]} inputmode={field === 'zoom' ? 'decimal' : 'numeric'} disabled={!editable.includes(field) || props.commitPending()}
          placeholder={wired(field) ? message('cameraAngleWidget.linked') : undefined}
          ref={(element) => { if (field === 'horizontal_angle') queueMicrotask(() => { if (element.isConnected) { element.focus(); element.select() } }) }}
          onInput={(event) => { const value = event.currentTarget.value; setDraft((previous) => ({ ...previous, [field]: value })) }} />
      </ProductField>
    }}</For>
    <Show when={available && !valid()}><ProductNotice tone="error">{message('cameraAngleWidget.invalid')}</ProductNotice></Show>
    <ProductActionFooter>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <Show when={editable.length > 0}>
        <ProductButton type="button" variant="primary" disabled={!valid() || props.commitPending()} onClick={commit}>{message('cameraAngleWidget.apply')}</ProductButton>
      </Show>
    </ProductActionFooter>
  </div>
}

export const CameraAngleWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={CameraAngleImplementation} />
