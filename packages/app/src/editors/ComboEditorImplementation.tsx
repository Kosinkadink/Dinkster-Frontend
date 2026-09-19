import type { CommandInvocation, WidgetSpec } from '@dinkster/core'
import { Check, ChevronLeft, ChevronRight, Folder, X } from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import { comboOptions, remoteComboRefreshCanAdvance } from '../app-view-rows.js'
import { clampComboHighlight, comboMenuEntries, comboRenderWindow, scrollComboHighlightIntoView, type ComboHighlightSource, type ComboOption, type ComboRenderWindow } from '../combo-search.js'
import { Icon } from '../Icon.js'
import { useAppMessage } from '../locale.js'
import { ProductActionFooter, ProductField, ProductNotice } from '../ProductForm.js'
import { withMaterializeFrames, type WidgetEditorImplementationProps } from '../WidgetEditorController.js'

interface RemoteSource {
  readonly client: ReturnType<WidgetEditorImplementationProps['editor']['app']['backendForTab']>['scopedClient']
  readonly route: string
  readonly authority: number
}
type RemoteState =
  | { readonly state: 'loading'; readonly source: RemoteSource }
  | { readonly state: 'ready' | 'stale'; readonly source: RemoteSource; readonly options: readonly ComboOption[]; readonly message?: string }
  | { readonly state: 'unavailable'; readonly source: RemoteSource; readonly message: string }

