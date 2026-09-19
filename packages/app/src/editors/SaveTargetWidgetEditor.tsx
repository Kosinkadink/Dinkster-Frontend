import { isSaveTarget, saveTargetIssues, saveTargetPresentation } from '@dinkster/widgets'
import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import {
  WidgetEditorController,
  type WidgetEditorImplementationProps,
  type WidgetEditorProps,
} from '../WidgetEditorController.js'

type MountState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly mounts: readonly string[] }
  | { readonly state: 'error'; readonly message: string }

const SaveTargetImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const initial = isSaveTarget(ed.initial) ? ed.initial : isSaveTarget(ed.spec?.default) ? ed.spec.default : undefined
  const [mounts, setMounts] = createSignal<MountState>({ state: 'loading' })
  const [mount, setMount] = createSignal(initial?.mount ?? '')
  const [prefix, setPrefix] = createSignal(initial?.prefix ?? '')
  const [error, setError] = createSignal<string | undefined>()
  const fieldIds = productFieldIds('save-target-prefix')
  const presentation = saveTargetPresentation(ed.spec!, ed.declaredType)
  let edited = false
  let live = true
  onCleanup(() => { live = false })

  props.editor.app.backendForTab(ed.tab).scopedClient.query('/api/mounts', {}, { refresh: true }).then((result) => {
    if (!live) return
    const rows = (result as { mounts?: unknown } | null)?.mounts
    if (!Array.isArray(rows)) throw new Error('/api/mounts did not return a mount list')
    const eligible = rows
      .filter((row): row is { id: unknown; mode?: unknown; state?: unknown } => typeof row === 'object' && row !== null)
      .filter((row) => row.mode === 'readwrite' && row.state === 'ready')
      .map((row) => String(row.id))
    setMounts({ state: 'ready', mounts: eligible })
    if (mount() === '' && eligible.length > 0) setMount(eligible[0]!)
  }).catch((reason: unknown) => {
    if (live) setMounts({ state: 'error', message: reason instanceof Error ? reason.message : String(reason) })
  })

  const options = (): readonly { id: string; unavailable: boolean }[] => {
    const state = mounts()
    if (state.state !== 'ready') return []
    const values = state.mounts.map((id) => ({ id, unavailable: false }))
    if (mount() !== '' && !state.mounts.includes(mount())) values.unshift({ id: mount(), unavailable: true })
    return values
  }
  const candidate = () => ({ mount: mount(), prefix: prefix().trim() })
  const commit = (): void => {
    const value = candidate()
    const issues = saveTargetIssues(value)
    if (issues.length > 0) {
      setError(issues.join('; '))
      return
    }
    props.commitValue(value)
  }
  const clickAway = (): void => {
    const value = candidate()
    if (!edited || (initial !== undefined && value.mount === initial.mount && value.prefix === initial.prefix) || saveTargetIssues(value).length > 0) {
      props.close()
      return
    }
    props.commitValue(value)
  }
  props.editor.bindClickAway?.(clickAway)
  onCleanup(() => props.editor.bindClickAway?.(undefined))

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover save-target-editor" data-testid="save-target-editor" data-mounts={mounts().state} data-editor-surface="popover" role="dialog" aria-label={`Edit ${ed.label} SAVE_TARGET`} style={props.popoverStyle}>
    <props.header type={presentation.canonicalType} />
    <dl class="widget-editor-meta save-target-metadata" aria-label="Save target output metadata"><dt>Output format</dt><dd data-testid="save-target-output-format">{presentation.outputFormat}</dd></dl>
    <Show when={mounts().state === 'loading'}><ProductNotice tone="status">loading mounts...</ProductNotice></Show>
    <Show when={mounts().state === 'error'}><ProductNotice tone="error" testId="save-target-mounts-error">mount list failed to load</ProductNotice></Show>
    <Show when={mounts().state === 'ready' && options().length === 0}><ProductNotice tone="status" testId="save-target-no-mounts">no writable mounts available</ProductNotice></Show>
    <ProductField controlId="save-target-mount-control" label="Mount" layout="compact">
      <ProductSelect id="save-target-mount-control" testId="save-target-mount" ariaLabel="Mount" disabled={mounts().state !== 'ready' || options().length === 0} selectedId={mount()} options={options().map((option) => ({ id: option.id, label: option.unavailable ? `${option.id} (unavailable)` : option.id, value: option.id }))} onSelect={(option) => { edited = true; setMount(option.value); setError(undefined) }} />
    </ProductField>
    <ProductField controlId="save-target-prefix" label="Prefix" layout="compact" message={error()} messageTestId="save-target-error" invalid={error() !== undefined}>
      <span class="save-target-prefix-row">
        <input id="save-target-prefix" data-testid="save-target-prefix" aria-labelledby={fieldIds.label} aria-describedby={error() === undefined ? undefined : fieldIds.message} aria-invalid={error() === undefined ? undefined : 'true'} ref={(el) => queueMicrotask(() => el.focus())} value={prefix()} onInput={(event) => { edited = true; setPrefix(event.currentTarget.value); setError(undefined) }} onKeyDown={(event) => { if (event.key === 'Enter') { if (event.isComposing) return; event.preventDefault(); commit() } }} />
        <Show when={typeof ed.spec?.options['suffix'] === 'string' && ed.spec.options['suffix'] !== ''}><span class="save-target-suffix" data-testid="save-target-suffix">{ed.spec!.options['suffix'] as string}</span></Show>
      </span>
    </ProductField>
    <ProductActionFooter>
      <button type="button" data-testid="save-target-save" disabled={mounts().state !== 'ready'} onClick={commit}>save</button>
      <button type="button" onClick={() => props.commitValue(null)}>clear</button>
      <button type="button" onClick={props.close}>cancel</button>
    </ProductActionFooter>
  </div>
}

export const SaveTargetWidgetEditor: Component<WidgetEditorProps> = (props) => (
  <WidgetEditorController {...props} implementation={SaveTargetImplementation} />
)
