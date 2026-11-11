import { asPortId, buildRerouteIndex, defaultValuesOf, portRefKey, type CommandInvocation } from '@dinkster/core'
import { createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { WidgetEditorController, withMaterializeFrames, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
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
  const values = Object.fromEntries(fields.map((field) => {
    const key = node && portRefKey({ node: node.id, port: asPortId(field) })
    const driven = key && (index?.inputDriverOf.has(key) || index?.netSourceOf.has(key))
    return [field, driven ? undefined : node?.values[field] ?? defaults?.[field]]
  }))
  const available = fields.every((field) => typeof values[field] === 'number')
  const [draft, setDraft] = createSignal<Record<typeof fields[number], string>>({
    horizontal_angle: String(values.horizontal_angle ?? ''),
    vertical_angle: String(values.vertical_angle ?? ''),
    zoom: String(values.zoom ?? ''),
  })
  const valid = () => available && fields.every((field) => {
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
    const invocations = fields.map((inputId) => ({ command: 'node.setValue', params: { graphId, nodeId: node.id, inputId, value: Number(draft()[inputId]) } }))
    void props.commitCommand(withMaterializeFrames(graphId, node.id, target.materialize,
      { command: 'batch', params: { invocations } } as unknown as CommandInvocation))
  }
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover" data-testid="camera-angle-editor" role="dialog" aria-label={message('cameraAngleWidget.title')}>
    <props.header type="CAMERA_ANGLE_VIEW" />
    <Show when={valid()}>
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
    <Show when={!available}><ProductNotice tone="info">{message('cameraAngleWidget.connected')}</ProductNotice></Show>
    <For each={fields}>{(field) => {
      const id = `camera-angle-${field}`
      return <ProductField controlId={id} label={message(`cameraAngleWidget.${field}`)} layout="compact">
        <ProductTextInput id={id} aria-labelledby={productFieldIds(id).label} value={draft()[field]} inputmode={field === 'zoom' ? 'decimal' : 'numeric'} disabled={!available || props.commitPending()}
          ref={(element) => { if (field === 'horizontal_angle') queueMicrotask(() => { if (element.isConnected) { element.focus(); element.select() } }) }}
          onInput={(event) => { const value = event.currentTarget.value; setDraft((previous) => ({ ...previous, [field]: value })) }} />
      </ProductField>
    }}</For>
    <Show when={available && !valid()}><ProductNotice tone="error">{message('cameraAngleWidget.invalid')}</ProductNotice></Show>
    <ProductActionFooter>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton type="button" variant="primary" disabled={!valid() || props.commitPending()} onClick={commit}>{message('cameraAngleWidget.apply')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const CameraAngleWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={CameraAngleImplementation} />