export const createComboImplementation = (multi: boolean): Component<WidgetEditorImplementationProps> => (props) => {
  const ed = props.editor.ed
  const spec = ed.spec!
  const message = useAppMessage()
  const [query, setQuery] = createSignal('')
  const [index, setIndex] = createSignal(0)
  const [folder, setFolder] = createSignal<readonly string[]>([])
  const [values, setValues] = createSignal<string[]>(multi && Array.isArray(ed.initial) && ed.initial.every((value) => typeof value === 'string') ? [...ed.initial] : [])
  let draftGeneration = 0
  const mutateValues = (update: (current: string[]) => string[]) => { draftGeneration += 1; setValues(update) }
  let highlightSource: ComboHighlightSource = 'programmatic'
  let root: HTMLDivElement | undefined
  let live = true
  let requestToken = 0
  let requestAbort: AbortController | undefined
  const [remoteState, setRemoteState] = createSignal<RemoteState>()
  const tick = spec.remote === undefined ? undefined : props.editor.app.backendsTick
  const [backendTick, setBackendTick] = createSignal(tick?.get() ?? 0)
  const unsubscribe = tick?.subscribe(setBackendTick)
  onCleanup(() => { live = false; requestAbort?.abort(); unsubscribe?.(); props.editor.bindClickAway?.(undefined) })

  const remote = (): RemoteState | undefined => {
    backendTick()
    const state = remoteState()
    if (!state || !spec.remote) return undefined
    const client = props.editor.app.backendForTab(ed.tab).scopedClient
    return state.source.client === client && state.source.route === spec.remote.route && state.source.authority === client.remoteChoiceAuthority() ? state : undefined
  }
  const availableOptions = (): readonly ComboOption[] => {
    const state = remote()
    const available = state?.state === 'ready' || state?.state === 'stale' ? state.options : comboOptions(spec)
    if (!spec.remote || typeof ed.initial !== 'string' || available.some((option) => option.value === ed.initial)) return available
    return [{ value: ed.initial, label: ed.initial }, ...available]
  }
  const load = (refresh = false): void => {
    const sourceSpec = spec.remote
    if (!sourceSpec) return
    const token = ++requestToken
    requestAbort?.abort()
    const abort = new AbortController()
    requestAbort = abort
    const previous = remote()
    const control = refresh ? sourceSpec.controlAfterRefresh : undefined
    const plan = control === undefined && remoteComboRefreshCanAdvance(refresh, previous?.state)
      ? props.editor.app.prepareComboRefresh(ed.tab, sourceSpec.route) : undefined
    const target = control !== undefined && ed.target.kind === 'input' ? {
      graphId: ed.target.familyOwner?.graphId ?? ed.graphId,
      nodeId: ed.target.familyOwner?.nodeId ?? ed.target.nodeId,
      inputId: ed.target.familyOwner?.valueKey ?? ed.target.valueKey,
    } : undefined
    const expected = target ? ed.tab.store.doc.graphs[target.graphId]?.nodes[target.nodeId]?.values[target.inputId] : undefined
    const generation = target ? props.editor.app.widgetValueMutationGeneration(ed.tab, target.graphId, target.nodeId, target.inputId) : undefined
    const expectedDraft = multi && control !== undefined ? draftGeneration : undefined
    const client = plan?.backend.scopedClient ?? props.editor.app.backendForTab(ed.tab).scopedClient
    const source = { client, route: sourceSpec.route, authority: client.remoteChoiceAuthority() }
    if (!refresh || (previous?.state !== 'ready' && previous?.state !== 'stale')) setRemoteState({ state: 'loading', source })
    client.remoteChoices(sourceSpec.route, { refresh, signal: abort.signal, ...(sourceSpec.timeoutMs === undefined ? {} : { timeoutMs: sourceSpec.timeoutMs }), ...(sourceSpec.maxRetries === undefined ? {} : { maxRetries: sourceSpec.maxRetries }), ...(sourceSpec.refreshMs === undefined ? {} : { refreshMs: sourceSpec.refreshMs }) })
      .then((result) => {
        if (!live || token !== requestToken || client.remoteChoiceAuthority() !== source.authority) return
        const options = result.map((value) => ({ value, label: value }))
        setRemoteState({ state: 'ready', source, options })
        if (control !== undefined && target && result.length > 0) {
          const current = ed.tab.store.doc.graphs[target.graphId]?.nodes[target.nodeId]?.values[target.inputId]
          const currentGeneration = props.editor.app.widgetValueMutationGeneration(ed.tab, target.graphId, target.nodeId, target.inputId)
          if (current === expected && currentGeneration === generation && (expectedDraft === undefined || expectedDraft === draftGeneration)) {
            const selected = control === 'first' ? result[0]! : result[result.length - 1]!
            props.editor.app.dispatchTo(ed.tab, withMaterializeFrames(target.graphId, target.nodeId, ed.target.kind === 'input' ? ed.target.materialize : undefined, { command: 'node.setValue', params: { ...target, value: multi ? [selected] : selected } }))
            if (multi) props.close()
          }
        } else if (refresh) props.editor.app.completeComboRefresh(plan, result)
      })
      .catch((error: unknown) => {
        if (!live || token !== requestToken) return
        const detail = error instanceof Error ? error.message : String(error)
        setRemoteState(previous?.state === 'ready' || previous?.state === 'stale' ? { state: 'stale', source, options: previous.options, message: detail } : { state: 'unavailable', source, message: detail })
      })
  }
  if (spec.remote) load()

  const entries = createMemo(() => comboMenuEntries(availableOptions(), folder(), query()))
  const window = createMemo<ComboRenderWindow, undefined>((previous) => {
    const total = entries().length
    const highlighted = index()
    if (previous !== undefined && previous.end + previous.hiddenAfter === total &&
      highlighted >= previous.start && highlighted < previous.end) return previous
    return comboRenderWindow(total, highlighted)
  }, undefined, {
    equals: (left, right) => left.start === right.start && left.end === right.end && left.hiddenAfter === right.hiddenAfter,
  })
  const renderedEntries = createMemo(() => entries().slice(window().start, window().end))
  createEffect(() => setIndex((current) => clampComboHighlight(current, entries().length)))
  createEffect(() => { query(); folder(); index(); remote(); const source = highlightSource; queueMicrotask(() => scrollComboHighlightIntoView(root, source)) })
  const initialOptions = comboOptions(spec)
  const selected = initialOptions.find((option) => option.value === ed.initial)
  const rootFolder = selected?.folder?.split('/')[0]
  setIndex(Math.max(0, comboMenuEntries(initialOptions, [], '').findIndex((entry) => entry.kind === 'option' ? entry.option.value === ed.initial : entry.label === rootFolder)))
  let remoteHighlight = false
  createEffect(() => {
    const state = remote()
    if (state?.state !== 'ready' || remoteHighlight) return
    remoteHighlight = true
    if (query() === '') setIndex(Math.max(0, state.options.findIndex((option) => option.value === String(ed.initial))))
  })
  const openFolder = (path: readonly string[]) => { highlightSource = 'programmatic'; setFolder(path); setIndex(0) }
  const choose = (option: ComboOption) => multi
    ? mutateValues((current) => [...current, String(option.value)])
    : props.commitValue(option.value)
  const pageTo = (highlighted: number): void => {
    highlightSource = 'keyboard'
    setIndex(clampComboHighlight(highlighted, entries().length))
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const list = entries()
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); highlightSource = 'keyboard'
      setIndex(event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (current) => current + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault(); const entry = list[clampComboHighlight(index(), list.length)]
      if (entry?.kind === 'folder') openFolder(entry.path); else if (entry?.kind === 'option') choose(entry.option)
    } else if (event.key === 'Backspace' && query() === '' && folder().length > 0) { event.preventDefault(); openFolder(folder().slice(0, -1)) }
  }
  const memberIds = ed.target.kind === 'input' ? ed.target.inputFamilyOwner?.memberIds : undefined
  const familyOptions = spec.optionSource ? comboOptions(spec) : []
  const editableFamily = memberIds ? familyOptions.filter((option) => memberIds[String(option.value)] !== undefined) : familyOptions
  const [labels, setLabels] = createSignal<Record<string, string>>(Object.fromEntries(familyOptions.map((option) => [option.value, option.label])))
  const labelError = createMemo(() => { const all = Object.values(labels()).map((label) => label.trim()); return all.some((label) => label === '') ? message('inputFamily.error.emptyLabel') : new Set(all).size !== all.length ? message('inputFamily.labels.duplicate') : undefined })
  const memberId = (value: string | number) => memberIds?.[String(value)] ?? String(value)
  const labelsChanged = createMemo(() => editableFamily.some((option) => labels()[option.value]?.trim() !== option.label))
  const commitLabels = () => {
    if (ed.target.kind !== 'input' || !spec.optionSource || labelError()) return
    props.close()
    props.editor.app.dispatchTo(ed.tab, { command: 'dynamic.labelMembers', params: { graphId: ed.target.inputFamilyOwner?.graphId ?? ed.graphId, nodeId: ed.target.inputFamilyOwner?.nodeId ?? ed.target.nodeId, construct: ed.target.inputFamilyOwner?.construct ?? spec.optionSource.inputFamily, labels: Object.fromEntries(editableFamily.map((option) => [memberId(option.value), labels()[option.value]?.trim() ?? option.label])) } } as unknown as CommandInvocation)
  }
  const clickAway = () => multi ? props.commitValue(values()) : props.close()
  props.editor.bindClickAway?.(clickAway)
  const label = (value: string) => availableOptions().find((option) => option.value === value)?.label ?? value
  const oov = (value: string): 'error' | 'warning' | undefined => availableOptions().some((option) => option.value === value) ? undefined : spec.remote ? 'warning' : 'error'

  return <div ref={(el) => { root = el; props.bindPopover(el) }} class="widget-editor floating-surface widget-editor-popover combo-dropdown" classList={{ 'multi-combo-dropdown': multi, 'input-family-combo': !multi && spec.optionSource !== undefined }} data-testid={multi ? 'multi-combo-dropdown' : 'combo-dropdown'} data-remote={remote()?.state ?? 'static'} data-chip={multi ? spec.options['chip'] === true ? 'true' : spec.options['chip'] === false ? 'false' : 'absent' : undefined} data-editor-surface="popover" role="dialog" aria-label={`Edit ${ed.label} ${multi ? 'MULTI_COMBO' : 'COMBO'}`} style={props.popoverStyle}>
    <props.header type={multi ? 'MULTI_COMBO' : 'COMBO'} />
    <Show when={!multi && spec.optionSource !== undefined && editableFamily.length > 0}><fieldset class="input-family-labels" data-testid="input-family-labels"><legend>{message('inputFamily.labels.title')}</legend><For each={editableFamily}>{(option) => <label class="input-family-label-row"><span>{message('inputFamily.stableId', { id: memberId(option.value) })}</span><input data-testid={`input-family-label-${memberId(option.value)}`} aria-label={`${message('inputFamily.labels.item')}: ${memberId(option.value)}`} value={labels()[option.value] ?? option.label} onInput={(event) => setLabels((current) => ({ ...current, [option.value]: event.currentTarget.value }))} /></label>}</For><Show when={labelError()}><ProductNotice tone="error" testId="input-family-label-error">{labelError()}</ProductNotice></Show><button type="button" data-testid="input-family-label-apply" disabled={!labelsChanged() || labelError() !== undefined} onClick={commitLabels}>{message('inputFamily.labels.apply')}</button></fieldset></Show>
    <Show when={multi}><div class="multi-combo-values" data-testid="multi-combo-values"><For each={values()} fallback={<span class="combo-status">No selections</span>}>{(value, valueIndex) => <button type="button" class="multi-combo-value" classList={{ chip: spec.options['chip'] === true }} data-testid="multi-combo-value" data-oov={oov(value)} aria-label={`Remove ${label(value)}`} onClick={() => mutateValues((current) => current.filter((_item, candidate) => candidate !== valueIndex()))}>{label(value)}</button>}</For></div></Show>
    <ProductField controlId={multi ? 'multi-combo-search-control' : 'combo-search-control'} label="Search options" layout="compact"><input id={multi ? 'multi-combo-search-control' : 'combo-search-control'} data-testid={multi ? 'multi-combo-search' : 'combo-search'} placeholder={multi && typeof spec.options['placeholder'] === 'string' ? spec.options['placeholder'] : 'Search options...'} ref={(el) => queueMicrotask(() => el.focus())} value={query()} onInput={(event) => { highlightSource = 'keyboard'; setQuery(event.currentTarget.value); setIndex(0) }} onKeyDown={onKeyDown} /></ProductField>
    <Show when={folder().length > 0}><div class="combo-folder-navigation" data-testid="combo-folder-navigation"><button type="button" aria-label="Back to parent folder" onMouseDown={(event) => event.preventDefault()} onClick={() => openFolder(folder().slice(0, -1))}><Icon icon={ChevronLeft} /> Back</button><span>{folder().join(' / ')}</span></div></Show>
    <div class="combo-options" role="listbox" aria-multiselectable={multi ? 'true' : undefined}>
      <Show when={remote()?.state === 'loading'}><div class="combo-status">loading remote options...</div></Show>
      <Show when={remote()?.state === 'stale'}><div class="combo-status">remote options stale</div></Show>
      <Show when={remote()?.state === 'unavailable'}><div class="combo-status">remote options unavailable</div></Show>
      <Show when={window().hiddenBefore > 0}>
        <button type="button" class="combo-status combo-page" data-testid="combo-earlier" onMouseDown={(event) => event.preventDefault()} onClick={() => pageTo(window().start - 1)}>{`${window().hiddenBefore} earlier options`}</button>
      </Show>
      <For each={renderedEntries()} fallback={<div class="combo-status">No matching options</div>}>
        {(entry, row) => <button type="button" classList={{ 'combo-menu-entry': true, 'combo-folder': entry.kind === 'folder', 'combo-option': entry.kind === 'option', active: window().start + row() === index() }} data-testid={multi ? entry.kind === 'folder' ? 'multi-combo-folder' : 'multi-combo-option' : entry.kind === 'folder' ? 'combo-folder' : 'combo-option'} role="option" aria-selected={entry.kind === 'option' && window().start + row() === index()} aria-label={entry.kind === 'folder' ? `Open folder ${entry.label}` : undefined} onMouseEnter={() => { highlightSource = 'pointer'; setIndex(window().start + row()) }} onMouseDown={(event) => event.preventDefault()} onClick={() => entry.kind === 'folder' ? openFolder(entry.path) : choose(entry.option)}>
          {entry.kind === 'folder'
            ? <><Icon icon={Folder} /><span>{entry.label}</span><Icon icon={ChevronRight} /></>
            : <span class="combo-option-copy"><strong>{entry.option.label}</strong><Show when={entry.option.info !== undefined || (query().trim() !== '' && entry.option.folder !== undefined)}><span class="combo-option-info">{[query().trim() !== '' ? entry.option.folder : undefined, entry.option.info].filter(Boolean).join(' - ')}</span></Show></span>}
        </button>}
      </For>
      <Show when={window().hiddenAfter > 0}>
        <button type="button" class="combo-status combo-page" data-testid="combo-more" onMouseDown={(event) => event.preventDefault()} onClick={() => pageTo(window().end)}>{`${window().hiddenAfter} more options - type to narrow`}</button>
      </Show>
    </div>
    <Show when={spec.remote?.refreshButton === true}><button type="button" class="combo-refresh" data-testid={multi ? 'multi-combo-refresh' : 'remote-refresh'} onMouseDown={(event) => event.preventDefault()} onClick={() => load(true)}>refresh</button></Show>
    <Show when={multi}><ProductActionFooter><button type="button" data-testid="multi-combo-cancel" onClick={props.close}><Icon icon={X} /> Cancel</button><button type="button" data-testid="multi-combo-clear" onClick={() => mutateValues(() => [])}>Clear</button><button type="button" class="primary" data-testid="multi-combo-apply" onClick={() => props.commitValue(values())}><Icon icon={Check} /> Apply</button></ProductActionFooter></Show>
  </div>
}
