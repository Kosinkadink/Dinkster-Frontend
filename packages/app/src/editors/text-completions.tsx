import { createMemo, createSignal, onCleanup, Show } from 'solid-js'
import type {
  TextCompletion,
  TextCompletionInventoryLoadingState,
  TextCompletionInventoryRequestHandle,
  TextCompletionInventorySettledState,
  TextWidgetEditorContext,
  TextWidgetEditorExtension,
} from '@dinkster/widgets'
import {
  createSuggestionInteraction,
  SuggestionSurface,
  type SuggestionSurfaceItem,
  type SuggestionSurfaceState,
} from '../SuggestionSurface.js'
import type { WidgetEditorProps } from '../WidgetEditorController.js'

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

export type TextControl = HTMLInputElement | HTMLTextAreaElement

/**
 * The suggestion list of a text editor: embeddings and LoRAs from the live
 * inventory, or the text editor extensions registered for the field. Shared
 * by the card and the field open in its row. `isLive` is false once the
 * editor is closed, so a late result is dropped. `onAccepted` runs after a
 * picked suggestion is written into the control.
 */
export function createTextCompletions(host: WidgetEditorProps, isLive: () => boolean, onAccepted?: (control: TextControl) => void) {
  const ed = host.ed
  const text = ed.spec?.widgetType === 'STRING'
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
  let placeAt: (() => HTMLElement | null) | undefined
  
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
      if (!isLive() || requestSerial !== serial) return
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
    onAccepted?.(textarea)
  }
  
  const completionHandlers = {
    input: (event: InputEvent & { currentTarget: TextControl }) => requestCompletions(event.currentTarget, typeof event.data === 'string' ? event.data : event.currentTarget.value.at((event.currentTarget.selectionStart ?? 0) - 1) ?? ''),
  }
  const Suggestions = () => <Show when={open() && completionAnchor !== undefined}><SuggestionSurface ariaLabel="Text suggestions" anchor={placeAt?.() ?? completionAnchor!} {...(host.boundary === undefined ? {} : { boundary: host.boundary })} state={surfaceState()} interaction={interaction} onAccept={(entry) => accept(completionAnchor!, entry)} /></Show>
  const completionKeyDown = (event: KeyboardEvent & { currentTarget: TextControl }): boolean => interaction.onKeyDown(event, entries(), event.currentTarget, (entry) => accept(event.currentTarget, entry), closeCompletions)
  return {
    open,
    entries,
    interaction,
    /** The control picked suggestions go into; `place` is what the list is placed against, the control by default. */
    anchor: (element: TextControl, place?: () => HTMLElement | null): void => { completionAnchor = element; placeAt = place },
    requestCompletions,
    completionHandlers,
    completionKeyDown,
    closeCompletions,
    Suggestions,
  }
}
