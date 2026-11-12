import { asPortId, buildRerouteIndex, defaultValuesOf, inputsOf, normalizedComboOptions, portRefKey, type CommandInvocation } from '@dinkster/core'
import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import { useAppMessage } from '../locale.js'
import { WidgetEditorController, withMaterializeFrames, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './resolution-widget-editor.css'

const ResolutionImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const message = useAppMessage()
  const target = ed.target.kind === 'input' ? ed.target : undefined
  const graphId = target?.familyOwner?.graphId ?? ed.graphId
  const nodeId = target?.familyOwner?.nodeId ?? target?.nodeId
  const graph = ed.tab.store.doc.graphs[graphId]
  const node = nodeId === undefined ? undefined : graph?.nodes[nodeId]
  const schema = node && props.editor.app.registryForTab(ed.tab)?.resolve(node.type)
  const defaults = schema && defaultValuesOf(schema)
  const index = graph && buildRerouteIndex(graph)
  const ratioId = String(ed.spec?.options['ratio_widget'] ?? 'aspect_ratio')
  const megapixelsId = String(ed.spec?.options['megapixels_widget'] ?? 'megapixels')
  const multipleId = String(ed.spec?.options['multiple_widget'] ?? 'multiple')
  const fields = [ratioId, megapixelsId, multipleId]
  const available = node !== undefined && fields.every((id) => {
    const key = portRefKey({ node: node.id, port: asPortId(id) })
    return !index?.inputDriverOf.has(key) && !index?.netSourceOf.has(key)
  })
  const options = schema && inputsOf(schema).find((input) => input.id === ratioId)?.widget
  const ratios = (options ? normalizedComboOptions(options) : []).map((option) => ({ id: String(option.value), value: String(option.value), label: option.label }))
  const [ratio, setRatio] = createSignal(String(node?.values[ratioId] ?? defaults?.[ratioId] ?? ''))
  const [megapixels, setMegapixels] = createSignal(String(node?.values[megapixelsId] ?? defaults?.[megapixelsId] ?? ''))
  const [multiple, setMultiple] = createSignal(String(node?.values[multipleId] ?? defaults?.[multipleId] ?? ''))
  const dimensions = () => {
    const match = /^(\d+):(\d+)(?:\s|$)/u.exec(ratio())
    const mp = Number(megapixels()), step = Number(multiple())
    if (!available || !match || !ratios.some((option) => { return option.id === ratio() }) || megapixels().trim() === '' || multiple().trim() === ''
      || !Number.isFinite(mp) || mp < 0.1 || 16 < mp || !Number.isInteger(step) || step < 8 || 128 < step) return undefined
    const width = Number(match[1]), height = Number(match[2])
    if (width <= 0 || height <= 0) return undefined
    const scale = Math.sqrt(mp * 1024 * 1024 / (width * height))
    // Python round uses ties-to-even, unlike Math.round's upward half ties.
    const rounded = (value: number) => {
      const floor = Math.floor(value), fraction = value - floor
      return (fraction === 0.5 ? floor + floor % 2 : Math.round(value)) * step
    }
    return { width: rounded(width * scale / step), height: rounded(height * scale / step) }
  }
  const revision = ed.tab.store.revision
  const commit = () => {
    if (!dimensions() || !node || !target) return
    if (ed.tab.store.revision !== revision) { props.close(); return }
    const invocations = [[ratioId, ratio()], [megapixelsId, Number(megapixels())], [multipleId, Number(multiple())]].map(([inputId, value]) => ({
      command: 'node.setValue', params: { graphId, nodeId: node.id, inputId, value },
    }))
    void props.commitCommand(withMaterializeFrames(graphId, node.id, target.materialize,
      { command: 'batch', params: { invocations } } as unknown as CommandInvocation))
  }
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })
  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover" data-testid="resolution-editor" role="dialog" aria-label={message('resolutionWidget.title')}>
    <props.header type="RESOLUTION_PREVIEW" />
    <Show when={dimensions()}>{(size) => <>
      <div class="resolution-preview" role="img" aria-label={message('resolutionWidget.dimensions', size())}>
        <svg class="resolution-preview-frame" viewBox={`-2 -2 ${size().width + 4} ${size().height + 4}`} aria-hidden="true">
          <rect width={size().width} height={size().height} vector-effect="non-scaling-stroke" />
        </svg>
      </div>
      <output class="resolution-preview-output">{message('resolutionWidget.dimensions', size())}</output>
    </>}</Show>
    <Show when={!available}><ProductNotice tone="info">{message('resolutionWidget.connected')}</ProductNotice></Show>
    <ProductField controlId="resolution-ratio" label={message('resolutionWidget.ratio')} layout="compact">
      <ProductSelect id="resolution-ratio" ariaLabel={message('resolutionWidget.ratio')} selectedId={ratio()} options={ratios} disabled={!available || props.commitPending()} onSelect={(option) => setRatio(option.value)} />
    </ProductField>
    <ProductField controlId="resolution-megapixels" label={message('resolutionWidget.megapixels')} layout="compact">
      <ProductTextInput id="resolution-megapixels" aria-labelledby={productFieldIds('resolution-megapixels').label} inputmode="decimal" value={megapixels()} disabled={!available || props.commitPending()} onInput={(event) => setMegapixels(event.currentTarget.value)} />
    </ProductField>
    <ProductField controlId="resolution-multiple" label={message('resolutionWidget.multiple')} layout="compact">
      <ProductTextInput id="resolution-multiple" aria-labelledby={productFieldIds('resolution-multiple').label} inputmode="numeric" value={multiple()} disabled={!available || props.commitPending()} onInput={(event) => setMultiple(event.currentTarget.value)} />
    </ProductField>
    <Show when={available && !dimensions()}><ProductNotice tone="error">{message('resolutionWidget.invalid')}</ProductNotice></Show>
    <ProductActionFooter>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton type="button" variant="primary" disabled={!dimensions() || props.commitPending()} onClick={commit}>{message('resolutionWidget.apply')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const ResolutionWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={ResolutionImplementation} />
