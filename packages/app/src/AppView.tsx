/**
 * App view is a non-graph editor kind that projects exposed parameters,
 * previews, and the optional authored flow layout.
 *
 * This file intentionally imports nothing from
 * @dinkster/canvas. It reads the same DocumentSession, resolves the same
 * schema registry, writes through the same node.setValue command, and
 * queues through the same AppState.queue path as the graph editor - an
 * exposed value edited here is the identical document write a canvas
 * widget edit produces.
 *
 * Row resolution (exposed entry -> live/stale ParamRow, real graph
 * connectivity included) lives in app-view-rows.ts, framework-free and
 * unit-pinned there; this file owns only the Solid rendering and the
 * commit/reorder/rename dispatches.
 *
 * Inline control coverage: INT/FLOAT, STRING (single/multiline), BOOLEAN,
 * COLOR, and static/remote COMBO. ASSET and selector-derived rows remain
 * read-only with an "edit on canvas" hint.
 */

import { For, Match, Show, Switch, createEffect, createMemo, createSignal as createSolidSignal, createUniqueId, onCleanup, onMount, untrack } from 'solid-js'
import { Portal } from 'solid-js/web'
import {
  appLayout,
  appLayoutGrid,
  compareAppLayoutGrid,
  type AppLayoutGrid,
  type AppLayoutControlItem,
  type AppLayoutGroupItem,
  type AppLayoutItem,
  type AppLayoutPreviewItem,
  type AppLayoutQueueItem,
  type AppLayoutTextItem,
  companionSourcesOf,
  effectiveWidgetDefault,
  exposedKey,
  exposedPreviewKey,
  hasPreviewSurface,
  inputsOf,
  isCanonicalUnsafeInteger,
  type ExposedParameter,
  type ExposedPreview,
  type Json,
} from '@dinkster/core'
import type { RefreshableScopedClient } from '@dinkster/client'
import {
  buildParamRows,
  buildPreviewRows,
  appViewQueueScope,
  appViewQueueTargetOptions,
  comboOptions,
  fetchRemoteComboOptions,
  moveExposedInvocation,
  moveExposedPreviewInvocation,
  numberAttr,
  previewRuntimeMapping,
  type ParamRow,
  type PreviewRow,
} from './app-view-rows.js'
import type { AppState, Tab } from './app-state.js'
import type { EditorHostContext } from './editors.js'
import { useSignal } from './solid-adapter.js'
import { isTextTarget } from './settings.js'
import { parseNumericCommit, widgetCommitError } from './widget-commit.js'
import { Icon } from './Icon.js'
import { ProductCheckbox } from './ProductControls.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { ProductSelect, type ProductSelectOption } from './ProductSelect.js'
import { AppWidgetPreview } from './AppWidgetPreview.js'
import { AppPreviewSurface } from './AppPreviewSurface.js'
import { ExecutedImageViewer, executionOutputProvenance, type ExecutionOutputProvenance } from './ExecutedImageViewer.js'
import type { NodePreviewExecutionOutput } from './node-previews.js'
import { WidgetEditor, type WidgetEditorState } from './WidgetEditor.js'
import { liveExactnessFor } from './companion-display.js'
import { retainProvenExecution } from './scene-overlays.js'
import {
  createPreviewLoader,
  deriveNodePreviewSurface,
  validateBrowserMediaRendition,
  type NodePreviewSurface,
} from './node-previews.js'
import { parseAppViewText } from './app-view-text.js'
import { useAppMessage } from './locale.js'
import ArrowDown from 'lucide-solid/icons/arrow-down'
import ArrowUp from 'lucide-solid/icons/arrow-up'
import FolderPlus from 'lucide-solid/icons/folder-plus'
import GripVertical from 'lucide-solid/icons/grip-vertical'
import Pencil from 'lucide-solid/icons/pencil'
import Play from 'lucide-solid/icons/play'
import Plus from 'lucide-solid/icons/plus'
import SlidersHorizontal from 'lucide-solid/icons/sliders-horizontal'
import X from 'lucide-solid/icons/x'

export const APP_VIEW_MOBILE_BREAKPOINT = 640

