import { createSignal } from 'solid-js'
import { jsonSameValue, type Json } from '@dinkster/core'
import { LOADING_DELAY_MS } from '@dinkster/ui'
import type { AppState } from './app-state.js'
import { assetUploadPolicy, mediaKindForAccept } from './asset-browser/helpers.js'
import { importAssetFile, type AssetFileImportProgress } from './asset-browser/import-file.js'
import { assetQuickListAllowed } from './editors/AssetQuickList.js'
import { activeProjectId } from './projects.js'
import { readUploadDestination, saveUploadDestination, type UploadDestinationChoice } from './upload-destination.js'
import { inRowValueKept } from './widget-editor-anchor.js'
import { widgetInputValueCommand } from './widget-editor-command.js'
import type { WidgetEditorState } from './WidgetEditor.js'

export type AssetFieldImportState = {
  readonly editor: WidgetEditorState
  readonly filename: string
} & (
  | { readonly phase: 'copying'; readonly received: number; readonly total: number | null }
  | { readonly phase: 'waiting' | 'checking' }
  | { readonly phase: 'refused'; readonly message: string }
)

const fieldKey = (editor: WidgetEditorState): string => JSON.stringify([
  editor.tab.id, editor.graphId, editor.instancePath ?? [],
  editor.target.kind === 'input' ? [editor.target.nodeId, editor.target.valueKey] : editor.target,
])

/**
 * The canvas owns a copy, not the chooser that selected its file. The host
 * checks the rebuilt row contract and wiring independently of its geometry.
 */
export function createAssetFieldImports(app: AppState, targetCurrent: (editor: WidgetEditorState) => boolean) {
  const [states, setStates] = createSignal<ReadonlyMap<string, AssetFieldImportState>>(new Map())
  const operations = new Map<string, { readonly current: () => boolean; readonly cancel: () => void }>()

  const update = (key: string, next: AssetFieldImportState | undefined): void => {
    const copy = new Map(states())
    if (next === undefined) copy.delete(key)
    else copy.set(key, next)
    setStates(copy)
  }

  const reconcile = (): void => {
    for (const operation of operations.values()) if (!operation.current()) operation.cancel()
  }

  return {
    states,
    reconcile,
    /** Stop never removes a file the engine may already have published. */
    stop(editor: WidgetEditorState): void {
      const key = fieldKey(editor)
      const phase = states().get(key)?.phase
      if (phase === 'copying' || phase === 'waiting') operations.get(key)?.cancel()
    },
    dispose(): void {
      for (const operation of operations.values()) operation.cancel()
      setStates(new Map())
    },
    async start(opened: WidgetEditorState, file: File, choice?: UploadDestinationChoice): Promise<void> {
      // Editor state can be rebound to a promoted store after its chooser closes.
      const editor = { ...opened }
      const target = editor.target
      if (target.kind !== 'input' || editor.tab.execution !== undefined ||
          !assetQuickListAllowed(editor.spec, editor.declaredType, editor.mergeableTypes)) return
      const key = fieldKey(editor)
      if (!targetCurrent(editor)) return
      if (operations.has(key)) {
        if (states().get(key)?.phase !== 'refused') return
        operations.get(key)!.cancel()
      }
      const tab = editor.tab
      const store = tab.store
      if (!inRowValueKept(editor, store.doc)) return
      const backend = app.backendForTab(tab)
      const registry = app.registryForTab(tab)
      const project = activeProjectId()
      const destination = choice ?? readUploadDestination(String(backend.id), project)
      const storedValue = (): Json => store.doc.graphs[target.familyOwner?.graphId ?? editor.graphId]
        ?.nodes[target.familyOwner?.nodeId ?? target.nodeId]?.values[target.familyOwner?.valueKey ?? target.valueKey] ?? null
      const before = storedValue()
      const abort = new AbortController()
      let waitingTimer: ReturnType<typeof setTimeout> | undefined
      let connectionChanged = false
      let committing = false
      const subscriptions: (() => void)[] = []
      const unsubscribe = (): void => { for (const remove of subscriptions.splice(0)) remove() }
      const current = (): boolean => operations.get(key) === operation && !abort.signal.aborted && !connectionChanged &&
        app.tabs.get().includes(tab) && tab.store === store && tab.execution === undefined &&
        app.backendForTab(tab) === backend && app.registryForTab(tab) === registry &&
        activeProjectId() === project && (committing || (jsonSameValue(storedValue(), before) && targetCurrent(editor)))
      const clearWaiting = (): void => { clearTimeout(waitingTimer); waitingTimer = undefined }
      const cancel = (): void => {
        abort.abort()
        clearWaiting()
        unsubscribe()
        if (operations.get(key) === operation) {
          operations.delete(key)
          update(key, undefined)
        }
      }
      const operation = { current, cancel }
      operations.set(key, operation)
      const validate = (): void => { if (!current()) cancel() }
      subscriptions.push(
        backend.connection.status.subscribe(() => { connectionChanged = true; cancel() }),
        backend.registry.subscribe(validate),
        app.tabs.subscribe(validate),
        store.document.subscribe(validate),
      )
      const base = { editor, filename: file.name }
      update(key, { ...base, phase: 'copying', received: 0, total: file.size })
      const progress = (value: AssetFileImportProgress): void => {
        if (!current()) { cancel(); return }
        if (states().get(key)?.phase === 'checking') return
        const staged = value.total !== null && value.received >= value.total
        if (value.phase === 'publishing' || (value.transport === 'browser' && staged)) {
          clearWaiting()
          update(key, { ...base, phase: 'checking' })
        } else if (value.transport === 'native' && staged) {
          // Keep the last copying amount until the ordinary loading delay expires.
          if (waitingTimer === undefined) waitingTimer = setTimeout(() => {
            if (current()) update(key, { ...base, phase: 'waiting' })
            else cancel()
          }, LOADING_DELAY_MS)
        } else {
          clearWaiting()
          update(key, { ...base, phase: 'copying', received: value.received, total: value.total })
        }
      }
      try {
        const acceptValue = editor.spec?.options['accept']
        const accept = Array.isArray(acceptValue) ? acceptValue.filter((item): item is string => typeof item === 'string') : []
        const kind = editor.sourceFilename?.kind ?? editor.spec?.kind ?? mediaKindForAccept(accept)
        const result = await importAssetFile(file, {
          baseUrl: backend.baseUrl, connection: backend.connection, accept, kind,
          policy: assetUploadPolicy(kind, registry?.uploadLimits), destination,
          current, signal: abort.signal, onProgress: progress,
        })
        if (result === undefined || !current()) { cancel(); return }
        // Only canonical acceptance changes the document; Stop needs no rollback.
        clearWaiting()
        update(key, { ...base, phase: 'checking' })
        committing = true
        const outcome = await app.dispatchTo(tab, widgetInputValueCommand(editor.graphId, target, result.asset))
        committing = false
        if (abort.signal.aborted) return
        if (!outcome.ok) {
          update(key, { ...base, phase: 'refused', message: outcome.diagnostics.map((item) => item.message).join(' ') })
          return
        }
        operations.delete(key)
        update(key, undefined)
        if (!result.existing) {
          try { saveUploadDestination(String(backend.id), project, destination) } catch { /* Preferences do not decide whether a file was accepted. */ }
        }
      } catch (error) {
        committing = false
        if (current()) update(key, { ...base, phase: 'refused', message: error instanceof Error ? error.message : String(error) })
        else cancel()
      } finally {
        clearWaiting()
        if (operations.get(key) !== operation || states().get(key)?.phase !== 'refused') unsubscribe()
      }
    },
  }
}
