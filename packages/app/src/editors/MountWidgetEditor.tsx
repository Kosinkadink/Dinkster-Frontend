import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import type { MountSettings } from '@dinkster/client'
import { ProductButton } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import { useAppMessage } from '../locale.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'

const MountImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const initial = ed.initial === undefined ? ed.spec?.default : ed.initial
  const [selected, setSelected] = createSignal(typeof initial === 'string' ? initial : '')
  const [settings, setSettings] = createSignal(undefined as MountSettings | undefined)
  const [error, setError] = createSignal(undefined as string | undefined)
  let live = true
  onCleanup(() => { live = false })
  const backend = props.editor.app.backendForTab(ed.tab)
  if (backend.protocol === 'dinkster') {
    void backend.connection.fetchMountSettings().then((value) => {
      if (live) setSettings(value)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    })
  } else setError(message('mountWidget.error'))

  const writable = () => settings()?.mounts.filter((mount) => mount.mode === 'readwrite' && mount.state === 'ready') ?? []
  const options = () => {
    const mounts = writable().map((mount) => ({ id: mount.id, value: mount.id, label: mount.id, disabled: false }))
    if (selected() !== '' && !mounts.some((mount) => mount.id === selected())) {
      mounts.unshift({ id: selected(), value: selected(), label: message('mountWidget.unavailable', { id: selected() }), disabled: true })
    }
    return [{ id: '', value: '', label: message('mountWidget.default'), disabled: false }, ...mounts]
  }
  const canApply = () => selected() === '' || writable().some((mount) => mount.id === selected())
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover" data-testid="mount-widget-editor" data-mounts={settings() ? 'ready' : error() ? 'error' : 'loading'} role="dialog" aria-label={ed.label}>
    <props.header type="MOUNT" />
    <Show when={!settings() && !error()}><ProductNotice tone="status">{message('mountWidget.loading')}</ProductNotice></Show>
    <Show when={error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
    <ProductField controlId="mount-widget-choice" label={ed.label} layout="compact">
      <ProductSelect id="mount-widget-choice" testId="mount-widget-choice" ariaLabel={ed.label} selectedId={selected()} options={options()} onSelect={(option) => setSelected(option.value)} />
    </ProductField>
    <ProductActionFooter>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton type="button" variant="primary" data-testid="mount-widget-apply" disabled={!canApply()} onClick={() => props.commitValue(selected() === '' ? null : selected())}>{message('common.apply')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const MountWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={MountImplementation} />
