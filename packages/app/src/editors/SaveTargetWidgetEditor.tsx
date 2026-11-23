import type { MountSettings } from '@dinkster/client'
import { inputsOf } from '@dinkster/core'
import { isSaveTarget } from '@dinkster/widgets'
import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
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
  const load = (): void => {
    setError(undefined)
    if (backend.protocol !== 'dinkster') { setError(message('mountWidget.error')); return }
    void backend.connection.fetchMountSettings().then((value) => {
      if (!live) return
      setSettings(value)
      const output = value.activeOutputMount ?? value.outputMount
      if (mount() === '' && output !== undefined) setMount(output)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  load()
  const writable = () => settings()?.mounts.filter((entry) => entry.mode === 'readwrite' && entry.state === 'ready') ?? []
  const options = () => {
    const entries = writable().map((entry) => ({ id: entry.id, value: entry.id, label: entry.id, disabled: false }))
    if (mount() !== '' && !entries.some((entry) => entry.id === mount())) entries.unshift({ id: mount(), value: mount(), label: message('mountWidget.unavailable', { id: mount() }), disabled: true })
    return entries
  }
  // Clearing is a draft like any other: Apply stores the empty destination,
  // which differs from an unset one.
  const [cleared, setCleared] = createSignal(false)
  const validPrefix = () => isSaveTarget({ mount: 'output', prefix: prefix() })
  const canApply = () => validPrefix() && writable().some((entry) => entry.id === mount())
  const changed = () => cleared() ? initial !== null
    : !isSaveTarget(initial) || initial.mount !== mount() || initial.prefix !== prefix()
  props.bindFrame({
    phase: () => error() !== undefined ? 'unavailable' : !settings() ? 'loading'
      : cleared() ? (changed() ? 'changed' : 'unchanged') : !canApply() ? 'invalid' : changed() ? 'changed' : 'unchanged',
    unavailable: error,
    retry: load,
    apply: () => props.commitValue(cleared() ? null : { mount: mount(), prefix: prefix() }),
  })
  return <div class="widget-frame-body" data-testid="save-target-editor" data-editor-surface="frame">
    <Show when={optional}><div class="dinkster-editor-frame-toolbar">
      <ProductButton type="button" disabled={cleared()} onClick={() => setCleared(true)}>{message('saveTargetWidget.clear')}</ProductButton>
    </div></Show>
    <div class="widget-frame-scroll widget-frame-form">
      <Show when={cleared()}><ProductNotice tone="info">{message('saveTargetWidget.cleared')}</ProductNotice></Show>
      <Show when={settings() && writable().length === 0}><ProductNotice tone="info">{message('saveTargetWidget.noMounts')}</ProductNotice></Show>
      <ProductField controlId="save-target-mount" label={message('saveTargetWidget.mount')} layout="compact">
        <ProductSelect id="save-target-mount" ariaLabel={message('saveTargetWidget.mount')} selectedId={mount()} options={options()} disabled={!settings()} onSelect={(option) => { setCleared(false); setMount(option.value) }} />
      </ProductField>
      <ProductField controlId="save-target-prefix" label={message('saveTargetWidget.prefix')} description={message('saveTargetWidget.naming', { suffix })} layout="stack">
        <ProductTextInput id="save-target-prefix" aria-labelledby={productFieldIds('save-target-prefix').label} aria-describedby={productFieldIds('save-target-prefix').description} value={prefix()} onInput={(event) => { setCleared(false); setPrefix(event.currentTarget.value) }} />
      </ProductField>
      <Show when={!cleared() && !validPrefix()}><ProductNotice tone="error">{message('saveTargetWidget.invalid')}</ProductNotice></Show>
    </div>
  </div>
}

export const SaveTargetWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={SaveTargetImplementation} modal={{ form: true, type: 'SAVE_TARGET' }} />