function AppViewStringInput(props: {
  readonly value: string
  readonly multiline: boolean
  readonly ariaLabelledBy: string
  readonly onCommit: (value: string) => void
}) {
  const [draft, setDraft] = createSolidSignal(props.value)
  let dirty = false
  createEffect(() => {
    const value = props.value
    if (!dirty) setDraft(value)
  })
  const input = (value: string): void => {
    dirty = true
    setDraft(value)
  }
  const commit = (value: string): void => {
    if (value !== draft()) input(value)
    if (!dirty) return
    dirty = false
    if (value !== props.value) props.onCommit(value)
  }
  return props.multiline
    ? <textarea
        class="app-view-control multiline"
        data-testid="app-view-text"
        aria-labelledby={props.ariaLabelledBy}
        value={draft()}
        onInput={(event) => input(event.currentTarget.value)}
        onChange={(event) => commit(event.currentTarget.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
      />
    : <input
        class="app-view-control"
        data-testid="app-view-text"
        type="text"
        aria-labelledby={props.ariaLabelledBy}
        value={draft()}
        onInput={(event) => input(event.currentTarget.value)}
        onChange={(event) => commit(event.currentTarget.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
      />
}

function AppViewColorPicker(props: {
  readonly value: string
  readonly draftScopeId: string
  readonly label: string
  readonly onCommit: (value: string) => void
}) {
  const message = useAppMessage()
  const popupId = `app-view-color-popup-${createUniqueId()}`
  const displayed = (): string => /^#[0-9a-f]{6}$/i.test(props.value) ? props.value : '#ffffff'
  const [open, setOpen] = createSolidSignal(false)
  const [draft, setDraft] = createSolidSignal(props.value)
  const [position, setPosition] = createSolidSignal({ left: 0, top: 0 })
  let trigger: HTMLButtonElement | undefined
  let field: HTMLInputElement | undefined
  const presets = ['#ffffff', '#000000', '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6']
  const close = (): void => {
    setOpen(false)
    queueMicrotask(() => trigger?.focus())
  }
  const show = (): void => {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    setDraft(props.value)
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 230)), top: rect.bottom + 4 })
    setOpen(true)
    queueMicrotask(() => field?.focus())
  }
  const commit = (value: string): void => {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return
    props.onCommit(value)
    close()
  }
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="app-view-color product-color-trigger"
        data-testid="app-view-color"
        aria-label={`${props.label}: ${displayed()}`}
        aria-haspopup="dialog"
        aria-controls={popupId}
        aria-expanded={open()}
        onClick={() => open() ? close() : show()}
        onKeyDown={(event) => { if (event.key === 'Escape' && open()) escape(event) }}
      >
        <span class="product-color-swatch" style={{ background: displayed() }} aria-hidden="true" />
        <span>{displayed()}</span>
      </button>
      <Show when={open()}>
        <Portal mount={trigger?.closest('dialog') ?? document.body}>
          <div
            id={popupId}
            class="product-color-popover"
            data-app-view-draft-scope={props.draftScopeId}
            role="dialog"
            aria-label={message('appView.color.choose')}
            style={{ left: `${position().left}px`, top: `${position().top}px` }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={escape}
          >
            <label>{message('appView.color.hex')}<input ref={field} aria-label={message('appView.color.hex')} value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') commit(draft()) }} /></label>
            <div class="product-color-grid" aria-label={message('appView.color.presets')}>
              <For each={presets}>{(color) => <button type="button" aria-label={message('appView.color.select', { color })} style={{ background: color }} onClick={() => commit(color)} />}</For>
            </div>
            <button type="button" disabled={!/^#[0-9a-f]{6}$/i.test(draft())} onClick={() => commit(draft())}>{message('appView.color.apply')}</button>
          </div>
        </Portal>
      </Show>
    </>
  )
}

export function AppView(props: { app: AppState; host?: EditorHostContext }) {
  const message = useAppMessage()
  const draftScopeId = `app-view-draft-${createUniqueId()}`
  const tabs = useSignal(props.app.tabs)
  const globalActiveTabId = useSignal(props.app.activeTabId)
  // When hosted inside a split group, this view shows the group's active
  // tab, which may differ from the app-global active tab.
  const activeTabId = (): string => props.host?.tabId() ?? globalActiveTabId()
  const backendsTick = useSignal(props.app.backendsTick)
  const tabTargets = useSignal(props.app.tabTargets)
  const extensionsTick = useSignal(props.app.extensions.changed)
  const executions = useSignal(props.app.store.executions)
  const activeTab = (): Tab | undefined => tabs().find((t) => t.id === activeTabId())

  // Same registry discipline as CanvasHost: a memo keyed on the reference,
  // so ws flaps (backendsTick churn) never rebuild rows.
  const registry = createMemo((): ReturnType<AppState['registryForTab']> => {
    backendsTick()
    tabTargets()
    const tab = activeTab()
    return tab ? props.app.registryForTab(tab) : props.app.registry.get()
  })
  const widgetRegistry = createMemo(() => {
    registry()
    return props.app.widgetRegistryForTab(activeTab())
  })

  const [docTick, setDocTick] = createSolidSignal(0)
  createEffect(() => {
    const tab = activeTab()
    if (!tab) return
    const unsubscribe = tab.store.document.subscribe(() => setDocTick((n) => n + 1))
    onCleanup(unsubscribe)
  })

  const [previewTick, setPreviewTick] = createSolidSignal(0)
  const [outputPages, setOutputPages] = createSolidSignal<ReadonlyMap<string, number>>(new Map())
  createEffect(() => { activeTabId(); setOutputPages(new Map()) })
  const previewLoader = createPreviewLoader({
    viewUrlForExecution: (ref, file) => props.app.viewUrlForExecution(ref, file),
    assetUrlForExecution: (ref, digest) => props.app.assetUrlForExecution(ref, digest),
    assetUrlForInput: (digest) => {
      const tab = activeTab()
      if (tab === undefined) return undefined
      const backend = props.app.backendForTab(tab)
      return backend.protocol === 'dinkster' ? backend.connection.assetUrl(digest) : undefined
    },
    onDecoded: () => setPreviewTick((value) => value + 1),
    validateMediaRendition: validateBrowserMediaRendition,
  })
  onCleanup(() => previewLoader.dispose?.())

  const frozen = (): boolean => activeTab()?.execution !== undefined

  /**
   * Arrange mode shows the authoring tools (reorder, rename, remove); use
   * mode renders the clean form an app consumer sees. Frozen tabs are
   * always in use mode: their snapshot document cannot be arranged.
   */
  const arrange = (): boolean => !frozen() && activeTab()?.appArrange === true

  const [containerWidth, setContainerWidth] = createSolidSignal(Number.POSITIVE_INFINITY)
  const [arrangeBreakpoint, setArrangeBreakpoint] = createSolidSignal<'desktop' | 'mobile'>('desktop')
  const [pendingArrangeBreakpoint, setPendingArrangeBreakpoint] = createSolidSignal<'desktop' | 'mobile'>()
  const [responsivePresentationMobile, setResponsivePresentationMobile] = createSolidSignal(false)
  let appViewElement!: HTMLDivElement
  let syncMobilePresentationOrder: (() => void) | undefined
  let presentationFocusTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    backendsTick()
    docTick()
    const tab = activeTab()
    const tabId = tab?.id
    const scrollTop = tab === undefined ? 0 : props.app.appScrollTop(tab.id)
    queueMicrotask(() => {
      if (activeTab()?.id === tabId) appViewElement.scrollTop = scrollTop
    })
  })
  onMount(() => {
    const container = appViewElement.parentElement
    if (container === null) return
    const update = (): void => { setContainerWidth(container.getBoundingClientRect().width) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    document.addEventListener('focusin', applyPresentationAfterFocusChange)
    document.addEventListener('blur', applyPresentationAfterFocusChange, true)
    document.addEventListener('focusout', applyPresentationAfterFocusChange)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener('focusin', applyPresentationAfterFocusChange)
      document.removeEventListener('blur', applyPresentationAfterFocusChange, true)
      document.removeEventListener('focusout', applyPresentationAfterFocusChange)
      if (presentationFocusTimer !== undefined) clearTimeout(presentationFocusTimer)
    })
  })
  const responsiveMobile = (): boolean => containerWidth() < APP_VIEW_MOBILE_BREAKPOINT
  const focusedDraftScope = (): 'placement' | 'portal' | undefined => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return undefined
    const portal = active.closest<HTMLElement>('[data-app-view-draft-scope]')
    if (portal?.dataset['appViewDraftScope'] === draftScopeId) return 'portal'
    const placements = appViewElement?.querySelector('.app-view-rows')
    return placements?.contains(active) === true && isTextTarget(active) ? 'placement' : undefined
  }
  const presentationDeferred = (): boolean => arrange()
    ? pendingArrangeBreakpoint() !== undefined
    : responsiveMobile() !== responsivePresentationMobile()
  const applyPresentationAfterFocusChange = (): void => {
    if (presentationFocusTimer !== undefined) clearTimeout(presentationFocusTimer)
    presentationFocusTimer = setTimeout(() => {
      presentationFocusTimer = undefined
      if (focusedDraftScope() !== undefined) return
      const pending = pendingArrangeBreakpoint()
      if (arrange() && pending !== undefined) setArrangeBreakpoint(pending)
      setPendingArrangeBreakpoint(undefined)
      syncMobilePresentationOrder?.()
      if (!arrange()) setResponsivePresentationMobile(responsiveMobile())
    }, 0)
  }
  createEffect(() => {
    const desired = responsiveMobile()
    if (!arrange() && desired !== responsivePresentationMobile() && focusedDraftScope() === undefined) {
      setResponsivePresentationMobile(desired)
    }
  })
  const requestArrangeBreakpoint = (breakpoint: 'desktop' | 'mobile'): void => {
    const scope = focusedDraftScope()
    if (scope === 'placement') (document.activeElement as HTMLElement).blur()
    if (focusedDraftScope() !== undefined) {
      setPendingArrangeBreakpoint(breakpoint)
      return
    }
    setPendingArrangeBreakpoint(undefined)
    setArrangeBreakpoint(breakpoint)
  }
  const preservePortalDraftFocus = (event: PointerEvent): void => {
    if (focusedDraftScope() === 'portal') event.preventDefault()
  }
  const mobilePresentation = (): boolean => arrange()
    ? arrangeBreakpoint() === 'mobile'
    : responsivePresentationMobile()
  const mobileEditing = (): boolean => arrange() && arrangeBreakpoint() === 'mobile'
  let previousArrangeScope = ''
  createEffect(() => {
    const scope = `${activeTabId()}:${arrange()}`
    if (scope !== previousArrangeScope && arrange()) {
      setPendingArrangeBreakpoint(undefined)
      setArrangeBreakpoint(untrack(responsiveMobile) ? 'mobile' : 'desktop')
    }
    previousArrangeScope = scope
  })

  const rows = createMemo((): readonly ParamRow[] => {
    docTick()
    extensionsTick()
    const tab = activeTab()
    if (!tab) return []
    const reg = registry()
    const resolve = reg ? (type: string) => reg.resolve(type) : undefined
    return buildParamRows(tab.store.doc, resolve)
  })

  const previewCandidates = createMemo((): readonly PreviewRow[] => {
    docTick()
    extensionsTick()
    const tab = activeTab()
    if (tab === undefined) return []
    const reg = registry()
    return buildPreviewRows(
      tab.store.doc,
      reg ? (type) => reg.resolve(type) : undefined,
      (channel) => widgetRegistry().previewRendererFor(channel),
    )
  })

  type RenderedPreviewRow =
    | Extract<PreviewRow, { kind: 'stale' }>
    | (Omit<Extract<PreviewRow, { kind: 'candidate' }>, 'kind'> & { readonly kind: 'live'; readonly surface: NodePreviewSurface })

  const renderedPreviewRows = createMemo((): readonly RenderedPreviewRow[] => {
    executions()
    previewTick()
    backendsTick()
    const tab = activeTab()
    if (tab === undefined) return []
    const boundExec = props.app.executionForTab(tab)
    const live = tab.execution !== undefined || boundExec?.artifact === undefined
      ? undefined
      : props.app.compileTabCached(tab)
    const liveArtifact = live?.ok ? live.artifact : undefined
    const retained = tab.execution === undefined && boundExec !== undefined && props.app.overlayModeForTab(tab) === 'latest'
      ? retainProvenExecution(boundExec, props.app.executionList(), liveArtifact, [], registry()?.resolve)
      : undefined
    const exec = retained?.execution ?? boundExec
    const exactProducer = liveArtifact !== undefined && exec?.artifact !== undefined &&
      liveArtifact.connection === exec.ref.connection &&
      exec.artifact.connection === exec.ref.connection
      ? liveExactnessFor(liveArtifact, exec.artifact)
      : undefined
    const backend = exec === undefined ? undefined : props.app.backendFor(exec.ref.connection)
    const values = exec !== undefined && backend?.protocol === 'dinkster' && exec.status !== 'queued' && exec.status !== 'running'
      ? backend.connection.values()
      : undefined
    const mappings = new Map<string, ReturnType<typeof previewRuntimeMapping>>()
    return previewCandidates().map((row): RenderedPreviewRow => {
      if (row.kind === 'stale') return row
      let mapping = mappings.get(row.entry.graphId)
      if (mapping === undefined) {
        mapping = previewRuntimeMapping(tab.store.doc, exec, row.entry.graphId)
        mappings.set(row.entry.graphId, mapping)
      }
      const runtimeIds = mapping?.all(row.entry.nodeId) ?? []
      const def = tab.store.doc.graphs[row.entry.graphId]!
      const resolveSchema = registry()?.resolve
      const surface = deriveNodePreviewSurface({
        nodeId: row.entry.nodeId,
        isSubgraph: row.isSubgraph,
        schema: row.schema,
        exec,
        runtimeIds,
        runtimeIdsOf: mapping?.own,
        running: runtimeIds.some((runtimeId) => exec?.nodes[runtimeId]?.state === 'running'),
        frozen: tab.execution !== undefined,
        exactProducer,
        ...(retained === undefined ? {} : { retainedRuntimeIds: retained.retainedRuntimeIds }),
        companionSources: companionSourcesOf(def, undefined, (nodeId, inputId) => {
          const node = def.nodes[nodeId]
          const schema = node === undefined ? undefined : resolveSchema?.(node.type)
          const input = schema === undefined
            ? undefined
            : inputsOf(schema).find((candidate) => candidate.id === inputId)
          return input?.widget === undefined ? undefined : effectiveWidgetDefault(input.widget)
        }, resolveSchema),
        values,
        selectedAsset: row.selectedAsset,
        loader: previewLoader,
        outputKey: `${tab.id}\u0000${exec?.key ?? 'none'}\u0000${row.entry.graphId}\u0000${row.entry.nodeId}`,
        outputIndex: (key) => outputPages().get(key) ?? 0,
      })
      if (surface.preview === undefined && surface.text === undefined) {
        if (row.schema === undefined || !hasPreviewSurface(row.schema)) {
          return { kind: 'stale', entry: row.entry, reason: 'preview surface is unavailable' }
        }
      }
      return { ...row, kind: 'live', surface }
    })
  })
  const renderedPreviewsByKey = createMemo((): ReadonlyMap<string, RenderedPreviewRow> =>
    new Map(renderedPreviewRows().map((row) => [exposedPreviewKey(row.entry), row])))

  type FlowItem = (
    | {
        readonly kind: 'control'
        readonly row: ParamRow
        readonly registryIndex: number
        readonly layoutId?: string
        readonly parentId?: string
      }
    | {
        readonly kind: 'preview'
        readonly previewKey: string
        readonly registryIndex: number
        readonly layoutId?: string
        readonly parentId?: string
      }
    | { readonly kind: 'text'; readonly item: AppLayoutTextItem; readonly parentId?: string }
    | { readonly kind: 'queue'; readonly item: AppLayoutQueueItem; readonly parentId?: string }
    | {
        readonly kind: 'missing'
        readonly item: AppLayoutControlItem | AppLayoutPreviewItem
        readonly reason: string
        readonly parentId?: string
      }
    | { readonly kind: 'group'; readonly item: AppLayoutGroupItem; readonly children: readonly FlowItem[] }
  ) & { readonly grid?: AppLayoutGrid }

  const layoutIdOf = (item: FlowItem): string | undefined => {
    if (item.kind === 'control' || item.kind === 'preview') return item.layoutId
    return item.item.id
  }

  const flowItemKey = (item: FlowItem): string => {
    const layoutId = layoutIdOf(item)
    if (layoutId !== undefined) return `layout:${layoutId}`
    if (item.kind === 'control') return `control:${exposedKey(item.row.entry)}`
    if (item.kind === 'preview') return `preview:${item.previewKey}`
    return `layout:${item.item.id}`
  }

  const documentLayout = createMemo(() => {
    docTick()
    const tab = activeTab()
    return tab === undefined ? undefined : appLayout(tab.store.doc)
  })

  const flowItems = createMemo((): readonly FlowItem[] => {
    const layoutItems = documentLayout()?.desktop.items ?? []
    const params = rows()
    const previews = previewCandidates()
    const paramsByKey = new Map(params.map((row, index) => [exposedKey(row.entry), { row, index }]))
    const previewsByKey = new Map(previews.map((row, index) => [exposedPreviewKey(row.entry), { row, index }]))
    const byId = new Map(layoutItems.map((item) => [item.id, item]))
    const groups = layoutItems.filter((item): item is AppLayoutGroupItem => item.kind === 'group')
    const childIds = new Set(groups.flatMap((group) => group.children.filter((id) => byId.get(id)?.kind !== 'group')))
    const renderedChildren = new Set<string>()
    const placedParams = new Set<string>()
    const placedPreviews = new Set<string>()

    const placement = (item: AppLayoutItem, parentId?: string): FlowItem | undefined => {
      const grid = parentId === undefined ? appLayoutGrid(item) : undefined
      const gridProps = grid === undefined ? {} : { grid }
      if (item.kind === 'control') {
        const key = exposedKey(item.ref)
        placedParams.add(key)
        const found = paramsByKey.get(key)
        return found === undefined
          ? { kind: 'missing', item, reason: 'control is no longer exposed', ...(parentId === undefined ? {} : { parentId }), ...gridProps }
          : { kind: 'control', row: found.row, registryIndex: found.index, layoutId: item.id, ...(parentId === undefined ? {} : { parentId }), ...gridProps }
      }
      if (item.kind === 'preview') {
        const key = exposedPreviewKey(item.ref)
        placedPreviews.add(key)
        const found = previewsByKey.get(key)
        return found === undefined
          ? { kind: 'missing', item, reason: 'preview is no longer exposed', ...(parentId === undefined ? {} : { parentId }), ...gridProps }
          : { kind: 'preview', previewKey: key, registryIndex: found.index, layoutId: item.id, ...(parentId === undefined ? {} : { parentId }), ...gridProps }
      }
      if (item.kind === 'queue') return { kind: 'queue', item, ...(parentId === undefined ? {} : { parentId }), ...gridProps }
      if (item.kind === 'text') return { kind: 'text', item, ...(parentId === undefined ? {} : { parentId }), ...gridProps }
      const children = item.children.flatMap((id) => {
        const child = byId.get(id)
        if (child === undefined || child.kind === 'group' || renderedChildren.has(id)) return []
        renderedChildren.add(id)
        const rendered = placement(child, item.id)
        return rendered === undefined ? [] : [rendered]
      })
      return { kind: 'group', item, children, ...gridProps }
    }

    const laidOut = layoutItems.flatMap((item) => {
      if (childIds.has(item.id)) return []
      const rendered = placement(item)
      return rendered === undefined ? [] : [rendered]
    })
    const automaticParams: FlowItem[] = params.flatMap((row, index) =>
      placedParams.has(exposedKey(row.entry)) ? [] : [{ kind: 'control', row, registryIndex: index }])
    const automaticPreviews: FlowItem[] = previews.flatMap((row, index) => {
      const previewKey = exposedPreviewKey(row.entry)
      return placedPreviews.has(previewKey) ? [] : [{ kind: 'preview', previewKey, registryIndex: index }]
    })
    return [...laidOut, ...automaticParams, ...automaticPreviews]
  })
  createEffect(() => {
    flowItems()
    if (presentationDeferred()) applyPresentationAfterFocusChange()
  })

  type GridFlowItem = FlowItem & { readonly grid: AppLayoutGrid }
  const gridItems = createMemo((): readonly GridFlowItem[] => flowItems()
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { readonly item: GridFlowItem; readonly index: number } =>
      entry.item.grid !== undefined && (arrange() || entry.item.kind !== 'missing'))
    .sort((left, right) => compareAppLayoutGrid(left.item.grid, right.item.grid) || left.index - right.index)
    .map((entry) => entry.item))
  const fallbackItems = createMemo((): readonly FlowItem[] => flowItems().filter((item) =>
    item.grid === undefined && (arrange() || item.kind !== 'missing')))
  const gridItemsByKey = createMemo((): ReadonlyMap<string, GridFlowItem> =>
    new Map(gridItems().map((item) => [flowItemKey(item), item])))
  const gridItemKeys = createMemo((): readonly string[] => gridItems().map(flowItemKey))
  const fallbackItemsByKey = createMemo((): ReadonlyMap<string, FlowItem> =>
    new Map(fallbackItems().map((item) => [flowItemKey(item), item])))
  const fallbackItemKeys = createMemo((): readonly string[] => fallbackItems().map(flowItemKey))
  const automaticMobileItems = createMemo((): readonly FlowItem[] => [...gridItems(), ...fallbackItems()])
  const mobileItems = createMemo((): readonly FlowItem[] => {
    const automatic = automaticMobileItems()
    const mobile = documentLayout()?.mobile
    if (mobile?.customized !== true) return automatic
    const byId = new Map(automatic.flatMap((item) => {
      const id = layoutIdOf(item)
      return id === undefined ? [] : [[id, item] as const]
    }))
    const seen = new Set<string>()
    const customized = mobile.order.flatMap((id) => {
      const item = byId.get(id)
      if (item === undefined || seen.has(id)) return []
      seen.add(id)
      return [item]
    })
    return [...customized, ...automatic.filter((item) => {
      const id = layoutIdOf(item)
      return id === undefined || !seen.has(id)
    })]
  })
  type MobileKeyboardGesture = {
    readonly id: string
    readonly start: number
    readonly pending: number
  }
  const [mobileKeyboardGesture, setMobileKeyboardGesture] = createSolidSignal<MobileKeyboardGesture>()
  const mobileItemsByKey = createMemo((): ReadonlyMap<string, FlowItem> =>
    new Map(mobileItems().map((item) => [flowItemKey(item), item])))
  const derivedMobileItemKeys = createMemo((): readonly string[] => mobileItems().map(flowItemKey))
  const [mobileOrderRelease, setMobileOrderRelease] = createSolidSignal(0)
  syncMobilePresentationOrder = () => setMobileOrderRelease((value) => value + 1)
  const mobileItemKeys = createMemo<readonly string[]>((previous) => {
    mobileOrderRelease()
    const next = derivedMobileItemKeys()
    const reordered = previous.length === next.length && previous.every((key) => next.includes(key))
    // Keep the same row instances until the focused editor commits.
    if (mobilePresentation() && focusedDraftScope() !== undefined && reordered) return previous
    return next
  }, [])

  const [errors, setErrors] = createSolidSignal<ReadonlyMap<string, string>>(new Map())
  const [pendingQueues, setPendingQueues] = createSolidSignal<ReadonlySet<string>>(new Set())
  // Tab-scoped so transient error/rename state never bleeds between two
  // documents that happen to share a (graph, node, input) triple.
  const rowKey = (entry: ExposedParameter): string => `${activeTabId()}:${exposedKey(entry)}`
  const previewRowKey = (entry: ExposedPreview): string => `${activeTabId()}:${exposedPreviewKey(entry)}`
  const setError = (entry: ExposedParameter, message: string | undefined): void => {
    setErrors((m) => {
      const next = new Map(m)
      if (message === undefined) next.delete(rowKey(entry))
      else next.set(rowKey(entry), message)
      return next
    })
  }

  /** All controls converge on the same undoable document command. */
  const commit = (row: Extract<ParamRow, { kind: 'live' }>, value: Json): void => {
    const tab = activeTab()
    if (!tab || frozen()) return
    if (row.spec !== undefined) {
      const error = widgetCommitError(widgetRegistry().kind(row.spec.widgetType), value, row.spec)
      if (error !== undefined) {
        setError(row.entry, error)
        return
      }
    }
    setError(row.entry, undefined)
    props.app.dispatchTo(tab, {
      command: 'node.setValue',
      params: {
        graphId: row.entry.graphId,
        nodeId: row.entry.nodeId,
        inputId: row.valueKey,
        value,
      },
    })
  }

  const commitNumeric = (row: Extract<ParamRow, { kind: 'live' }>, raw: string, widgetType: 'INT' | 'FLOAT'): void => {
    const parsed = parseNumericCommit(raw, widgetType, row.spec?.options['round'])
    if (!parsed.ok) {
      setError(row.entry, parsed.error)
      return
    }
    commit(row, parsed.value)
  }

  const dispatchEntry = (command: string, entry: ExposedParameter, extra: Record<string, Json> = {}): void => {
    const tab = activeTab()
    if (!tab) return
    props.app.dispatchTo(tab, {
      command,
      params: { graphId: entry.graphId, nodeId: entry.nodeId, inputId: entry.inputId, ...extra },
    })
  }

  const dispatchPreviewEntry = (command: string, entry: ExposedPreview, extra: Record<string, Json> = {}): void => {
    const tab = activeTab()
    if (!tab) return
    props.app.dispatchTo(tab, {
      command,
      params: { graphId: entry.graphId, nodeId: entry.nodeId, ...extra },
    })
  }

  const dispatchLayout = (command: string, params: Json): void => {
    const tab = activeTab()
    if (tab) props.app.dispatchTo(tab, { command, params })
  }

  const freshLayoutId = (kind: string): string =>
    `app-${kind}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`

  const layoutGroups = (): readonly AppLayoutGroupItem[] =>
    (documentLayout()?.desktop.items ?? []).filter((item): item is AppLayoutGroupItem => item.kind === 'group')

  const addAutomaticPlacement = (
    item: Extract<FlowItem, { kind: 'control' | 'preview' }>,
    parentId: string | undefined,
    index: number,
    grid?: AppLayoutGrid,
  ): void => {
    const id = freshLayoutId(item.kind)
    const preview = item.kind === 'preview'
      ? previewCandidates().find((row) => exposedPreviewKey(row.entry) === item.previewKey)
      : undefined
    const placement: Json = item.kind === 'control'
      ? { id, kind: 'control', ref: { ...item.row.entry }, ...(grid ?? {}) }
      : { id, kind: 'preview', ref: { graphId: preview!.entry.graphId, nodeId: preview!.entry.nodeId }, ...(grid ?? {}) }
    dispatchLayout('app.layout.add', {
      item: placement,
      parentId: parentId ?? null,
      index,
    })
  }

  const moveFlowItem = (item: FlowItem, parentId: string | undefined, index: number): void => {
    if (item.kind === 'group') {
      dispatchLayout('app.layout.move', { id: item.item.id, parentId: null, index })
      return
    }
    if (item.kind === 'text' || item.kind === 'queue' || item.kind === 'missing') {
      dispatchLayout('app.layout.move', { id: item.item.id, parentId: parentId ?? null, index })
      return
    }
    if (item.layoutId === undefined) addAutomaticPlacement(item, parentId, index)
    else dispatchLayout('app.layout.move', { id: item.layoutId, parentId: parentId ?? null, index })
  }

  const flowLabel = (item: FlowItem): string => {
    if (item.kind === 'control') {
      return item.row.kind === 'live' ? item.row.label : (item.row.entry.label ?? item.row.entry.inputId)
    }
    if (item.kind === 'preview') {
      const row = renderedPreviewsByKey().get(item.previewKey)
      return row?.kind === 'live' ? row.label : (row?.entry.label ?? row?.entry.nodeId ?? 'Preview')
    }
    if (item.kind === 'queue') return item.item.label
    if (item.kind === 'text') return item.item.text || 'Text'
    if (item.kind === 'group') return item.item.title
    return `Unavailable placement: ${item.reason}`
  }

  const defaultGridFor = (item: FlowItem): AppLayoutGrid => {
    const y = gridItems().reduce((bottom, placed) => Math.max(bottom, placed.grid.y + placed.grid.h), 0)
    if (item.kind === 'preview') return { x: 0, y, w: 12, h: 4 }
    if (item.kind === 'text') return { x: 0, y, w: 12, h: 2 }
    if (item.kind === 'group') return { x: 0, y, w: 12, h: Math.max(3, item.children.length * 2 + 1) }
    return { x: 0, y, w: 6, h: 2 }
  }

  const placeInGrid = (item: FlowItem): void => {
    const grid = defaultGridFor(item)
    const id = layoutIdOf(item)
    if (id !== undefined) {
      dispatchLayout('app.layout.setGrid', { id, grid: { ...grid } })
    } else if (item.kind === 'control' || item.kind === 'preview') {
      addAutomaticPlacement(item, undefined, topLevelLayoutCount(), grid)
    }
  }

  type GridGesture = {
    readonly source: 'pointer' | 'keyboard'
    readonly id: string
    readonly start: AppLayoutGrid
    readonly pending: AppLayoutGrid
    readonly pointerId?: number
    readonly keyboardTarget?: GridKeyboardTarget
  }
  type GridPointerMode = 'move' | 'right' | 'bottom' | 'corner'
  type GridKeyboardTarget = GridPointerMode | 'placement'
  const [gridGesture, setGridGesture] = createSolidSignal<GridGesture | undefined>(undefined)
  let disposeGridPointer: (() => void) | undefined

  const gridStyle = (grid: AppLayoutGrid): Record<string, string> => ({
    'grid-column': `${grid.x + 1} / span ${grid.w}`,
    'grid-row': `${grid.y + 1} / span ${grid.h}`,
  })

  const sameGrid = (left: AppLayoutGrid, right: AppLayoutGrid): boolean =>
    left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h

  const focusGridTarget = (id: string, target: GridKeyboardTarget = 'placement'): void => {
    queueMicrotask(() => {
      for (const element of document.querySelectorAll<HTMLElement>('[data-app-grid-id]')) {
        if (element.dataset['appGridId'] === id) {
          const next = target === 'placement'
            ? element
            : element.querySelector<HTMLElement>(`[data-grid-keyboard-target="${target}"]`)
          next?.focus()
          break
        }
      }
    })
  }

  const commitGridGesture = (gesture: GridGesture): void => {
    if (!sameGrid(gesture.start, gesture.pending)) {
      dispatchLayout('app.layout.setGrid', { id: gesture.id, grid: { ...gesture.pending } })
    }
    focusGridTarget(gesture.id, gesture.keyboardTarget)
  }

  const beginGridPointer = (
    event: PointerEvent & { readonly currentTarget: HTMLElement },
    item: GridFlowItem,
    mode: GridPointerMode,
  ): void => {
    if (event.button !== 0 || !arrange()) return
    const surface = event.currentTarget.closest<HTMLElement>('[data-testid="app-layout-grid"]')
    if (surface === null) return
    event.preventDefault()
    event.stopPropagation()
    disposeGridPointer?.()
    const pointerId = event.pointerId
    const origin = { x: event.clientX, y: event.clientY }
    const start = item.grid
    const rect = surface.getBoundingClientRect()
    const computed = getComputedStyle(surface)
    const gap = Number.parseFloat(computed.columnGap) || 12
    const rowHeight = Number.parseFloat(computed.gridAutoRows) || 64
    const columnPitch = (rect.width - gap * 11) / 12 + gap
    const rowPitch = rowHeight + gap
    setGridGesture({ source: 'pointer', id: layoutIdOf(item)!, start, pending: start, pointerId })

    function dispose(): void {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape)
      if (disposeGridPointer === dispose) disposeGridPointer = undefined
    }
    function move(next: PointerEvent): void {
      if (next.pointerId !== pointerId) return
      const columns = Math.round((next.clientX - origin.x) / columnPitch)
      const rows = Math.round((next.clientY - origin.y) / rowPitch)
      let pending = start
      if (mode === 'move') {
        pending = {
          ...start,
          x: Math.max(0, Math.min(12 - start.w, start.x + columns)),
          y: Math.max(0, start.y + rows),
        }
      } else {
        pending = {
          ...start,
          w: mode === 'right' || mode === 'corner'
            ? Math.max(1, Math.min(12 - start.x, start.w + columns))
            : start.w,
          h: mode === 'bottom' || mode === 'corner' ? Math.max(1, start.h + rows) : start.h,
        }
      }
      setGridGesture({ source: 'pointer', id: layoutIdOf(item)!, start, pending, pointerId })
    }
    function finish(next: PointerEvent): void {
      if (next.pointerId !== pointerId) return
      const completed = gridGesture()
      dispose()
      setGridGesture(undefined)
      if (completed?.source === 'pointer' && completed.pointerId === pointerId) commitGridGesture(completed)
    }
    function cancel(next: PointerEvent): void {
      if (next.pointerId !== pointerId) return
      dispose()
      setGridGesture(undefined)
      focusGridTarget(layoutIdOf(item)!)
    }
    function escape(next: KeyboardEvent): void {
      if (next.key !== 'Escape') return
      next.preventDefault()
      dispose()
      setGridGesture(undefined)
      focusGridTarget(layoutIdOf(item)!)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape)
    disposeGridPointer = dispose
  }

  const gridKeyDown = (
    event: KeyboardEvent & { readonly currentTarget: HTMLElement },
    item: GridFlowItem,
    target: GridKeyboardTarget = 'placement',
  ): void => {
    if (event.target !== event.currentTarget) return
    const id = layoutIdOf(item)!
    if (event.key === 'Escape') {
      if (gridGesture()?.source === 'keyboard' && gridGesture()?.id === id && gridGesture()?.keyboardTarget === target) {
        event.preventDefault()
        setGridGesture(undefined)
        focusGridTarget(id, target)
      }
      return
    }
    const horizontalKey = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const verticalKey = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    if ((!horizontalKey && !verticalKey) ||
      (target === 'right' && !horizontalKey) ||
      (target === 'bottom' && !verticalKey)) return
    event.preventDefault()
    const existing = gridGesture()
    const continuing = existing?.source === 'keyboard' && existing.id === id && existing.keyboardTarget === target
    const start = continuing ? existing.start : item.grid
    const current = continuing ? existing.pending : item.grid
    const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    const resizing = target === 'right' || target === 'bottom' || target === 'corner' ||
      (target === 'placement' && event.shiftKey)
    const pending = resizing
      ? {
          ...current,
          w: target === 'bottom' ? current.w : Math.max(1, Math.min(12 - current.x, current.w + horizontal)),
          h: target === 'right' ? current.h : Math.max(1, current.h + vertical),
        }
      : {
          ...current,
          x: Math.max(0, Math.min(12 - current.w, current.x + horizontal)),
          y: Math.max(0, current.y + vertical),
        }
    setGridGesture({ source: 'keyboard', id, start, pending, keyboardTarget: target })
  }

  const gridKeyUp = (
    event: KeyboardEvent & { readonly currentTarget: HTMLElement },
    item: GridFlowItem,
    target: GridKeyboardTarget = 'placement',
  ): void => {
    if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    const completed = gridGesture()
    if (completed?.source !== 'keyboard' || completed.id !== layoutIdOf(item) || completed.keyboardTarget !== target) return
    event.preventDefault()
    setGridGesture(undefined)
    commitGridGesture(completed)
  }

  onCleanup(() => disposeGridPointer?.())

  const [renaming, setRenaming] = createSolidSignal<string | undefined>(undefined)
  const [previewRenaming, setPreviewRenaming] = createSolidSignal<string | undefined>(undefined)

  interface RemoteSource {
    readonly client: RefreshableScopedClient
    readonly route: string
    readonly authority: number
  }
  type RemoteState =
    | { readonly state: 'loading'; readonly source: RemoteSource; readonly options?: readonly { value: string; label: string }[] }
    | { readonly state: 'ready'; readonly source: RemoteSource; readonly options: readonly { value: string; label: string }[] }
    | { readonly state: 'stale'; readonly source: RemoteSource; readonly options: readonly { value: string; label: string }[]; readonly message: string }
    | { readonly state: 'unavailable'; readonly source: RemoteSource; readonly message: string }
  const [remoteCombos, setRemoteCombos] = createSolidSignal<ReadonlyMap<string, RemoteState>>(new Map())
  const remoteTokens = new Map<string, number>()
  const remoteAborts = new Map<string, AbortController>()
  let live = true
  onCleanup(() => {
    live = false
    for (const abort of remoteAborts.values()) abort.abort()
  })

  const setRemoteCombo = (key: string, state: RemoteState): void => {
    setRemoteCombos((states) => new Map(states).set(key, state))
  }

  const sourceFor = (row: Extract<ParamRow, { kind: 'live' }>): RemoteSource | undefined => {
    backendsTick()
    const route = row.spec?.remote?.route
    const tab = activeTab()
    if (!route || !tab) return undefined
    const client = props.app.backendForTab(tab).scopedClient
    return { client, route, authority: client.remoteChoiceAuthority() }
  }

  const remoteFor = (row: Extract<ParamRow, { kind: 'live' }>): RemoteState | undefined => {
    const source = sourceFor(row)
    const state = remoteCombos().get(rowKey(row.entry))
    if (!source || !state) return undefined
    return state.source.client === source.client &&
      state.source.route === source.route &&
      state.source.authority === source.authority
      ? state
      : undefined
  }

  /** Fetch on select open/focus, through the row's tab-owned scoped client. */
  const loadRemoteOptions = (row: Extract<ParamRow, { kind: 'live' }>): void => {
    const remote = row.spec?.remote
    const tab = activeTab()
    if (!remote || !tab) return
    const key = rowKey(row.entry)
    if (remoteFor(row)?.state === 'loading') return
    const token = (remoteTokens.get(key) ?? 0) + 1
    remoteTokens.set(key, token)
    remoteAborts.get(key)?.abort()
    const abort = new AbortController()
    remoteAborts.set(key, abort)
    const previous = remoteFor(row)
    const client = props.app.backendForTab(tab).scopedClient
    const source = { client, route: remote.route, authority: client.remoteChoiceAuthority() }
    setRemoteCombo(key, {
      state: 'loading', source,
      ...(previous?.state === 'ready' || previous?.state === 'stale' ? { options: previous.options } : {}),
    })
    fetchRemoteComboOptions(remote.route, (route, options) => client.remoteChoices(route, options), abort.signal, remote)
      .then((options) => {
        if (!live || remoteTokens.get(key) !== token) return
        if (client.remoteChoiceAuthority() !== source.authority) return
        setRemoteCombo(key, { state: 'ready', source, options })
      })
      .catch((error: unknown) => {
        if (!live || remoteTokens.get(key) !== token) return
        const message = error instanceof Error ? error.message : String(error)
        setRemoteCombo(key, previous?.state === 'ready' || previous?.state === 'stale'
          ? { state: 'stale', source, options: previous.options, message }
          : { state: 'unavailable', source, message })
      })
  }

  const optionsFor = (row: Extract<ParamRow, { kind: 'live' }>): readonly { value: Json; label: string }[] => {
    const remote = remoteFor(row)
    return remote && 'options' in remote && remote.options !== undefined
      ? remote.options
      : row.spec ? comboOptions(row.spec) : []
  }

  const ComboControl = (controlProps: { readonly row: Extract<ParamRow, { kind: 'live' }> }) => {
    const options = () => optionsFor(controlProps.row)
    const selected = () => options().findIndex((option) => option.value === controlProps.row.value)
    const selectOptions = (): readonly ProductSelectOption<Json>[] => [
      ...(selected() === -1 ? [{ id: 'oov', label: display(controlProps.row.value), value: controlProps.row.value ?? null, disabled: true }] : []),
      ...options().map((option, index) => ({ id: String(index), label: option.label, value: option.value })),
    ]
    return <ProductSelect
      class="app-view-control"
      testId="app-view-combo"
      ariaLabel={controlProps.row.label}
      options={selectOptions()}
      selectedId={selected() === -1 ? 'oov' : String(selected())}
      dataAttributes={{
        'data-remote': controlProps.row.spec?.remote ? (remoteFor(controlProps.row)?.state ?? 'idle') : 'static',
        'data-param-select': rowKey(controlProps.row.entry),
      }}
      onFocus={() => loadRemoteOptions(controlProps.row)}
      onPointerDown={() => loadRemoteOptions(controlProps.row)}
      onSelect={(option) => {
        // Committing rebuilds the row list, remounting this trigger; restore
        // focus onto the replacement element once the rebuild has flushed.
        const key = rowKey(controlProps.row.entry)
        commit(controlProps.row, option.value)
        queueMicrotask(() => {
          // Compare attribute values in JS rather than via a CSS selector:
          // CSS.escape cannot round-trip U+0000, which a valid lineage-derived
          // key may contain.
          for (const el of document.querySelectorAll<HTMLElement>('[data-param-select]')) {
            if (el.getAttribute('data-param-select') === key) {
              el.focus()
              break
            }
          }
        })
      }}
    />
  }

  const [videoEditor, setVideoEditor] = createSolidSignal<WidgetEditorState>()
  const videoEditorOwner = createMemo(
    () => {
      const tab = activeTab()
      return tab === undefined ? undefined : { id: tab.id, store: tab.store }
    },
    undefined,
    { equals: (a, b) => a?.id === b?.id && a?.store === b?.store },
  )
  createEffect(() => {
    docTick()
    backendsTick()
    videoEditorOwner()
    setVideoEditor(undefined)
  })
  const openVideoEditor = (row: Extract<ParamRow, { kind: 'live' }>): void => {
    const tab = activeTab()
    if (!tab || !editable(row)) return
    setVideoEditor({
      tab, graphId: row.entry.graphId, label: row.label,
      target: { kind: 'input', nodeId: row.entry.nodeId, valueKey: row.valueKey },
      spec: row.spec!, initial: row.value, multiline: false,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    })
  }
  const editableKinds = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COLOR', 'COMBO', 'VIDEO_EDIT'])
  const editable = (row: Extract<ParamRow, { kind: 'live' }>): boolean =>
    !frozen() &&
    !row.linked &&
    !row.derived &&
    row.spec !== undefined &&
    editableKinds.has(row.spec.widgetType)

  const readOnlyHint = (row: Extract<ParamRow, { kind: 'live' }>): string =>
    row.linked
      ? message('appView.readOnly.linked')
      : row.derived
        ? message('appView.readOnly.derived')
        : message('appView.readOnly.unsupported')

  const display = (value: Json | undefined): string => {
    return value === undefined ? message('appView.value.unset') : typeof value === 'string' ? value : JSON.stringify(value)
  }

  const [dragged, setDragged] = createSolidSignal<{
    readonly tabId: string
    readonly key: string
    readonly entry: ExposedParameter
    readonly index: number
  } | undefined>(undefined)
  const [previewDragged, setPreviewDragged] = createSolidSignal<{
    readonly tabId: string
    readonly key: string
    readonly entry: ExposedPreview
    readonly index: number
  } | undefined>(undefined)

  const dropAt = (index: number): void => {
    const source = dragged()
    setDragged(undefined)
    const tab = activeTab()
    if (!source || !tab || source.tabId !== activeTabId() || source.index === index) return
    props.app.dispatchTo(tab, moveExposedInvocation(source.entry, index))
  }

  const dropPreviewAt = (index: number): void => {
    const source = previewDragged()
    setPreviewDragged(undefined)
    const tab = activeTab()
    if (!source || !tab || source.tabId !== activeTabId() || source.index === index) return
    props.app.dispatchTo(tab, moveExposedPreviewInvocation(source.entry, index))
  }

  // A rename input removed without blur (tab switch) or an in-flight drag
  // must not resurface when the tab or mode is next shown: reset the
  // authoring interaction state whenever either changes. The memo's value
  // equality keeps unrelated tabs-array churn from clearing a live rename.
  const interactionScope = createMemo((): string => `${activeTabId()}:${arrange()}:${arrangeBreakpoint()}`)
  createEffect(() => {
    interactionScope()
    disposeGridPointer?.()
    setGridGesture(undefined)
    setRenaming(undefined)
    setDragged(undefined)
    setPreviewRenaming(undefined)
    setPreviewDragged(undefined)
    setMobileKeyboardGesture(undefined)
  })

  const topLevelLayoutCount = (): number => {
    const items = documentLayout()?.desktop.items ?? []
    const children = new Set(items.flatMap((item) => item.kind === 'group' ? item.children : []))
    return items.filter((item) => !children.has(item.id)).length
  }

  const layoutSiblingCount = (item: FlowItem, renderedCount: number): number => {
    if (item.kind === 'group') return topLevelLayoutCount()
    if (item.kind === 'control' || item.kind === 'preview') {
      if (item.layoutId === undefined) return renderedCount
    }
    return item.parentId === undefined ? topLevelLayoutCount() : renderedCount
  }

  const ParentSelect = (selectProps: { readonly item: FlowItem }) => {
    if (selectProps.item.kind === 'group') return null
    const groups = () => layoutGroups()
    const parentId = (): string | undefined => selectProps.item.kind === 'control' ||
      selectProps.item.kind === 'preview' ||
      selectProps.item.kind === 'queue' ||
      selectProps.item.kind === 'text' ||
      selectProps.item.kind === 'missing'
      ? selectProps.item.parentId
      : undefined
    return (
      <Show when={groups().length > 0 || parentId() !== undefined}>
        <select
          class="app-layout-parent"
          data-testid="app-layout-parent"
          aria-label={message('appView.layout.groupFor', { label: flowLabel(selectProps.item) })}
          value={parentId() ?? ''}
          onChange={(event) => {
            const target = event.currentTarget.value || undefined
            if (target === parentId()) return
            const index = target === undefined
              ? topLevelLayoutCount()
              : layoutGroups().find((group) => group.id === target)?.children.length ?? 0
            moveFlowItem(selectProps.item, target, index)
          }}
        >
          <option value="">{message('appView.layout.topLevel')}</option>
          <For each={groups()}>{(group) => <option value={group.id}>{group.title}</option>}</For>
        </select>
      </Show>
    )
  }

  const queueTargetOptions = createMemo(() => {
    docTick()
    const tab = activeTab()
    return tab === undefined ? [] : appViewQueueTargetOptions(tab.store.doc)
  })

  const QueuePlacement = (queueProps: {
    readonly flow: Extract<FlowItem, { kind: 'queue' }>
    readonly index: number
    readonly count: number
    readonly inGrid: boolean
  }) => {
    const stateId = `${draftScopeId}-queue-state-${createUniqueId()}`
    const queueKey = (): string => `${activeTabId()}:${queueProps.flow.item.id}`
    const resolved = createMemo(() => {
      docTick()
      const tab = activeTab()
      return tab === undefined
        ? { missing: queueProps.flow.item.targets }
        : appViewQueueScope(tab.store.doc, queueProps.flow.item.targets)
    })
    const scopeKey = (scope: ReturnType<typeof appViewQueueScope>['scope']): string | undefined =>
      scope?.kind !== 'partial'
        ? undefined
        : JSON.stringify(scope.targets.map((target) => [target.instancePath, target.node]).sort())
    const execution = createMemo(() => {
      executions()
      const tab = activeTab()
      return tab === undefined
        ? undefined
        : props.app.executionsForTab(tab).find((candidate) =>
            candidate.artifact?.scope.kind === 'partial' &&
            scopeKey(candidate.artifact.scope) === scopeKey(resolved().scope))
    })
    const state = (): string => {
      if (pendingQueues().has(queueKey())) return message('appView.queue.state.submitting')
      const status = execution()?.status
      if (status === 'queued') return message('appView.queue.state.queued')
      if (status === 'running') return message('appView.queue.state.running')
      if (status === 'completed') return message('appView.queue.state.completed')
      if (status === 'error' || status === 'interrupted') return message('appView.queue.state.failed')
      if (resolved().scope === undefined) return message('appView.queue.state.unavailable')
      return message('appView.queue.state.ready')
    }
    const run = async (): Promise<void> => {
      const tab = activeTab()
      const scope = resolved().scope
      if (tab === undefined || scope === undefined || frozen()) return
      const key = queueKey()
      setPendingQueues((current) => new Set([...current, key]))
      try {
        await props.app.queue(tab, scope)
      } finally {
        setPendingQueues((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    }
    const setTargets = (graphId: string, nodeId: string, selected: boolean): void => {
      const targets = selected
        ? [...queueProps.flow.item.targets, { graphId, nodeId }]
        : queueProps.flow.item.targets.filter((target) => target.graphId !== graphId || target.nodeId !== nodeId)
      dispatchLayout('app.layout.setQueue', {
        id: queueProps.flow.item.id,
        targets: targets.map((target) => ({ graphId: target.graphId, nodeId: target.nodeId })),
      })
    }
    return (
      <div class="app-layout-queue" data-testid="app-layout-queue">
        <Show when={arrange()}>
          <div class="app-layout-item-toolbar">
            <input
              class="app-layout-queue-label"
              data-testid="app-layout-queue-label"
              aria-label={message('appView.queue.label')}
              value={queueProps.flow.item.label}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
              onBlur={(event) => {
                const label = event.currentTarget.value.trim()
                if (label.length > 0 && label !== queueProps.flow.item.label) {
                  dispatchLayout('app.layout.setQueue', { id: queueProps.flow.item.id, label })
                }
              }}
            />
            <ParentSelect item={queueProps.flow} />
            <Show when={!queueProps.inGrid && !mobileEditing()}>
              <button class="app-view-tool" aria-label={message('appView.queue.moveUp', { label: queueProps.flow.item.label })} disabled={queueProps.index === 0} onClick={() => moveFlowItem(queueProps.flow, queueProps.flow.parentId, queueProps.index - 1)}><Icon icon={ArrowUp} /></button>
              <button class="app-view-tool" aria-label={message('appView.queue.moveDown', { label: queueProps.flow.item.label })} disabled={queueProps.index === layoutSiblingCount(queueProps.flow, queueProps.count) - 1} onClick={() => moveFlowItem(queueProps.flow, queueProps.flow.parentId, queueProps.index + 1)}><Icon icon={ArrowDown} /></button>
            </Show>
            <button class="app-view-tool" data-testid="app-layout-remove" aria-label={message('appView.queue.remove', { label: queueProps.flow.item.label })} onClick={() => dispatchLayout('app.layout.remove', { id: queueProps.flow.item.id })}><Icon icon={X} /></button>
          </div>
          <fieldset class="app-layout-queue-targets" data-testid="app-layout-queue-targets">
            <legend>{message('appView.queue.targets')}</legend>
            <For each={queueTargetOptions()}>{(option) => {
              const selected = () => queueProps.flow.item.targets.some((target) =>
                target.graphId === option.graphId && target.nodeId === option.nodeId)
              return <label>
                <input
                  type="checkbox"
                  checked={selected()}
                  disabled={selected() && queueProps.flow.item.targets.length === 1}
                  onChange={(event) => setTargets(option.graphId, option.nodeId, event.currentTarget.checked)}
                />
                <span>{option.label}</span>
                <small>{option.context}</small>
              </label>
            }}</For>
          </fieldset>
          <Show when={resolved().missing.length > 0}>
            <p class="app-view-stale" data-testid="app-layout-queue-stale" role="status">
              {message('appView.queue.staleTargets', { count: resolved().missing.length })}
            </p>
          </Show>
        </Show>
        <button
          type="button"
          class="app-view-queue app-layout-queue-button"
          data-testid="app-layout-queue-button"
          aria-describedby={stateId}
          disabled={frozen() || resolved().scope === undefined || pendingQueues().has(queueKey())}
          onClick={() => void run()}
        >
          <Icon icon={Play} /> {queueProps.flow.item.label}
        </button>
        <span id={stateId} class="app-layout-queue-state" data-testid="app-layout-queue-state" role="status" aria-live="polite">{state()}</span>
      </div>
    )
  }

  const MarkedText = (textProps: { readonly segment: ReturnType<typeof parseAppViewText>[number] }) => {
    const marked = () => textProps.segment.bold
      ? textProps.segment.italic
        ? <strong><em>{textProps.segment.text}</em></strong>
        : <strong>{textProps.segment.text}</strong>
      : textProps.segment.italic
        ? <em>{textProps.segment.text}</em>
        : textProps.segment.text
    return textProps.segment.href === undefined
      ? <>{marked()}</>
      : <a href={textProps.segment.href} target="_blank" rel="noopener noreferrer">{marked()}</a>
  }

  const TextContent = (textProps: { readonly item: AppLayoutTextItem }) => {
    const contents = () => <For each={parseAppViewText(textProps.item.text)}>
      {(segment) => <MarkedText segment={segment} />}
    </For>
    if (textProps.item.role === 'heading') {
      return <h2 class="app-layout-text heading" data-testid="app-layout-text">{contents()}</h2>
    }
    if (textProps.item.role === 'caption') {
      return <p class="app-layout-text caption" data-testid="app-layout-text">{contents()}</p>
    }
    return <p class="app-layout-text body" data-testid="app-layout-text">{contents()}</p>
  }

  const TextPlacement = (textProps: {
    readonly flow: Extract<FlowItem, { kind: 'text' }>
    readonly index: number
    readonly count: number
    readonly inGrid: boolean
  }) => {
    const [draft, setDraft] = createSolidSignal(textProps.flow.item.text)
    let editor: HTMLTextAreaElement | undefined
    const commitDraft = (): void => {
      if (draft() !== textProps.flow.item.text) {
        dispatchLayout('app.layout.setText', { id: textProps.flow.item.id, text: draft() })
      }
    }
    const wrap = (before: string, after: string, placeholder: string): void => {
      if (editor === undefined) return
      const start = editor.selectionStart
      const end = editor.selectionEnd
      const selected = draft().slice(start, end) || placeholder
      const next = `${draft().slice(0, start)}${before}${selected}${after}${draft().slice(end)}`
      setDraft(next)
      dispatchLayout('app.layout.setText', { id: textProps.flow.item.id, text: next })
      queueMicrotask(() => {
        editor?.focus()
        editor?.setSelectionRange(start + before.length, start + before.length + selected.length)
      })
    }
    return (
      <Show when={arrange()} fallback={<TextContent item={textProps.flow.item} />}>
        <div class="app-layout-text-editor" data-testid="app-layout-text-editor">
          <div class="app-layout-item-toolbar">
            <select
              class="app-layout-role"
              data-testid="app-layout-text-role"
              aria-label={message('appView.text.style')}
              value={textProps.flow.item.role}
              onChange={(event) => dispatchLayout('app.layout.setText', {
                id: textProps.flow.item.id,
                role: event.currentTarget.value,
              })}
            >
              <option value="heading">{message('appView.text.heading')}</option>
              <option value="body">{message('appView.text.body')}</option>
              <option value="caption">{message('appView.text.caption')}</option>
            </select>
            <ParentSelect item={textProps.flow} />
            <Show when={!textProps.inGrid && !mobileEditing()}>
              <button
                class="app-view-tool"
                data-testid="app-layout-move-up"
                aria-label={message('appView.text.moveUp')}
                disabled={textProps.index === 0}
                onClick={() => moveFlowItem(textProps.flow, textProps.flow.parentId, textProps.index - 1)}
              ><Icon icon={ArrowUp} /></button>
              <button
                class="app-view-tool"
                data-testid="app-layout-move-down"
                aria-label={message('appView.text.moveDown')}
                disabled={textProps.index === layoutSiblingCount(textProps.flow, textProps.count) - 1}
                onClick={() => moveFlowItem(textProps.flow, textProps.flow.parentId, textProps.index + 1)}
              ><Icon icon={ArrowDown} /></button>
            </Show>
            <button
              class="app-view-tool"
              data-testid="app-layout-remove"
              aria-label={message('appView.text.remove')}
              onClick={() => dispatchLayout('app.layout.remove', { id: textProps.flow.item.id })}
            ><Icon icon={X} /></button>
          </div>
          <div class="app-layout-format-toolbar" aria-label={message('appView.text.formatting')}>
            <button type="button" aria-label={message('appView.text.bold')} onPointerDown={(event) => event.preventDefault()} onClick={() => wrap('**', '**', message('appView.text.boldPlaceholder'))}>B</button>
            <button type="button" aria-label={message('appView.text.italic')} onPointerDown={(event) => event.preventDefault()} onClick={() => wrap('*', '*', message('appView.text.italicPlaceholder'))}><em>I</em></button>
            <button type="button" aria-label={message('appView.text.link')} onPointerDown={(event) => event.preventDefault()} onClick={() => wrap('[', '](https://)', message('appView.text.linkPlaceholder'))}>{message('appView.text.link')}</button>
            <span>{message('appView.text.formattingHint')}</span>
          </div>
          <textarea
            ref={editor}
            class="app-layout-text-input"
            data-testid="app-layout-text-input"
            aria-label={message('appView.text.content')}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                commitDraft()
              }
            }}
          />
        </div>
      </Show>
    )
  }

  const ControlPlacement = (controlProps: {
    readonly flow: Extract<FlowItem, { kind: 'control' }>
    readonly index: number
    readonly count: number
    readonly inGrid: boolean
  }) => {
    const row = () => controlProps.flow.row
    const liveRow = (): Extract<ParamRow, { kind: 'live' }> => row() as Extract<ParamRow, { kind: 'live' }>
    const accessibleLabelId = `app-view-control-${createUniqueId()}`
    const label = (): string => {
      const current = row()
      return current.kind === 'live' ? current.label : (current.entry.label ?? current.entry.inputId)
    }
    const layoutOwned = (): boolean => controlProps.flow.layoutId !== undefined
    const move = (delta: number): void => {
      if (layoutOwned()) {
        moveFlowItem(controlProps.flow, controlProps.flow.parentId, controlProps.index + delta)
      } else {
        const tab = activeTab()
        if (tab) props.app.dispatchTo(tab, moveExposedInvocation(row().entry, controlProps.flow.registryIndex + delta))
      }
    }
    const InlineControl = () => {
      const spec = () => liveRow().spec!
      const stringValue = (): string => {
        const value = liveRow().value
        return typeof value === 'string' ? value : ''
      }
      const numberValue = (): number | string | '' => {
        const value = liveRow().value
        return typeof value === 'number' || isCanonicalUnsafeInteger(value) ? value : ''
      }
      return (
        <Switch
          fallback={<AppViewStringInput
            value={stringValue()}
            multiline={spec().options['multiline'] === true}
            ariaLabelledBy={accessibleLabelId}
            onCommit={(value) => commit(liveRow(), value)}
          />}
        >
          <Match when={spec().widgetType === 'INT' || spec().widgetType === 'FLOAT'}>
            <ProductNumberInput
              class="app-view-control"
              testId="app-view-number"
              inputMode={spec().widgetType === 'INT' ? 'numeric' : 'decimal'}
              integer={spec().widgetType === 'INT'}
              ariaLabelledBy={accessibleLabelId}
              value={numberValue()}
              min={numberAttr(spec(), 'min')}
              max={numberAttr(spec(), 'max')}
              step={numberAttr(spec(), 'step') ?? (spec().widgetType === 'INT' ? 1 : 'any')}
              onCommit={(raw) => commitNumeric(liveRow(), raw, spec().widgetType as 'INT' | 'FLOAT')}
            />
          </Match>
          <Match when={spec().widgetType === 'BOOLEAN'}>
            <ProductCheckbox
              class="app-view-control"
              testId="app-view-boolean"
              ariaLabel={message('appView.control.toggle', { label: liveRow().label })}
              checked={liveRow().value === true}
              onChange={(checked) => commit(liveRow(), checked)}
            />
          </Match>
          <Match when={spec().widgetType === 'COLOR'}>
            <AppViewColorPicker
              value={stringValue()}
              draftScopeId={draftScopeId}
              label={liveRow().label}
              onCommit={(value) => commit(liveRow(), value)}
            />
          </Match>
          <Match when={spec().widgetType === 'COMBO'}>
            <ComboControl row={liveRow()} />
          </Match>
          <Match when={spec().widgetType === 'VIDEO_EDIT'}>
            <button type="button" aria-label={message('appView.control.editVideo', { label: liveRow().label })} onClick={() => openVideoEditor(liveRow())}>{message('appView.control.editTrimCrop')}</button>
          </Match>
        </Switch>
      )
    }
    return (
      <div
        classList={{
          'app-view-row': true,
          stale: row().kind === 'stale',
          dragging: dragged()?.key === rowKey(row().entry),
        }}
        data-testid="app-view-row"
        onDragOver={(event) => {
          if (dragged() && arrange() && !layoutOwned() && !controlProps.inGrid) {
            event.preventDefault()
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          }
        }}
        onDrop={(event) => {
          if (!dragged() || !arrange() || layoutOwned() || controlProps.inGrid) return
          event.preventDefault()
          dropAt(controlProps.flow.registryIndex)
        }}
      >
        <span id={accessibleLabelId} class="app-view-assistive-text">{label()}</span>
        <div class="app-view-row-head">
          <Show when={arrange() && !layoutOwned() && !controlProps.inGrid}>
            <span
              class="app-view-drag-handle"
              data-testid="app-view-drag-handle"
              aria-hidden="true"
              draggable={true}
              onDragStart={(event) => {
                const key = rowKey(row().entry)
                setDragged({
                  tabId: activeTabId(),
                  key,
                  entry: row().entry,
                  index: controlProps.flow.registryIndex,
                })
                event.dataTransfer?.setData('text/plain', key)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => setDragged(undefined)}
            ><Icon icon={GripVertical} /></span>
          </Show>
          <Show
            when={arrange() && renaming() === rowKey(row().entry)}
            fallback={
              <span class="app-view-label" data-testid="app-view-label">
                {label()}
                <Show when={row().kind === 'live'}>
                  <span class="app-view-context">{(row() as Extract<ParamRow, { kind: 'live' }>).context}</span>
                </Show>
              </span>
            }
          >
            <input
              class="app-view-rename"
              data-testid="app-view-rename"
              aria-label={message('appView.action.rename', { label: label() })}
              value={row().entry.label ?? label()}
              ref={(element) => queueMicrotask(() => { element.focus(); element.select() })}
              onKeyDown={(event) => {
                if (event.isComposing) return
                if (event.key === 'Enter') {
                  const trimmed = event.currentTarget.value.trim()
                  dispatchEntry('params.setLabel', row().entry, { label: trimmed.length > 0 ? trimmed : null })
                  setRenaming(undefined)
                } else if (event.key === 'Escape') setRenaming(undefined)
              }}
              onBlur={() => setRenaming(undefined)}
            />
          </Show>
          <Show when={arrange()}>
            <span class="app-view-row-tools">
              <ParentSelect item={controlProps.flow} />
              <Show when={!layoutOwned()}>
                <button
                  class="app-view-tool"
                  data-testid="app-layout-place"
                  aria-label={message('appView.action.placeInFlow', { label: label() })}
                  onClick={() => addAutomaticPlacement(controlProps.flow, undefined, topLevelLayoutCount())}
                ><Icon icon={Plus} /></button>
              </Show>
              <Show when={!controlProps.inGrid && !mobileEditing()}>
                <button
                  class="app-view-tool"
                  data-testid="app-view-move-up"
                  aria-label={message('appView.action.moveUp', { label: label() })}
                  disabled={(layoutOwned() ? controlProps.index : controlProps.flow.registryIndex) === 0}
                  onClick={() => move(-1)}
                ><Icon icon={ArrowUp} /></button>
                <button
                  class="app-view-tool"
                  data-testid="app-view-move-down"
                  aria-label={message('appView.action.moveDown', { label: label() })}
                  disabled={layoutOwned()
                    ? controlProps.index === layoutSiblingCount(controlProps.flow, controlProps.count) - 1
                    : controlProps.flow.registryIndex === rows().length - 1}
                  onClick={() => move(1)}
                ><Icon icon={ArrowDown} /></button>
              </Show>
              <button
                class="app-view-tool"
                data-testid="app-view-rename-start"
                aria-label={message('appView.action.rename', { label: label() })}
                onClick={() => setRenaming(rowKey(row().entry))}
              ><Icon icon={Pencil} /></button>
              <button
                class="app-view-tool"
                data-testid="app-view-remove"
                aria-label={message('appView.action.remove', { label: label() })}
                onClick={() => dispatchEntry('params.unexpose', row().entry)}
              ><Icon icon={X} /></button>
            </span>
          </Show>
        </div>
        <Show
          when={row().kind === 'live'}
          fallback={<p class="app-view-stale" data-testid="app-view-stale" role="status">{message('appView.state.unavailable', { reason: (row() as Extract<ParamRow, { kind: 'stale' }>).reason })}</p>}
        >
          <>
            <AppWidgetPreview row={liveRow()} registry={widgetRegistry()} />
            <Show
              when={editable(liveRow())}
              fallback={
                <p class="app-view-readonly" data-testid="app-view-readonly" tabindex="0" aria-label={`${display(liveRow().value)}. ${readOnlyHint(liveRow())}`} data-tooltip-label={readOnlyHint(liveRow())}>
                  {display(liveRow().value)}
                  <span class="app-view-hint">{readOnlyHint(liveRow())}</span>
                </p>
              }
            >
              <InlineControl />
            </Show>
            <Show when={errors().get(rowKey(row().entry))}>
              {(message) => <p class="app-view-error" data-testid="app-view-error" role="alert">{message()}</p>}
            </Show>
            <Show when={(() => {
              const remote = row().kind === 'live' ? remoteFor(row() as Extract<ParamRow, { kind: 'live' }>) : undefined
              return remote?.state === 'stale' || remote?.state === 'unavailable' ? remote.message : undefined
            })()}>
              {(message) => <p class="app-view-error" data-testid="app-view-remote-error" role="alert">{message()}</p>}
            </Show>
          </>
        </Show>
      </div>
    )
  }

  const PreviewPlacement = (previewProps: {
    readonly flow: Extract<FlowItem, { kind: 'preview' }>
    readonly index: number
    readonly count: number
    readonly inGrid: boolean
  }) => {
    const row = createMemo(() => renderedPreviewsByKey().get(previewProps.flow.previewKey)!)
    const accessibleLabelId = `app-view-preview-${createUniqueId()}`
    const output = () => {
      const current = row()
      const output = current.kind === 'live' ? current.surface.executedOutput : undefined
      return output !== undefined && (output.batch !== undefined || output.images.length > 0) ? output : undefined
    }
    const [viewer, setViewer] = createSolidSignal<{ readonly output: NodePreviewExecutionOutput; readonly provenance: ExecutionOutputProvenance }>()
    const pageImage = (delta: number) => {
      const selected = output()
      if (selected === undefined) return
      setOutputPages((current) => {
        const next = new Map(current)
        if (next.size >= 128 && !next.has(selected.key)) next.delete(next.keys().next().value!)
        next.set(selected.key, Math.max(0, Math.min(selected.index + delta, selected.count - 1)))
        return next
      })
    }
    const openImages = () => {
      const selected = output()
      const tab = activeTab()
      const execution = tab === undefined ? undefined : props.app.executionForTab(tab)
      if (selected !== undefined && execution !== undefined) setViewer({ output: selected, provenance: executionOutputProvenance(execution, props.app.backendFor(execution.ref.connection)) })
    }
    createEffect(() => {
      const current = viewer()
      if (current !== undefined && current.output.key !== output()?.key) setViewer(undefined)
    })
    const label = (): string => {
      const current = row()
      return current.kind === 'live' ? current.label : (current.entry.label ?? current.entry.nodeId)
    }
    const layoutOwned = (): boolean => previewProps.flow.layoutId !== undefined
    const move = (delta: number): void => {
      if (layoutOwned()) {
        moveFlowItem(previewProps.flow, previewProps.flow.parentId, previewProps.index + delta)
      } else {
        const tab = activeTab()
        if (tab) props.app.dispatchTo(tab, moveExposedPreviewInvocation(row().entry, previewProps.flow.registryIndex + delta))
      }
    }
    return (
      <div
        classList={{
          'app-view-row': true,
          'app-preview-row': true,
          stale: row().kind === 'stale',
          dragging: previewDragged()?.key === previewRowKey(row().entry),
        }}
        data-testid="app-preview-row"
        onDragOver={(event) => {
          if (previewDragged() && arrange() && !layoutOwned() && !previewProps.inGrid) {
            event.preventDefault()
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          }
        }}
        onDrop={(event) => {
          if (!previewDragged() || !arrange() || layoutOwned() || previewProps.inGrid) return
          event.preventDefault()
          dropPreviewAt(previewProps.flow.registryIndex)
        }}
      >
        <span id={accessibleLabelId} class="app-view-assistive-text">{label()}</span>
        <div class="app-view-row-head">
          <Show when={arrange() && !layoutOwned() && !previewProps.inGrid}>
            <span
              class="app-view-drag-handle"
              data-testid="app-preview-drag-handle"
              aria-hidden="true"
              draggable={true}
              onDragStart={(event) => {
                const key = previewRowKey(row().entry)
                setPreviewDragged({ tabId: activeTabId(), key, entry: row().entry, index: previewProps.flow.registryIndex })
                event.dataTransfer?.setData('text/plain', key)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => setPreviewDragged(undefined)}
            ><Icon icon={GripVertical} /></span>
          </Show>
          <Show
            when={arrange() && previewRenaming() === previewRowKey(row().entry)}
            fallback={
              <span class="app-view-label" data-testid="app-preview-label">
                {label()}
                <Show when={row().kind === 'live'}>
                  <span class="app-view-context">{(row() as Extract<RenderedPreviewRow, { kind: 'live' }>).context}</span>
                </Show>
              </span>
            }
          >
            <input
              class="app-view-rename"
              data-testid="app-preview-rename"
              aria-label={message('appView.action.rename', { label: label() })}
              value={row().entry.label ?? label()}
              ref={(element) => queueMicrotask(() => { element.focus(); element.select() })}
              onKeyDown={(event) => {
                if (event.isComposing) return
                if (event.key === 'Enter') {
                  const trimmed = event.currentTarget.value.trim()
                  dispatchPreviewEntry('previews.setLabel', row().entry, { label: trimmed.length > 0 ? trimmed : null })
                  setPreviewRenaming(undefined)
                } else if (event.key === 'Escape') setPreviewRenaming(undefined)
              }}
              onBlur={() => setPreviewRenaming(undefined)}
            />
          </Show>
          <Show when={arrange()}>
            <span class="app-view-row-tools">
              <ParentSelect item={previewProps.flow} />
              <Show when={!layoutOwned()}>
                <button
                  class="app-view-tool"
                  data-testid="app-layout-place"
                  aria-label={message('appView.action.placeInFlow', { label: label() })}
                  onClick={() => addAutomaticPlacement(previewProps.flow, undefined, topLevelLayoutCount())}
                ><Icon icon={Plus} /></button>
              </Show>
              <Show when={!previewProps.inGrid && !mobileEditing()}>
                <button class="app-view-tool" data-testid="app-preview-move-up" aria-label={message('appView.action.moveUp', { label: label() })} disabled={(layoutOwned() ? previewProps.index : previewProps.flow.registryIndex) === 0} onClick={() => move(-1)}><Icon icon={ArrowUp} /></button>
                <button class="app-view-tool" data-testid="app-preview-move-down" aria-label={message('appView.action.moveDown', { label: label() })} disabled={layoutOwned() ? previewProps.index === layoutSiblingCount(previewProps.flow, previewProps.count) - 1 : previewProps.flow.registryIndex === previewCandidates().length - 1} onClick={() => move(1)}><Icon icon={ArrowDown} /></button>
              </Show>
              <button class="app-view-tool" data-testid="app-preview-rename-start" aria-label={message('appView.action.rename', { label: label() })} onClick={() => setPreviewRenaming(previewRowKey(row().entry))}><Icon icon={Pencil} /></button>
              <button class="app-view-tool" data-testid="app-preview-remove" aria-label={message('appView.action.remove', { label: label() })} onClick={() => dispatchPreviewEntry('previews.unexpose', row().entry)}><Icon icon={X} /></button>
            </span>
          </Show>
        </div>
        <Show
          when={row().kind === 'live' ? row() as Extract<RenderedPreviewRow, { kind: 'live' }> : undefined}
          fallback={<p class="app-view-stale" data-testid="app-preview-stale" role="status">{message('appView.state.unavailable', { reason: (row() as Extract<RenderedPreviewRow, { kind: 'stale' }>).reason })}</p>}
        >
          {(live) => <>
            <AppPreviewSurface surface={live().surface} loader={previewLoader} ariaLabelledBy={accessibleLabelId}
              videoPreferences={(() => {
                docTick()
                return activeTab()?.store.doc.view.graphs[row().entry.graphId]?.nodes[row().entry.nodeId]?.video
              })()}
              onVideoPreferences={(video) => {
                const tab = activeTab()
                if (tab) props.app.dispatchTo(tab, { command: 'view.setNodeVideo', params: { ...row().entry, video } })
              }} />
            <Show when={live().surface.refusal}>{(reason) => <p class="image-preview-refusal" role="alert">{reason()}</p>}</Show>
          </>}
        </Show>
        <Show when={output()}>{(selected) =>
          <div class="app-image-controls" role="group" aria-label={message('appView.images.batchControls')} onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault(); event.stopPropagation(); pageImage(event.key === 'ArrowRight' ? 1 : -1)
            }
          }}>
            <button type="button" aria-label={message('appView.images.previous')} disabled={selected().index === 0} onClick={() => pageImage(-1)}>{message('appView.images.previousShort')}</button>
            <span aria-live="polite">{selected().index + 1} / {selected().count}</span>
            <button type="button" aria-label={message('appView.images.next')} disabled={selected().index >= selected().count - 1} onClick={() => pageImage(1)}>{message('appView.images.nextShort')}</button>
            <button type="button" onClick={openImages}>{message('appView.images.openViewer')}</button>
          </div>
        }</Show>
        <Show when={viewer()}>{(selected) => <ExecutedImageViewer images={selected().output.images} batch={selected().output.batch}
          initialIndex={selected().output.index} provenance={selected().provenance} onRequestClose={() => setViewer(undefined)} />}</Show>
      </div>
    )
  }

  const MissingPlacement = (missingProps: {
    readonly flow: Extract<FlowItem, { kind: 'missing' }>
    readonly index: number
    readonly count: number
    readonly inGrid: boolean
  }) => (
    <Show when={arrange()}>
      <div
        class="app-view-row stale app-layout-missing"
        data-testid="app-layout-missing"
      >
        <p class="app-view-stale" role="status">{message('appView.state.unavailable', { reason: missingProps.flow.reason })}</p>
        <div class="app-layout-item-toolbar">
          <ParentSelect item={missingProps.flow} />
          <Show when={!missingProps.inGrid && !mobileEditing()}>
            <button class="app-view-tool" aria-label={message('appView.missing.moveUp')} disabled={missingProps.index === 0} onClick={() => moveFlowItem(missingProps.flow, missingProps.flow.parentId, missingProps.index - 1)}><Icon icon={ArrowUp} /></button>
            <button class="app-view-tool" aria-label={message('appView.missing.moveDown')} disabled={missingProps.index === layoutSiblingCount(missingProps.flow, missingProps.count) - 1} onClick={() => moveFlowItem(missingProps.flow, missingProps.flow.parentId, missingProps.index + 1)}><Icon icon={ArrowDown} /></button>
          </Show>
          <button class="app-view-tool" data-testid="app-layout-remove" aria-label={message('appView.missing.remove')} onClick={() => dispatchLayout('app.layout.remove', { id: missingProps.flow.item.id })}><Icon icon={X} /></button>
        </div>
      </div>
    </Show>
  )

  const GroupPlacement = (groupProps: {
    readonly flow: Extract<FlowItem, { kind: 'group' }>
    readonly index: number
    readonly count: number
    readonly inGrid: boolean
  }) => {
    const childrenByKey = createMemo((): ReadonlyMap<string, FlowItem> =>
      new Map(groupProps.flow.children.map((child) => [flowItemKey(child), child])))
    const childKeys = createMemo((): readonly string[] => groupProps.flow.children.map(flowItemKey))
    return (
      <section
        class="app-layout-group"
        data-testid="app-layout-group"
        aria-label={message('appView.group.ariaLabel', { title: groupProps.flow.item.title })}
      >
        <div class="app-layout-group-header">
          <Show
            when={arrange()}
            fallback={<h2>{groupProps.flow.item.title}</h2>}
          >
            <input
              class="app-layout-group-title"
              data-testid="app-layout-group-title"
              aria-label={message('appView.group.title')}
              value={groupProps.flow.item.title}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
              onBlur={(event) => {
                const title = event.currentTarget.value.trim()
                if (title.length > 0 && title !== groupProps.flow.item.title) {
                  dispatchLayout('app.layout.setGroupTitle', { id: groupProps.flow.item.id, title })
                }
              }}
            />
            <div class="app-layout-item-toolbar">
              <Show when={!groupProps.inGrid && !mobileEditing()}>
                <button class="app-view-tool" aria-label={message('appView.group.moveUp', { title: groupProps.flow.item.title })} disabled={groupProps.index === 0} onClick={() => moveFlowItem(groupProps.flow, undefined, groupProps.index - 1)}><Icon icon={ArrowUp} /></button>
                <button class="app-view-tool" aria-label={message('appView.group.moveDown', { title: groupProps.flow.item.title })} disabled={groupProps.index === layoutSiblingCount(groupProps.flow, groupProps.count) - 1} onClick={() => moveFlowItem(groupProps.flow, undefined, groupProps.index + 1)}><Icon icon={ArrowDown} /></button>
              </Show>
              <button class="app-view-tool" data-testid="app-layout-remove" aria-label={message('appView.group.remove', { title: groupProps.flow.item.title })} onClick={() => dispatchLayout('app.layout.remove', { id: groupProps.flow.item.id })}><Icon icon={X} /></button>
            </div>
          </Show>
        </div>
        <div class="app-layout-group-children" role="list">
          <For each={childKeys()}>
            {(key, index) => {
              const child = () => childrenByKey().get(key)!
              return (
                <div
                  class="app-layout-group-child"
                  role="listitem"
                  aria-label={child().kind === 'missing' ? flowLabel(child()) : undefined}
                >
                  <FlowPlacement item={child()} index={index()} count={groupProps.flow.children.length} />
                </div>
              )
            }}
          </For>
          <Show when={arrange() && groupProps.flow.children.length === 0}>
            <p class="app-layout-group-empty" role="listitem">{message('appView.group.empty')}</p>
          </Show>
        </div>
      </section>
    )
  }

  function FlowPlacement(flowProps: {
    readonly item: FlowItem
    readonly index: number
    readonly count: number
    readonly inGrid?: boolean
  }) {
    return (
      <Switch>
        <Match when={flowProps.item.kind === 'control'}>
          <ControlPlacement flow={flowProps.item as Extract<FlowItem, { kind: 'control' }>} index={flowProps.index} count={flowProps.count} inGrid={flowProps.inGrid === true} />
        </Match>
        <Match when={flowProps.item.kind === 'preview'}>
          <PreviewPlacement flow={flowProps.item as Extract<FlowItem, { kind: 'preview' }>} index={flowProps.index} count={flowProps.count} inGrid={flowProps.inGrid === true} />
        </Match>
        <Match when={flowProps.item.kind === 'queue'}>
          <QueuePlacement flow={flowProps.item as Extract<FlowItem, { kind: 'queue' }>} index={flowProps.index} count={flowProps.count} inGrid={flowProps.inGrid === true} />
        </Match>
        <Match when={flowProps.item.kind === 'text'}>
          <TextPlacement flow={flowProps.item as Extract<FlowItem, { kind: 'text' }>} index={flowProps.index} count={flowProps.count} inGrid={flowProps.inGrid === true} />
        </Match>
        <Match when={flowProps.item.kind === 'missing'}>
          <MissingPlacement flow={flowProps.item as Extract<FlowItem, { kind: 'missing' }>} index={flowProps.index} count={flowProps.count} inGrid={flowProps.inGrid === true} />
        </Match>
        <Match when={flowProps.item.kind === 'group'}>
          <GroupPlacement flow={flowProps.item as Extract<FlowItem, { kind: 'group' }>} index={flowProps.index} count={flowProps.count} inGrid={flowProps.inGrid === true} />
        </Match>
      </Switch>
    )
  }

  const GridPlacement = (gridProps: { readonly item: GridFlowItem; readonly index: number }) => {
    const id = () => layoutIdOf(gridProps.item)!
    const pending = () => gridGesture()?.id === id()
    return (
      <div
        classList={{ 'app-layout-grid-placement': true, pending: pending() }}
        data-testid="app-layout-grid-placement"
        role="listitem"
        data-app-grid-id={id()}
        data-grid-x={gridProps.item.grid.x}
        data-grid-y={gridProps.item.grid.y}
        data-grid-w={gridProps.item.grid.w}
        data-grid-h={gridProps.item.grid.h}
        style={gridStyle(gridProps.item.grid)}
        tabindex={arrange() ? 0 : undefined}
        aria-label={message('appView.grid.placement', { label: flowLabel(gridProps.item) })}
        aria-description={arrange()
          ? message('appView.grid.instructions')
          : undefined}
        aria-keyshortcuts={arrange()
          ? 'ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Escape'
          : undefined}
        onKeyDown={(event) => gridKeyDown(event, gridProps.item)}
        onKeyUp={(event) => gridKeyUp(event, gridProps.item)}
      >
        <Show when={arrange()}>
          <button
            type="button"
            class="app-layout-grid-drag"
            data-testid="app-layout-grid-drag"
            data-grid-keyboard-target="move"
            aria-label={message('appView.grid.move', { label: flowLabel(gridProps.item) })}
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Escape"
            tabindex={0}
            onPointerDown={(event) => beginGridPointer(event, gridProps.item, 'move')}
            onKeyDown={(event) => gridKeyDown(event, gridProps.item, 'move')}
            onKeyUp={(event) => gridKeyUp(event, gridProps.item, 'move')}
          ><Icon icon={GripVertical} /></button>
          <button
            type="button"
            class="app-layout-grid-flow"
            data-testid="app-layout-grid-clear"
            aria-label={message('appView.grid.returnToFlow', { label: flowLabel(gridProps.item) })}
            tabindex={0}
            onClick={() => dispatchLayout('app.layout.setGrid', { id: id(), grid: null })}
          >{message('appView.layout.flow')}</button>
          <button type="button" class="app-layout-grid-resize right" data-testid="app-layout-grid-resize-right" data-grid-keyboard-target="right" aria-label={message('appView.grid.resizeWidth', { label: flowLabel(gridProps.item) })} aria-keyshortcuts="ArrowLeft ArrowRight Escape" tabindex={0} onPointerDown={(event) => beginGridPointer(event, gridProps.item, 'right')} onKeyDown={(event) => gridKeyDown(event, gridProps.item, 'right')} onKeyUp={(event) => gridKeyUp(event, gridProps.item, 'right')} />
          <button type="button" class="app-layout-grid-resize bottom" data-testid="app-layout-grid-resize-bottom" data-grid-keyboard-target="bottom" aria-label={message('appView.grid.resizeHeight', { label: flowLabel(gridProps.item) })} aria-keyshortcuts="ArrowUp ArrowDown Escape" tabindex={0} onPointerDown={(event) => beginGridPointer(event, gridProps.item, 'bottom')} onKeyDown={(event) => gridKeyDown(event, gridProps.item, 'bottom')} onKeyUp={(event) => gridKeyUp(event, gridProps.item, 'bottom')} />
          <button type="button" class="app-layout-grid-resize corner" data-testid="app-layout-grid-resize-corner" data-grid-keyboard-target="corner" aria-label={message('appView.grid.resize', { label: flowLabel(gridProps.item) })} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Escape" tabindex={0} onPointerDown={(event) => beginGridPointer(event, gridProps.item, 'corner')} onKeyDown={(event) => gridKeyDown(event, gridProps.item, 'corner')} onKeyUp={(event) => gridKeyUp(event, gridProps.item, 'corner')} />
        </Show>
        <FlowPlacement item={gridProps.item} index={gridProps.index} count={gridItems().length} inGrid />
      </div>
    )
  }

  const gridGestureAnnouncement = (): string => {
    const gesture = gridGesture()
    if (gesture === undefined) return ''
    const item = gridItems().find((candidate) => layoutIdOf(candidate) === gesture.id)
    const label = item === undefined ? message('appView.layout.placement') : flowLabel(item)
    return message('appView.grid.position', { label, column: gesture.pending.x + 1, row: gesture.pending.y + 1, width: gesture.pending.w, height: gesture.pending.h })
  }

  const [mobileDragged, setMobileDragged] = createSolidSignal<{ readonly id: string; readonly index: number }>()
  const moveMobile = (id: string, index: number): void => {
    dispatchLayout('app.layout.moveMobile', { id, index })
  }
  const focusMobilePlacement = (id: string): void => {
    queueMicrotask(() => {
      for (const element of document.querySelectorAll<HTMLElement>('[data-mobile-id]')) {
        if (element.dataset['mobileId'] === id) {
          element.focus()
          break
        }
      }
    })
  }
  const MobilePlacement = (mobileProps: { readonly item: FlowItem; readonly index: number }) => {
    const id = (): string | undefined => layoutIdOf(mobileProps.item)
    const movable = (): boolean => mobileEditing() && id() !== undefined
    return (
      <div
        classList={{
          'app-layout-mobile-placement': true,
          dragging: mobileDragged()?.id === id(),
          pending: mobileKeyboardGesture()?.id === id(),
        }}
        data-testid="app-layout-mobile-placement"
        role="listitem"
        data-mobile-id={id()}
        tabindex={movable() ? 0 : undefined}
        aria-label={movable() ? message('appView.mobile.placement', { label: flowLabel(mobileProps.item) }) : undefined}
        aria-description={movable() ? message('appView.mobile.instructions') : undefined}
        aria-keyshortcuts={movable() ? 'ArrowUp ArrowDown Escape' : undefined}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || id() === undefined) return
          const placementId = id()!
          if (event.key === 'Escape') {
            if (mobileKeyboardGesture()?.id === placementId) {
              event.preventDefault()
              setMobileKeyboardGesture(undefined)
              focusMobilePlacement(placementId)
            }
            return
          }
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          const existing = mobileKeyboardGesture()
          const start = existing?.id === placementId
            ? existing.start
            : mobileItems().findIndex((item) => layoutIdOf(item) === placementId)
          const current = existing?.id === placementId ? existing.pending : mobileProps.index
          const delta = event.key === 'ArrowUp' ? -1 : 1
          const pending = Math.max(0, Math.min(mobileItems().length - 1, current + delta))
          if (pending !== current || existing?.id === placementId) {
            setMobileKeyboardGesture({ id: placementId, start, pending })
          }
        }}
        onKeyUp={(event) => {
          if (event.target !== event.currentTarget || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
          const placementId = id()
          const completed = mobileKeyboardGesture()
          if (placementId === undefined || completed?.id !== placementId) return
          event.preventDefault()
          setMobileKeyboardGesture(undefined)
          if (completed.pending !== completed.start) {
            moveMobile(placementId, completed.pending)
          }
          focusMobilePlacement(placementId)
        }}
        onDragOver={(event) => {
          if (mobileDragged() === undefined) return
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          const source = mobileDragged()
          setMobileDragged(undefined)
          if (source === undefined || source.index === mobileProps.index) return
          event.preventDefault()
          moveMobile(source.id, mobileProps.index)
        }}
      >
        <Show when={movable()}>
          <div class="app-layout-mobile-toolbar">
            <span
              class="app-view-drag-handle"
              data-testid="app-layout-mobile-drag"
              aria-hidden="true"
              draggable={true}
              onDragStart={(event) => {
                const placementId = id()!
                setMobileKeyboardGesture(undefined)
                setMobileDragged({ id: placementId, index: mobileProps.index })
                event.dataTransfer?.setData('text/plain', placementId)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => setMobileDragged(undefined)}
            ><Icon icon={GripVertical} /></span>
            <span>{flowLabel(mobileProps.item)}</span>
            <button
              type="button"
              class="app-view-tool"
              data-testid="app-layout-mobile-up"
              aria-label={message('appView.mobile.moveUp', { label: flowLabel(mobileProps.item) })}
              disabled={mobileProps.index === 0}
              onClick={() => moveMobile(id()!, mobileProps.index - 1)}
            ><Icon icon={ArrowUp} /></button>
            <button
              type="button"
              class="app-view-tool"
              data-testid="app-layout-mobile-down"
              aria-label={message('appView.mobile.moveDown', { label: flowLabel(mobileProps.item) })}
              disabled={mobileProps.index === mobileItems().length - 1}
              onClick={() => moveMobile(id()!, mobileProps.index + 1)}
            ><Icon icon={ArrowDown} /></button>
          </div>
        </Show>
        <FlowPlacement item={mobileProps.item} index={mobileProps.index} count={mobileItems().length} />
      </div>
    )
  }

  const mobileGestureAnnouncement = (): string => {
    const gesture = mobileKeyboardGesture()
    if (gesture === undefined) return ''
    const item = mobileItems().find((candidate) => layoutIdOf(candidate) === gesture.id)
    const label = item === undefined ? message('appView.layout.placement') : flowLabel(item)
    return message('appView.mobile.position', { label, position: gesture.pending + 1, count: mobileItems().length })
  }

  return (
    <div
      ref={appViewElement}
      classList={{
        'app-view': true,
        'has-grid': !mobilePresentation() && gridItems().length > 0,
        'mobile-presentation': mobilePresentation(),
        'mobile-arrange': mobileEditing(),
      }}
      data-testid="app-view"
      data-app-breakpoint={mobilePresentation() ? 'mobile' : 'desktop'}
      onScroll={(event) => {
        const tab = activeTab()
        if (tab) props.app.setAppScrollTop(tab.id, event.currentTarget.scrollTop)
      }}
    >
      <header class="app-view-header">
        <div class="app-view-titles">
          <h1 class="app-view-title">{activeTab()?.store.doc.meta?.title ?? activeTab()?.title ?? message('appView.workflow')}</h1>
          <Show when={activeTab()?.store.doc.meta?.description}>
            {(description) => <p class="app-view-description">{description()}</p>}
          </Show>
        </div>
        <button
          class="app-view-arrange-toggle"
          data-testid="app-view-arrange-toggle"
          aria-pressed={arrange()}
          disabled={frozen() || !activeTab()}
          onClick={() => {
            const tab = activeTab()
            if (tab) props.app.setTabAppArrange(tab.id, !arrange())
          }}
        >
          <Icon icon={SlidersHorizontal} /> {message('appView.arrange')}
        </button>
        <Show when={!documentLayout()?.desktop.items.some((item) => item.kind === 'queue')}>
          <button
            class="app-view-queue"
            data-testid="app-view-queue"
            disabled={frozen() || !activeTab()}
            onClick={() => {
              const tab = activeTab()
              if (tab) void props.app.queue(tab)
            }}
          >
            <Icon icon={Play} /> {message('appView.queue')}
          </button>
        </Show>
      </header>
      <Show when={arrange()}>
        <div class="app-layout-arrange-controls" data-testid="app-layout-arrange-controls">
          <div class="app-layout-breakpoint-toggle" role="group" aria-label={message('appView.breakpoint.label')}>
            <button
              type="button"
              data-testid="app-layout-breakpoint-desktop"
              aria-pressed={arrangeBreakpoint() === 'desktop'}
              onPointerDown={preservePortalDraftFocus}
              onClick={() => requestArrangeBreakpoint('desktop')}
            >{message('appView.breakpoint.desktop')}</button>
            <button
              type="button"
              data-testid="app-layout-breakpoint-mobile"
              aria-pressed={arrangeBreakpoint() === 'mobile'}
              onPointerDown={preservePortalDraftFocus}
              onClick={() => requestArrangeBreakpoint('mobile')}
            >{message('appView.breakpoint.mobile')}</button>
          </div>
          <Show when={documentLayout()?.mobile.customized === true}>
            <button
              type="button"
              class="app-layout-reset-mobile"
              data-testid="app-layout-reset-mobile"
              onClick={() => dispatchLayout('app.layout.resetMobile', {})}
            >{message('appView.breakpoint.resetAutomatic')}</button>
          </Show>
        </div>
        <div class="app-layout-palette" data-testid="app-layout-palette">
          <span>{message('appView.content.add')}</span>
          <button
            type="button"
            data-testid="app-layout-add-text"
            onClick={() => dispatchLayout('app.layout.add', {
              item: { id: freshLayoutId('text'), kind: 'text', role: 'body', text: message('appView.content.defaultInstructions') },
            })}
          ><Icon icon={Plus} /> {message('appView.content.text')}</button>
          <button
            type="button"
            data-testid="app-layout-add-group"
            onClick={() => dispatchLayout('app.layout.add', {
              item: { id: freshLayoutId('group'), kind: 'group', title: message('appView.content.defaultGroup'), children: [] },
            })}
          ><Icon icon={FolderPlus} /> {message('appView.content.group')}</button>
          <button
            type="button"
            data-testid="app-layout-add-queue"
            disabled={queueTargetOptions().length === 0}
            onClick={() => {
              const target = queueTargetOptions()[0]
              if (target === undefined) return
              dispatchLayout('app.layout.add', {
                item: {
                  id: freshLayoutId('queue'),
                  kind: 'queue',
                  label: message('appView.queue.defaultLabel'),
                  targets: [{ graphId: target.graphId, nodeId: target.nodeId }],
                },
              })
            }}
          ><Icon icon={Play} /> {message('appView.content.queue')}</button>
        </div>
      </Show>
      <Show
        when={flowItems().length > 0}
        fallback={
          <p class="app-view-empty" data-testid="app-view-empty">
            {message('appView.empty')}
          </p>
        }
      >
        <div class="app-view-rows">
          <Show
            when={mobilePresentation()}
            fallback={
              <>
                <Show when={gridItems().length > 0}>
                  <div
                    classList={{ 'app-layout-grid': true, arrange: arrange() }}
                    data-testid="app-layout-grid"
                    role="list"
                    aria-label={message('appView.grid.placements')}
                  >
                    <For each={gridItemKeys()}>
                      {(key, index) => {
                        const item = () => gridItemsByKey().get(key)!
                        return <GridPlacement item={item()} index={index()} />
                      }}
                    </For>
                    <Show when={gridGesture()} keyed>
                      {(gesture) => (
                        <div
                          class="app-layout-grid-ghost"
                          data-testid="app-layout-grid-ghost"
                          style={gridStyle(gesture.pending)}
                          aria-hidden="true"
                        />
                      )}
                    </Show>
                  </div>
                  <p class="app-view-assistive-text" role="status" aria-live="polite" aria-atomic="true">
                    {gridGestureAnnouncement()}
                  </p>
                </Show>
                <Show when={fallbackItems().length > 0}>
                  <div class="app-layout-flow" data-testid="app-layout-flow" role="list" aria-label={message('appView.flow.placements')}>
                    <For each={fallbackItemKeys()}>
                      {(key, index) => {
                        const item = () => fallbackItemsByKey().get(key)!
                        const topLevel = (): boolean => {
                          const current = item()
                          return current.kind === 'group' || current.parentId === undefined
                        }
                        return (
                          <div
                            class="app-layout-flow-placement"
                            role="listitem"
                            aria-label={item().kind === 'missing' ? flowLabel(item()) : undefined}
                          >
                            <Show when={arrange() && topLevel()}>
                              <div class="app-layout-flow-toolbar">
                                <button
                                  type="button"
                                  data-testid="app-layout-grid-place"
                                  aria-label={message('appView.grid.place', { label: flowLabel(item()) })}
                                  onClick={() => placeInGrid(item())}
                                >{message('appView.grid.placeShort')}</button>
                              </div>
                            </Show>
                            <FlowPlacement item={item()} index={index()} count={fallbackItems().length} />
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </>
            }
          >
            <div class="app-layout-mobile" data-testid="app-layout-mobile" role="list" aria-label={message('appView.mobile.placements')}>
              <For each={mobileItemKeys()}>
                {(key, index) => {
                  const item = () => mobileItemsByKey().get(key)!
                  return <MobilePlacement item={item()} index={index()} />
                }}
              </For>
            </div>
            <p class="app-view-assistive-text" role="status" aria-live="polite" aria-atomic="true">
              {mobileGestureAnnouncement()}
            </p>
          </Show>
        </div>
      </Show>
      <Show when={videoEditor()} keyed>{(ed) => <WidgetEditor app={props.app} ed={ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => setVideoEditor(undefined)} />}</Show>
    </div>
  )
}
