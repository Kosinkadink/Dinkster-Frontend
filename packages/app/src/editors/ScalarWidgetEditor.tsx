import {
  createMemo,
  createSignal,
  onCleanup,
  Show,
  type Component,
} from 'solid-js'
import {
  isCanonicalUnsafeInteger,
  jsonSameValue,
  numericStepConstraints,
  type Json,
} from '@dinkster/core'
import { defaultTokens } from '@dinkster/canvas'
import type {
  TextCompletion,
  TextCompletionInventoryLoadingState,
  TextCompletionInventoryRequestHandle,
  TextCompletionInventorySettledState,
  TextWidgetEditorContext,
  TextWidgetEditorExtension,
} from '@dinkster/widgets'
import { Check, X } from 'lucide-solid'
import { floatKind, floatSliderView } from '@dinkster/widgets'
import { ProductSlider } from '../ProductSlider.js'
import {
  WidgetEditorController,
  type WidgetEditorImplementationProps,
  type WidgetEditorProps,
  type WidgetEditorState,
} from '../WidgetEditorController.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { Icon } from '../Icon.js'
import {
  createSuggestionInteraction,
  SuggestionSurface,
  type SuggestionSurfaceItem,
  type SuggestionSurfaceState,
} from '../SuggestionSurface.js'
import { editorScreenAnchor } from '../widget-editor-position.js'
import { parseNumericCommit, parsePrimitiveListCommit, resolveTextCommit, widgetCommitError } from '../widget-commit.js'

export function isInNodeTextEditor(ed: WidgetEditorState): boolean {
  if (ed.outputDescriptors !== undefined || ed.target.kind !== 'input' ||
    ed.spec?.widgetType !== 'STRING' || !ed.multiline) return false
  const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
  const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
  const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
  const type = ed.tab.store?.doc?.graphs[graphId]?.nodes[nodeId]?.type
  if (type === undefined || !type.startsWith('dinkster.video_document.')) return true
  const command = type.slice('dinkster.video_document.'.length)
  return !((inputId === 'params' && command !== 'import_otio') || (inputId === 'otio' && command === 'import_otio'))
}

interface CompletionEntry extends SuggestionSurfaceItem {
  readonly completion: TextCompletion
  readonly provider?: TextWidgetEditorExtension
}

interface CompletionContext {
  readonly text: string
  readonly caret: number
  readonly isCurrent?: () => boolean
}

type ReadyInventory = Extract<TextCompletionInventorySettledState, { readonly status: 'ready' }>
type CompletionSession =
  | { readonly status: 'idle' }
  | (CompletionContext & Exclude<TextCompletionInventoryLoadingState | TextCompletionInventorySettledState, ReadyInventory>)
  | (CompletionContext & Omit<ReadyInventory, 'items'> & { readonly entries: readonly CompletionEntry[] })

type TextControl = HTMLInputElement | HTMLTextAreaElement

const scalarStrategies = {
  INT: (raw: string) => parseNumericCommit(raw, 'INT'),
  FLOAT: (raw: string, round?: unknown, precision?: unknown) => parseNumericCommit(raw, 'FLOAT', round, precision),
} as const

const ScalarImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const host = props.editor
  const ed = host.ed
  const list = ed.spec?.widgetType === 'LIST'
  const text = ed.spec?.widgetType === 'STRING'
  const initialText = list ? JSON.stringify(ed.initial ?? []) : String(ed.initial ?? '')
  const [draft, setDraft] = createSignal(initialText)
  const slider = ed.spec !== undefined && ed.spec.widgetType === floatKind.type && floatSliderView.isCompatible(ed.spec)
    && (ed.viewId ?? floatKind.defaultView(ed.spec)) === 'core.slider'
  const fieldIds = productFieldIds('widget-editor-value')
  const [error, setError] = createSignal<string>()
  let live = true
  let popover: HTMLDivElement | undefined
  onCleanup(() => { live = false })

  const commitTarget = (value: Json): void => {
    if (!live || props.commitPending()) return
    if (text && typeof value === 'string' && ed.target.kind === 'input') {
      const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
      const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
      const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
      const current = ed.tab.store.doc.graphs[graphId]?.nodes[nodeId]?.values[inputId]
      const resolution = resolveTextCommit(ed.initial, value, current)
      if (resolution.kind === 'none') { props.close(); return }
      if (resolution.kind === 'splice') {
        void props.commitCommand({ command: 'text.splice', params: { graphId, nodeId, inputId, ...resolution.splice } })
        return
      }
    }
    props.commitValue(value)
  }

  const parse = (raw: string): Json | undefined => {
    let value: Json
    if (ed.spec === undefined) {
      try { value = JSON.parse(raw) as Json } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Invalid JSON')
        return undefined
      }
    } else if (list) {
      const parsed = parsePrimitiveListCommit(raw, ed.spec)
      if (!parsed.ok) { setError(parsed.error); return undefined }
      value = parsed.value
    } else if (ed.spec.widgetType === 'INT') {
      const parsed = scalarStrategies.INT(raw)
      if (!parsed.ok) { setError(parsed.error); return undefined }
      value = parsed.value
    } else if (ed.spec.widgetType === floatKind.type) {
      const parsed = scalarStrategies.FLOAT(raw, ed.spec.options['round'], ed.spec.options['precision'])
      if (!parsed.ok) { setError(parsed.error); return undefined }
      const min = ed.spec.options['min']
      const max = ed.spec.options['max']
      value = Math.min(typeof max === 'number' && Number.isFinite(max) ? max : Infinity,
        Math.max(typeof min === 'number' && Number.isFinite(min) ? min : -Infinity, parsed.value))
    } else {
      value = raw
    }
    if (ed.spec !== undefined) {
      const validation = widgetCommitError(host.app.widgetRegistryForTab(ed.tab).kind(ed.spec.widgetType), value, ed.spec)
      if (validation !== undefined) { setError(validation); return undefined }
    }
    return value
  }

  const commit = (raw: string, closeOnInvalid = false, skipUnchanged = false): void => {
    if (!live || props.commitPending()) return
    setError(undefined)
    const value = parse(raw)
    if (value === undefined) { if (closeOnInvalid) props.close(); return }
    if (skipUnchanged) {
      let initial = ed.initial
      if (ed.spec === undefined) {
        try { initial = JSON.parse(String(initial)) as Json } catch { initial = undefined }
      }
      if (jsonSameValue(value, initial)) { props.close(); return }
    }
    commitTarget(value)
  }

  const [session, setSession] = createSignal<CompletionSession>({ status: 'idle' })
  const entries = createMemo(() => session().status === 'ready' ? (session() as Extract<CompletionSession, { status: 'ready' }>).entries : [])
  const open = () => session().status !== 'idle'
  const surfaceState = createMemo<SuggestionSurfaceState<CompletionEntry>>(() => {
    const state = session()
    if (state.status === 'loading') return { status: 'loading' }
    if (state.status === 'ready') return { status: 'ready', items: state.entries }
    if (state.status === 'error') return { status: 'error', message: state.message }
    return { status: 'empty' }
  })
  const interaction = createSuggestionInteraction<CompletionEntry>()
  let controller: AbortController | undefined
  let serial = 0
  let completionAnchor: TextControl | undefined

  const completionContext = (): TextWidgetEditorContext | undefined => {
    if (!text || ed.spec === undefined || ed.target.kind !== 'input') return undefined
    const nodeType = ed.tab.store.doc.graphs[ed.graphId]?.nodes[ed.target.nodeId]?.type
    return nodeType === undefined ? undefined : {
      graphId: ed.graphId, nodeId: ed.target.nodeId, inputId: ed.target.valueKey, nodeType, spec: ed.spec,
      ...(ed.inputFamilyMembers === undefined ? {} : { inputFamilyMembers: ed.inputFamilyMembers }),
    }
  }
  const closeCompletions = (): void => {
    serial += 1; controller?.abort(); controller = undefined
    setSession({ status: 'idle' }); interaction.reset()
  }
  onCleanup(closeCompletions)

  const openSession = (handle: TextCompletionInventoryRequestHandle, request: CompletionContext & { textarea: TextControl; providerByCompletion?: ReadonlyMap<TextCompletion, TextWidgetEditorExtension> }): void => {
    const requestSerial = ++serial
    const context = { text: request.text, caret: request.caret, ...(request.isCurrent === undefined ? {} : { isCurrent: request.isCurrent }) }
    setSession({ ...handle.loading, ...context }); interaction.reset()
    void handle.settled.then((settled) => {
      if (!live || requestSerial !== serial) return
      if (request.textarea.value !== request.text || (request.textarea.selectionStart ?? request.textarea.value.length) !== request.caret || settled === undefined) {
        setSession({ status: 'idle' }); return
      }
      if (settled.status === 'ready') {
        const found = [...settled.items].sort((a, b) => a.sourceOrder - b.sourceOrder)
          .filter((item) => item.filterText.startsWith(settled.query)).map(({ completion }) => {
            const provider = request.providerByCompletion?.get(completion)
            return { id: provider === undefined ? `inventory:${completion.id}` : `${provider.id}:${completion.id}`, label: completion.label, ...(completion.detail === undefined ? {} : { detail: completion.detail }), completion, ...(provider === undefined ? {} : { provider }) }
          })
        setSession(found.length === 0 ? { status: 'empty', scopeId: settled.scopeId, query: settled.query, ...context } : { status: 'ready', scopeId: settled.scopeId, query: settled.query, ...context, entries: found })
      } else setSession({ ...settled, ...context })
      interaction.reset()
    })
  }

  const requestCompletions = (textarea: TextControl, trigger: string): void => {
    const context = completionContext()
    if (context === undefined) return
    controller?.abort(); controller = new AbortController()
    const text = textarea.value
    const caret = textarea.selectionStart ?? text.length
    const inventory = host.app.liveEmbeddingAndLoraInventory.load({ text, caret, signal: controller.signal })
    if (inventory !== undefined) {
      openSession(inventory, { textarea, text, caret, isCurrent: () => host.app.liveEmbeddingAndLoraInventory.isScopeCurrent(inventory.loading.scopeId) })
      return
    }
    const providers = host.app.textEditorExtensionRegistry.providersFor(context)
    if (providers.length === 0) { closeCompletions(); return }
    const currentController = controller
    const providerMap = new Map<TextCompletion, TextWidgetEditorExtension>()
    const scopeId = `text-editor-extensions:${providers.map((provider) => provider.id).join(',')}`
    const settled = Promise.all(providers.map(async (provider) => {
      try { return await provider.complete({ ...context, text, caret, trigger, signal: currentController.signal }) }
      catch (reason) { if (!currentController.signal.aborted) console.error(`text editor extension '${provider.id}' completion failed`, reason); return [] }
    })).then((results): TextCompletionInventorySettledState | undefined => {
      if (currentController.signal.aborted) return undefined
      const active = new Set(host.app.textEditorExtensionRegistry.providersFor(context))
      let sourceOrder = 0
      const items = results.flatMap((completions, index) => active.has(providers[index]!) ? completions.map((completion) => {
        providerMap.set(completion, providers[index]!)
        return { completion, filterText: completion.label.normalize('NFKC').toLocaleLowerCase(), sourceOrder: sourceOrder++ }
      }) : [])
      return items.length === 0 ? undefined : { status: 'ready', scopeId, query: '', items }
    })
    openSession({ loading: { status: 'loading', scopeId, query: '' }, settled }, { textarea, text, caret, providerByCompletion: providerMap })
  }

  const accept = (textarea: TextControl, entry: CompletionEntry): void => {
    const state = session()
    const context = completionContext()
    if (state.status !== 'ready' || textarea.value !== state.text || (textarea.selectionStart ?? textarea.value.length) !== state.caret || state.isCurrent?.() === false ||
      (entry.provider !== undefined && (context === undefined || !host.app.textEditorExtensionRegistry.providersFor(context).includes(entry.provider)))) { closeCompletions(); return }
    const { start, end, text } = entry.completion.replacement
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > textarea.value.length) { closeCompletions(); return }
    textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`
    textarea.setSelectionRange(start + text.length, start + text.length)
    closeCompletions()
  }

  const completionHandlers = {
    input: (event: InputEvent & { currentTarget: TextControl }) => requestCompletions(event.currentTarget, typeof event.data === 'string' ? event.data : event.currentTarget.value.at((event.currentTarget.selectionStart ?? 0) - 1) ?? ''),
  }
  const Suggestions = () => <Show when={open() && completionAnchor !== undefined}><SuggestionSurface ariaLabel="Text suggestions" anchor={completionAnchor!} {...(host.boundary === undefined ? {} : { boundary: host.boundary })} state={surfaceState()} interaction={interaction} onAccept={(entry) => accept(completionAnchor!, entry)} /></Show>
  const completionKeyDown = (event: KeyboardEvent & { currentTarget: TextControl }): boolean => interaction.onKeyDown(event, entries(), event.currentTarget, (entry) => accept(event.currentTarget, entry), closeCompletions)

  const clickAway = (): void => {
    if (ed.spec !== undefined && ed.multiline && !list) {
      props.close()
      return
    }
    const field = popover?.querySelector<TextControl>('input, textarea')
    if (field == null || field.value === initialText) props.close()
    else commit(field.value, true, true)
  }
  host.bindClickAway?.(clickAway)
  onCleanup(() => host.bindClickAway?.(undefined))

  if (isInNodeTextEditor(ed)) {
    const anchor = () => editorScreenAnchor(ed.rect, host.viewport())
    const scale = () => host.viewport().scale
    return <div class="widget-editor widget-editor-in-node" data-testid="widget-editor" data-editor-target="input" data-editor-mode="STRING" data-editor-surface="in-node" role="dialog" aria-label={`Edit ${ed.label} STRING`} style={{ left: `${anchor().x}px`, top: `${anchor().y}px`, width: `${anchor().width}px`, height: `${anchor().height}px`, padding: `${2 * scale()}px 0`, 'border-radius': `${4 * scale()}px` }}>
      <div class="widget-editor-in-node-surface"><span class="widget-editor-in-node-label" style={{ width: '100%', height: `${defaultTokens.multilineText.labelHeight * scale()}px`, 'font-size': `${defaultTokens.fontSize * scale()}px`, 'padding-left': `${6 * scale()}px` }}>{ed.label}</span>
        <textarea aria-label={`Edit ${ed.label}`} aria-autocomplete="list" aria-controls={open() ? interaction.listboxId : undefined} aria-describedby={open() ? interaction.statusId : undefined} aria-expanded={open()} aria-activedescendant={interaction.activeOptionId(entries())} ref={(el) => { completionAnchor = el; queueMicrotask(() => el.focus()) }} value={String(ed.initial ?? '')} style={{ 'font-family': defaultTokens.fontFamily, 'font-size': `${defaultTokens.multilineText.fontSize * scale()}px`, 'line-height': `${defaultTokens.multilineText.lineHeight * scale()}px`, padding: `${defaultTokens.multilineText.padding * scale()}px`, width: `calc(100% - ${defaultTokens.multilineText.scrollbarInset * scale()}px)`, 'align-self': 'flex-start', 'scrollbar-gutter': 'stable', '--multiline-scrollbar-width': `${defaultTokens.multilineText.scrollbarWidth * scale()}px` }} onInput={(event) => completionHandlers.input(event as InputEvent & { currentTarget: TextControl })} onClick={(event) => requestCompletions(event.currentTarget, '')} onKeyUp={(event) => { if (entries().length === 0 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) requestCompletions(event.currentTarget, '') }} onBlur={(event) => event.currentTarget.value === String(ed.initial ?? '') ? props.close() : commit(event.currentTarget.value)} onKeyDown={(event) => { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(event.currentTarget.value); return } completionKeyDown(event) }} />
        <Suggestions />
      </div>
      <Show when={props.commitError()}>{(error) => <ProductNotice tone="error" testId="widget-commit-error">{error()}</ProductNotice>}</Show>
    </div>
  }

  const numeric = ed.spec !== undefined && Object.hasOwn(scalarStrategies, ed.spec.widgetType)
  return <div ref={(el) => { popover = el; props.bindPopover(el) }} class="widget-editor floating-surface widget-editor-popover" data-testid="widget-editor" data-editor-target={ed.target.kind} data-editor-mode={ed.spec?.widgetType ?? 'raw'} data-editor-surface="popover" role="dialog" aria-label={`Edit ${ed.label} ${ed.spec?.widgetType ?? 'JSON'}`} style={props.popoverStyle}>
    <props.header type={ed.spec?.widgetType ?? 'JSON'} />
    <Show when={slider}>
      <ProductSlider ariaLabel={`${ed.label} slider`} value={Number.isFinite(Number(draft())) ? Number(draft()) : Number(ed.initial ?? 0)} min={Number(ed.spec!.options['min'])} max={Number(ed.spec!.options['max'])} step={Number(numericStepConstraints(ed.spec!).step)} onInput={(value) => { setError(undefined); const parsed = parse(String(value)); if (typeof parsed === 'number') setDraft(String(parsed)) }} />
    </Show>
    <ProductField controlId="widget-editor-value" label="Value" layout="compact" message={error()} messageTestId="widget-editor-error" invalid={error() !== undefined}>
      <Show when={ed.multiline || list} fallback={<input id="widget-editor-value" aria-labelledby={fieldIds.label} aria-autocomplete={text ? 'list' : undefined} aria-controls={open() ? interaction.listboxId : undefined} aria-describedby={error() !== undefined ? fieldIds.message : open() ? interaction.statusId : undefined} aria-invalid={error() === undefined ? undefined : 'true'} aria-expanded={text ? open() : undefined} aria-activedescendant={text ? interaction.activeOptionId(entries()) : undefined} ref={(el) => { if (text) completionAnchor = el; queueMicrotask(() => { el.focus(); if (numeric) el.select() }) }} value={draft()} placeholder={typeof ed.spec?.options['placeholder'] === 'string' ? ed.spec.options['placeholder'] : undefined} onInput={(event) => { setDraft(event.currentTarget.value); setError(undefined); if (text) completionHandlers.input(event as InputEvent & { currentTarget: TextControl }) }} onClick={(event) => { if (text) requestCompletions(event.currentTarget, '') }} onKeyUp={(event) => { if (text && entries().length === 0 && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) requestCompletions(event.currentTarget, '') }} onKeyDown={(event) => { if (text && completionKeyDown(event)) return; if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); commit(event.currentTarget.value) } }} />}>
        <textarea id="widget-editor-value" aria-labelledby={fieldIds.label} aria-describedby={error() === undefined ? undefined : fieldIds.message} aria-invalid={error() === undefined ? undefined : 'true'} ref={(el) => queueMicrotask(() => el.focus())} value={initialText} placeholder={typeof ed.spec?.options['placeholder'] === 'string' ? ed.spec.options['placeholder'] : undefined} onInput={() => setError(undefined)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); commit(event.currentTarget.value) } }} />
      </Show>
    </ProductField>
    <Suggestions />
    <div class="widget-editor-meta" data-testid="widget-editor-meta"><Show when={numeric}><dl class="widget-numeric-constraints" data-testid="widget-numeric-constraints" aria-label="Numeric constraints"><dt>Minimum</dt><dd>{Number.isFinite(ed.spec!.options['min']) || isCanonicalUnsafeInteger(ed.spec!.options['min']) ? String(ed.spec!.options['min']) : 'unbounded'}</dd><dt>Maximum</dt><dd>{Number.isFinite(ed.spec!.options['max']) || isCanonicalUnsafeInteger(ed.spec!.options['max']) ? String(ed.spec!.options['max']) : 'unbounded'}</dd><dt>Step</dt><dd>{(Number.isFinite(ed.spec!.options['step']) && Number(ed.spec!.options['step']) > 0) || isCanonicalUnsafeInteger(ed.spec!.options['step']) ? String(ed.spec!.options['step']) : `${numericStepConstraints(ed.spec!).step} (default)`}</dd></dl></Show><Show when={ed.multiline}>{ed.spec ? 'Ctrl+Enter to commit' : 'JSON'}</Show></div>
    <ProductActionFooter><button type="button" data-testid="widget-editor-cancel" onPointerDown={(event) => event.preventDefault()} onClick={props.close}><Icon icon={X} /> Cancel</button><button type="button" class="primary" data-testid="widget-editor-commit" onPointerDown={(event) => event.preventDefault()} onClick={(event) => { const field = event.currentTarget.closest('.widget-editor')?.querySelector<TextControl>('input, textarea'); if (field) commit(field.value) }}><Icon icon={Check} /> Commit</button></ProductActionFooter>
  </div>
}

export const ScalarWidgetEditor: Component<WidgetEditorProps> = (props) =>
  <WidgetEditorController {...props} implementation={ScalarImplementation} />
