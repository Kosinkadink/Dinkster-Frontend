import type { MountSettings } from '@dinkster/client'
import { inputsOf } from '@dinkster/core'
import { isSaveTarget } from '@dinkster/widgets'
import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import { useAppMessage } from '../locale.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'

const SaveTargetImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const initial = ed.initial === undefined ? ed.spec?.default : ed.initial
  const [mount, setMount] = createSignal(isSaveTarget(initial) ? initial.mount : '')
  const [prefix, setPrefix] = createSignal(isSaveTarget(initial) ? initial.prefix : '')
  const [settings, setSettings] = createSignal(undefined as MountSettings | undefined)
  const [error, setError] = createSignal(undefined as string | undefined)
  const target = ed.target.kind === 'input' ? ed.target : undefined
  const node = target && ed.tab.store.doc.graphs[target.familyOwner?.graphId ?? ed.graphId]?.nodes[target.familyOwner?.nodeId ?? target.nodeId]
  const schema = node && props.editor.app.registryForTab(ed.tab)?.resolve(node.type)
  const optional = schema && inputsOf(schema).find((input) => input.id === (target?.familyOwner?.valueKey ?? target?.valueKey))?.optional === true
  const suffix = typeof ed.spec?.options['suffix'] === 'string' ? ed.spec.options['suffix'] : ''
  let live = true
  onCleanup(() => { live = false })
  const backend = props.editor.app.backendForTab(ed.tab)
  if (backend.protocol === 'dinkster') {
    void backend.connection.fetchMountSettings().then((value) => {
      if (!live) return
      setSettings(value)
      const output = value.activeOutputMount ?? value.outputMount
      if (mount() === '' && output !== undefined) setMount(output)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    })
  } else setError(message('mountWidget.error'))
  const writable = () => settings()?.mounts.filter((entry) => entry.mode === 'readwrite' && entry.state === 'ready') ?? []
  const options = () => {
    const entries = writable().map((entry) => ({ id: entry.id, value: entry.id, label: entry.id, disabled: false }))
    if (mount() !== '' && !entries.some((entry) => entry.id === mount())) entries.unshift({ id: mount(), value: mount(), label: message('mountWidget.unavailable', { id: mount() }), disabled: true })
    return entries
  }
  const validPrefix = () => isSaveTarget({ mount: 'output', prefix: prefix() })
  const canApply = () => validPrefix() && writable().some((entry) => entry.id === mount())
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })
  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover" data-testid="save-target-editor" role="dialog" aria-label={message('saveTargetWidget.title')}>
    <props.header type="SAVE_TARGET" />
    <Show when={!settings() && !error()}><ProductNotice tone="status">{message('mountWidget.loading')}</ProductNotice></Show>
    <Show when={error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
    <Show when={settings() && writable().length === 0}><ProductNotice tone="info">{message('saveTargetWidget.noMounts')}</ProductNotice></Show>
    <ProductField controlId="save-target-mount" label={message('saveTargetWidget.mount')} layout="compact">
      <ProductSelect id="save-target-mount" ariaLabel={message('saveTargetWidget.mount')} selectedId={mount()} options={options()} disabled={!settings() || props.commitPending()} onSelect={(option) => setMount(option.value)} />
    </ProductField>
    <ProductField controlId="save-target-prefix" label={message('saveTargetWidget.prefix')} description={message('saveTargetWidget.naming', { suffix })} layout="stack">
      <ProductTextInput id="save-target-prefix" aria-labelledby={productFieldIds('save-target-prefix').label} aria-describedby={productFieldIds('save-target-prefix').description} value={prefix()} disabled={props.commitPending()} onInput={(event) => setPrefix(event.currentTarget.value)} />
    </ProductField>
    <Show when={!validPrefix()}><ProductNotice tone="error">{message('saveTargetWidget.invalid')}</ProductNotice></Show>
    <ProductActionFooter>
      <ProductButton type="button" disabled={props.commitPending()} onClick={props.close}>{message('common.cancel')}</ProductButton>
      <Show when={optional}><ProductButton type="button" disabled={props.commitPending()} onClick={() => props.commitValue(null)}>{message('saveTargetWidget.clear')}</ProductButton></Show>
      <ProductButton type="button" variant="primary" disabled={!canApply() || props.commitPending()} onClick={() => props.commitValue({ mount: mount(), prefix: prefix() })}>{message('saveTargetWidget.apply')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const SaveTargetWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={SaveTargetImplementation} />
