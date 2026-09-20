/**
 * Dinkster shell: tab bar, canvas, queue rail, outputs, problems, status.
 * It uses the real signal store and backend loop.
 */

import { createEffect, createMemo, createSignal as createSolidSignal, For, Index, onCleanup, onMount, Show } from 'solid-js'
import { activeLocale, canonicalJson, diag, documentIdentityOf, documentResolver, executionKey, sha256Hex, t, type CollectionEntry, type Diagnostic, type ExtensionHostUiContributionV1, type HostUiProviderV1, type Json, type MenuItem, type MessageParams, type ReadonlySignal, type ResolvedMenuGroup } from '@dinkster/core'
import type { AssetDtoV1WireContract, ExecutionState } from '@dinkster/client'
import Database from 'lucide-solid/icons/database'
import FolderOpen from 'lucide-solid/icons/folder-open'
import HardDrive from 'lucide-solid/icons/hard-drive'
import Images from 'lucide-solid/icons/images'
import Library from 'lucide-solid/icons/library'
import BookOpen from 'lucide-solid/icons/book-open'
import ScrollText from 'lucide-solid/icons/scroll-text'
import Server from 'lucide-solid/icons/server'
import Terminal from 'lucide-solid/icons/terminal'
import Settings from 'lucide-solid/icons/settings'
import Users from 'lucide-solid/icons/users'
import Network from 'lucide-solid/icons/network'
import { currentGraphId, editedSubgraphDefinition, GLOBAL_PROBLEMS_OWNER, visibleProblems, type AppState, type Backend, type CollabTabState, type Tab } from './app-state.js'
import { formatWorkflowDeepLink, resolveDeepLinkBackend } from './connection-profiles.js'
import { ActivityLog } from './ActivityLog.js'
import { BoundaryPanel } from './BoundaryPanel.js'
import { CanvasHost, CanvasViewControls, coreOccurrencePlanner } from './CanvasHost.js'
import { ContextMenu } from './ContextMenu.js'
import { historySource, packsSource, runIdOfEntry, runsSource, templatesSource, workflowsSource } from './collections.js'
import { ExecutionActivityCard } from './ExecutionActivityCard.js'
import { ExecutionLogPanel } from './ExecutionLogPanel.js'
import { MediaDiagnostics, MediaValueInspector } from './MediaValueInspector.js'
import { mediaMetadataOf } from './media-metadata.js'
import { resolveNodeOccurrence } from './problem-display.js'
import { Icon } from './Icon.js'
import { LibraryPanel } from './LibraryPanel.js'
import { APP_EDITOR_KIND, CURVE_EDITOR_KIND, GLSL_EDITOR_KIND, GRAPH_EDITOR_KIND, IMAGE_EDITOR_KIND, type EditorHostContext } from './editors.js'
import { AppView } from './AppView.js'
import { ImageEditor } from './ImageEditor.js'
import { ImageDocumentWorkspace } from './ImageDocumentWorkspace.js'
import { isLayerDocumentType, type GraphImageDocumentRequest } from './image-document-graph.js'
import { CurveEditor } from './CurveEditor.js'
import { GlslEditor } from './GlslEditor.js'
import { ProductActionFooter } from './ProductForm.js'
import { ExtensionsPanel } from './ExtensionsPanel.js'
import { beginRegionResize, REGION_SIZE_BOUNDS, type ShellRegion } from './shell-layout.js'
import { SurfacePanel } from './SurfacePanel.js'
import { useSignal } from './solid-adapter.js'
import { comboFromEvent, isNativeTextScopeTarget, shortcutSuppressed, type CommandRegistry, type KeybindingRegistry } from './settings.js'
import { SettingsDialog } from './SettingsDialog.js'
import { CustomizeLayoutDialog, type LayoutVisibilityItem } from './CustomizeLayoutDialog.js'
import { SubgraphDefinitionsDialog } from './SubgraphDefinitionsDialog.js'
import { AssetConsentDialog } from './AssetConsentDialog.js'
import { AssetsBody } from './AssetsBody.js'
import { CollabPanel } from './CollabPanel.js'
import { ImportAssetResolutionDialog } from './ImportAssetResolutionDialog.js'
import { ModalSurface } from './ModalSurface.js'
import { attachDomTooltips, resolveCanvasTooltip, TooltipController, type DomTooltipTarget } from './tooltips.js'
import { activateProblem, ProblemsPanel } from './ProblemsPanel.js'
import { ContextPanel } from './ContextPanel.js'
import { ProductSelect } from './ProductSelect.js'
import { BackendsPanel } from './BackendsPanel.js'
import { DesktopManagementDialog, type DesktopMountConnection } from './DesktopManagementDialog.js'
import { ProjectsDialog } from './ProjectsDialog.js'
import { activeProjectId, DEFAULT_PROJECT_ID, PROJECT_URL_PARAM } from './projects.js'
import {
  desktopBridge,
  type DesktopPanelPlacement,
  type DesktopWindowContext,
  type DesktopWindowLayout,
} from './desktop-bridge.js'
import { coordinateBrowserWindows } from './browser-window-layout.js'
import { MemoryPanel } from './MemoryPanel.js'
import { P2PPanel } from './P2PPanel.js'
import { LearnPanel } from './help/LearnPanel.js'
import { NodeHelpPanel } from './help/NodeHelpPanel.js'
import { useAppMessage } from './locale.js'
import { UniversalSearch, UniversalSearchTrigger } from './UniversalSearch.js'
import { registerCoreSearchProviders } from './universal-search.js'
import { HostUiProviderHost } from './host-ui.js'
import {
  activePanelIndicator,
  ActivityBarButton,
  CustomizeLayoutButton,
  DockZoneHost,
  FloatingPanelHost,
  PanelIndicatorBadge,
  ShellRegionIcon,
  ShellResizeHandle,
  TransientStatus,
} from './ShellChrome.js'
import { PanelDragOverlay } from './PanelDragOverlay.js'
import { TabDragGhost } from './TabDragGhost.js'
import { canDockInZone, DOCK_ZONE_IDS, type DockZoneId } from './dock-layout.js'
import { movePanel, panelDockZone, returnPanelToZone, setPanelOpen, zoneSectionsView, zoneTabsView } from './panel-location.js'
import { aggregatePanelIndicators, type PanelIndicator, type PanelPlacement } from './panels.js'
import {
  beginPanelDragModel,
  createPanelDragSnapshot,
  movePanelDragModel,
  panelDragPointerDisposition,
  panelDragReleaseAction,
  rollbackPanelDragModel,
  type PanelDragModel,
  type PanelDragRect,
  type PanelDragSectionGeometry,
  type PanelDragVisibleZoneGeometry,
} from './panel-drag.js'
import { WorkflowTabs, workflowTabDomId } from './WorkflowTabs.js'
import { WorkflowQueueControl } from './WorkflowQueueControl.js'
import { ExecutedImageFacts, ExecutedImageViewer, executionOutputProvenance, type ExecutionOutputProvenance } from './ExecutedImageViewer.js'
import { executedImageInventory, executedImageLabel } from './executed-image-inventory.js'
import {
  beginTabDragModel,
  moveTabDragModel,
  rollbackTabDragModel,
  tabDragPointerDisposition,
  tabDragReleaseAction,
  type TabDragSlot,
} from './tab-reorder.js'
import {
  dissolveGroup,
  findGroup,
  focusGroup,
  layoutGroups,
  moveTabToGroup,
  repairEditorLayout,
  setActiveTab,
  setGroupTabOrder,
  setSplitRatioAt,
  singleGroupLayout,
  splitGroup,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  type EditorGroup,
  type EditorLayout,
  type SplitPath,
} from './editor-layout.js'
import {
  computeSplitRects,
  splitDropOperation,
  splitDropPreviewRect,
  splitDropTargetAt,
  splitRatioAtPointer,
  type SplitDividerRect,
  type SplitDropTarget,
  type SplitRect,
} from './editor-split-rects.js'

/**
 * Apply a reordering of one group's tabs to the global tab list: the
 * group's members take their new relative order while every other tab
 * keeps its position. With a single group this is a full reorder.
 */
const applySubsetOrder = <T extends { readonly id: string }>(
  all: readonly T[],
  subset: readonly string[],
): readonly T[] => {
  const byId = new Map(all.map((item) => [item.id, item]))
  const member = new Set(subset)
  const queue = subset.filter((id) => byId.has(id))
  let next = 0
  return all.map((item) => (member.has(item.id) ? byId.get(queue[next++]!)! : item))
}

/**
 * The layout a pane drop would produce: center zone moves the tab into
 * the target group, edge zones split it. Returns the same layout object
 * when the drop would change nothing (so callers can detect refusal).
 */
const splitDropNextLayout = (layout: EditorLayout, target: SplitDropTarget, tabId: string): EditorLayout => {
  const operation = splitDropOperation(target.zone)
  if (operation.kind === 'move') {
    const source = layoutGroups(layout.root).find((group) => group.tabIds.includes(tabId))
    if (source?.id === target.groupId) return layout
    return moveTabToGroup(layout, tabId, target.groupId)
  }
  return splitGroup(layout, target.groupId, operation.direction, tabId, operation.position)
}

const APP_MENU_COMMAND_GROUPS = [
  { group: '10-open', ids: ['workflow.open', 'workflow.importFile'] },
  { group: '20-write', ids: ['workflow.save', 'workflow.export'] },
  { group: '30-edit', ids: ['edit.undo', 'edit.redo', 'edit.selectAll', 'subgraph.manageDefinitions'] },
  { group: '40-view', ids: ['view.zoomIn', 'view.zoomOut', 'view.fitSelection', 'layout.customize'] },
  { group: '50-settings', ids: ['settings.open'] },
] as const

export function DinksterAppMenu(props: {
  commands: CommandRegistry
  keybindings: KeybindingRegistry
  /** Signals that invalidate ContextMenu's deliberate per-open snapshot. */
  invalidationSignals?: () => readonly ReadonlySignal<unknown>[]
}) {
  const [open, setOpen] = createSolidSignal(false)
  const [anchor, setAnchor] = createSolidSignal({ x: 0, y: 0 })
  let root!: HTMLDivElement
  let button!: HTMLButtonElement
  let stopInvalidation = (): void => {}
  const close = (restoreFocus = false): void => {
    stopInvalidation()
    stopInvalidation = () => {}
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => button.focus())
  }
  const groups = (): readonly ResolvedMenuGroup[] => APP_MENU_COMMAND_GROUPS.flatMap(({ group, ids }) => {
    const items = ids.flatMap((id): MenuItem[] => {
      const command = props.commands.get(id)
      const hint = props.keybindings.combo(id)
      return command ? [{
        id,
        label: command.label,
        ...(hint ? { hint } : {}),
        action: { kind: 'host', action: id },
        ...(command.enabled?.() === false ? { disabled: true } : {}),
      }] : []
    })
    return items.length > 0 ? [{ group, items }] : []
  })
  const show = (): void => {
    const rect = button.getBoundingClientRect()
    setAnchor({ x: rect.left, y: rect.bottom + 2 })
    setOpen(true)
    const unsubscribes = props.invalidationSignals?.().map((signal) => signal.subscribe(() => close())) ?? []
    stopInvalidation = () => { for (const unsubscribe of unsubscribes) unsubscribe() }
  }
  const toggle = (): void => open() ? close() : show()
  const invoke = (item: MenuItem): void => {
    const command = props.commands.get(item.id)
    if (!command || command.enabled?.() === false) return
    // The menu itself is transient. Put focus on its persistent trigger
    // before a command can open a native modal so dialog close restoration
    // has a connected element to return to.
    close()
    button.focus()
    command.run()
  }
  onMount(() => {
    const outside = (event: PointerEvent): void => {
      if (open() && event.target instanceof Node && !root.contains(event.target)) close()
    }
    window.addEventListener('pointerdown', outside, true)
    onCleanup(() => {
      stopInvalidation()
      window.removeEventListener('pointerdown', outside, true)
    })
  })
  return (
    <div class="app-menu" ref={root}>
      <button
        ref={button}
        class="brand app-menu-button"
        data-testid="dinkster-menu-button"
        aria-haspopup="menu"
        aria-expanded={open()}
        onPointerDown={(event) => { if (open()) event.preventDefault() }}
        onClick={toggle}
        onKeyDown={(event) => {
          if (!open() && event.key === 'ArrowDown') {
            event.preventDefault()
            show()
          } else if (open() && event.key === 'Escape') {
            event.preventDefault()
            close()
            button.focus()
          }
        }}
      >
        <span>Dinkster</span><span class="app-menu-caret" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <ContextMenu
          menu={{ ...anchor(), worldX: 0, worldY: 0, groups: groups() }}
          onInvoke={invoke}
          onClose={(reason) => close(reason === 'escape')}
        />
      </Show>
    </div>
  )
}

const coreStatusProvider: HostUiProviderV1 = (context) => {
  const data = context.data as { readonly connectionStatus: string; readonly schemaText: string }
  const tone = data.connectionStatus === 'connected' ? 'success' : data.connectionStatus === 'disconnected' ? 'danger' : 'warning'
  return {
    version: 1,
    root: {
      kind: 'group', key: 'core.status', direction: 'row', children: [
        { kind: 'status', key: 'core.connection', text: data.connectionStatus, tone },
        { kind: 'text', key: 'core.schemas', text: data.schemaText },
      ],
    },
  }
}

/** Shell-level keybinding dispatch, including explanatory disabled Ctrl+S. */
export function dispatchAppCommandKey(
  app: Pick<AppState, 'commands' | 'keybindings'>,
  event: KeyboardEvent,
  hasActiveTab: boolean,
): void {
  if (event.defaultPrevented) return
  // Native text surfaces own every key, including the unavailable-save path
  // that intentionally crosses ordinary input and modal suppression.
  if (isNativeTextScopeTarget(event.target)) return
  const save = app.commands.get('workflow.save')
  if (
    hasActiveTab &&
    save?.enabled?.() === false &&
    app.keybindings.combo('workflow.save') === comboFromEvent(event)
  ) {
    // An unavailable Save is the one shortcut that must cross input/modal
    // suppression: otherwise the browser handles Ctrl+S as "save page" and
    // the user gets neither an app save nor the reason it is unavailable.
    event.preventDefault()
    save.run()
    return
  }
  const commandId = app.keybindings.match(event)
  if (shortcutSuppressed(event)) return
  if (commandId !== 'search.open' && !hasActiveTab) return
  const command = commandId ? app.commands.get(commandId) : undefined
  if (!command) return
  if (command.enabled?.() !== false) {
    event.preventDefault()
    command.run()
  }
}

export function App(props: {
  app: AppState
  federatedAssets?: AssetDtoV1WireContract
  desktopWindow?: { readonly context: DesktopWindowContext; readonly layout: DesktopWindowLayout }
}) {
  const app = props.app
  onCleanup(() => app.dispose())
  const browserParams = new URLSearchParams(window.location.search)
  const browserWindowContext: DesktopWindowContext = browserParams.get('dinksterWorkflow')
    ? { id: browserParams.get('dinksterWindow') ?? 'browser-popout', kind: 'workflow', workflowId: browserParams.get('dinksterWorkflow')! }
    : browserParams.get('dinksterPanel')
      ? {
          id: browserParams.get('dinksterWindow') ?? 'browser-popout',
          kind: 'panel',
          panelId: browserParams.get('dinksterPanel')!,
          returnPlacement: browserParams.get('dinksterPanelReturn') === 'rail' || browserParams.get('dinksterPanelReturn') === 'bottom'
            ? browserParams.get('dinksterPanelReturn') as 'rail' | 'bottom'
            : 'dock',
        }
      : { id: 'primary', kind: 'primary' }
  const [managedContext] = createSolidSignal(props.desktopWindow?.context ?? browserWindowContext)
  const [managedLayout, setManagedLayout] = createSolidSignal<DesktopWindowLayout>(
    props.desktopWindow?.layout ?? { windows: [browserWindowContext] },
  )
  const [imageDocumentsOpen, setImageDocumentsOpen] = createSolidSignal(false)
  const [imageDocumentsMounted, setImageDocumentsMounted] = createSolidSignal(false)
  const [imageDocumentsBusy, setImageDocumentsBusy] = createSolidSignal(false)
  const [graphImageRequest, setGraphImageRequest] = createSolidSignal<GraphImageDocumentRequest>()
  const imageDocumentsActive = (): boolean => managedContext().kind === 'primary' && imageDocumentsOpen()
  const setImageDocumentsVisible = (visible: boolean): void => {
    if (visible) setImageDocumentsMounted(true)
    setImageDocumentsOpen(visible)
  }
  onMount(() => {
    const desktop = desktopBridge()
    if (desktop) {
      onCleanup(desktop.onWindowLayout(setManagedLayout))
      return
    }
    const coordinator = coordinateBrowserWindows(browserWindowContext, setManagedLayout)
    onCleanup(() => coordinator.close())
  })
  // dinkster:// links queue in the desktop shell per window; drain on startup
  // (a link may have launched this window) and whenever a new one arrives.
  // A link names the backend that owns the workflow; a link without one
  // targets the same-origin default through the library backend. Links
  // never auto-connect servers: an unconnected backend is a named problem,
  // not a network request.
  const openDeepLink = async (link: { readonly projectId: string; readonly workflowId: string; readonly backendUrl?: string }): Promise<void> => {
    if (link.projectId !== activeProjectId()) return // routed by the shell; a mismatch means a stale queue entry
    const owner = link.backendUrl !== undefined
      ? resolveDeepLinkBackend(app.backends.get(), link.backendUrl)
      : app.libraryBackend()?.id
    if (owner === undefined) {
      app.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag(
        'error', 'validation', 'deepLink.backendNotConnected',
        link.backendUrl !== undefined
          ? `the workflow link names a server that is not connected: ${link.backendUrl}. Connect it from the Backends panel, then follow the link again.`
          : 'the workflow link targets the default backend, but no backend is available',
      )])
      return
    }
    const opened = await app.openFromLibrary(link.workflowId, owner)
    if (!opened) {
      app.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag(
        'error', 'validation', 'deepLink.openFailed',
        `the linked workflow could not be opened: ${link.workflowId}`,
      )])
    }
  }
  onMount(() => {
    const desktop = desktopBridge()
    if (!desktop) return
    const drain = (): void => {
      void desktop.takeDeepLinks().then(async (links) => {
        for (const link of links) await openDeepLink(link)
      }).catch(() => {})
    }
    drain()
    onCleanup(desktop.onDeepLinkPending(drain))
  })
  const coreStatusProblemsOwner = Symbol('core-status-problems')
  const contributionProblemsOwners = new WeakMap<ExtensionHostUiContributionV1, symbol>()
  const contributionProblemsOwner = (contribution: ExtensionHostUiContributionV1): symbol => {
    const existing = contributionProblemsOwners.get(contribution)
    if (existing) return existing
    const owner = Symbol('extension-host-ui-problems')
    contributionProblemsOwners.set(contribution, owner)
    return owner
  }
  const tooltips = new TooltipController(() => app.settings.get<number>('tooltips.delayMs'))
  const [tooltip, setTooltip] = createSolidSignal(tooltips.visible)
  let shellEl!: HTMLDivElement
  tooltips.register({ id: 'core.dom', resolve: (target, opts) => {
    const dom = target as Partial<DomTooltipTarget>
    return dom.kind === 'dom' && dom.label ? { lines: [dom.label], ...(opts.detailed && dom.detail ? { detail: dom.detail } : {}) } : undefined
  } })
  tooltips.register({ id: 'core.canvas', resolve: (target, opts) => {
    const tab = app.activeTab()
    const registry = tab ? app.registryForTab(tab) : app.registry.get()
    const resolveSchema = registry
      ? (tab ? documentResolver(tab.store.doc, registry.resolve) : registry.resolve)
      : () => undefined
    return resolveCanvasTooltip(target, opts, {
      resolveSchema,
      resolvePack: (id) => registry?.packs?.get(id),
    })
  } })
  onMount(() => {
    const detach = attachDomTooltips(shellEl, tooltips)
    const unsubscribe = tooltips.subscribe(() => setTooltip(tooltips.visible))
    onCleanup(() => { detach(); unsubscribe() })
  })
  const tabs = useSignal(app.tabs)
  const activeTabId = useSignal(app.activeTabId)
  const dirtyTabs = useSignal(app.dirtyTabs)
  const collabTabs = useSignal(app.collabTabs)
  const executions = useSignal(app.store.executions)
  const problems = useSignal(app.problems)
  const solveDiagnostics = useSignal(app.solveDiagnostics)
  const logs = useSignal(app.logs)
  const overlayPins = useSignal(app.overlayPins)
  const lenses = useSignal(app.lenses)
  const settingsTick = useSignal(app.settings.changed)
  const searchShortcut = (): string | undefined => {
    settingsTick()
    return app.keybindings.combo('search.open')
  }
  const controlSurfacesEnabled = (): boolean => {
    settingsTick()
    return app.settings.get<boolean>('features.controlSurfaces.enabled')
  }
  const backends = useSignal(app.backends)
  const backendsTick = useSignal(app.backendsTick)
  const hostUiTick = useSignal(app.hostUiContributions.changed)
  const locale = useSignal(activeLocale)
  const message = (key: string, params?: MessageParams): string => {
    locale()
    return t(key, params)
  }
  const modalPanel = useSignal(app.modalPanel)
  const searchOpen = useSignal(app.searchOpen)
  const placementStatus = useSignal(app.placementStatus)
  const transientStatus = useSignal(app.transientStatus)
  const detachedWorkflowIds = (): ReadonlySet<string> => new Set(managedLayout().windows.flatMap((entry) =>
    entry.kind === 'workflow' ? [entry.workflowId] : []))
  const detachedPanelIds = (): ReadonlySet<string> => new Set(managedLayout().windows.flatMap((entry) =>
    entry.kind === 'panel' ? [entry.panelId] : []))
  const windowTabs = (): readonly Tab[] => {
    const context = managedContext()
    if (context.kind === 'workflow') return tabs().filter((tab) => tab.id === context.workflowId)
    if (context.kind === 'panel') return tabs()
    const detached = detachedWorkflowIds()
    return tabs().filter((tab) => !detached.has(tab.id))
  }
  createEffect(() => {
    const visible = windowTabs()
    const context = managedContext()
    if (context.kind === 'panel') return
    if (!visible.some((tab) => tab.id === activeTabId())) app.activeTabId.set(visible[0]?.id ?? '')
  })
  const statusTrailingContributions = () => {
    hostUiTick()
    return app.hostUiContributions.list('status.trailing')
  }
  const tabTargets = useSignal(app.tabTargets)
  const reviewReplacements = useSignal(app.reviewReplacements)
  // DockLayout owns membership, order, active tab, and open state for all
  // three zones. ShellLayout owns their pixel sizes and bar visibility.
  const dockLayoutState = useSignal(app.dock.state)
  const activityBarVisible = useSignal(app.shell.activityBarVisible)
  const statusBarVisible = useSignal(app.shell.statusBarVisible)
  const dockWidth = useSignal(app.shell.leftWidth)
  const railWidth = useSignal(app.shell.rightWidth)
  const bottomHeight = useSignal(app.shell.bottomHeight)
  // The in-flight resize drag's disposer: unmounting mid-drag must drop the
  // window listeners instead of leaving them until a stray pointerup.
  let endRegionResize: (() => void) | undefined
  const beginResize = (region: ShellRegion, sign: 1 | -1) => (down: PointerEvent): void => {
    endRegionResize?.()
    endRegionResize = beginRegionResize(app.shell, region, down, sign)
  }
  const resizeFromKeyboard = (region: ShellRegion) => (value: number): void => {
    app.shell.previewSize(region, value)
    app.shell.commitSize(region)
  }
  onCleanup(() => endRegionResize?.())
  const [logsClearArmed, setLogsClearArmed] = createSolidSignal(false)
  let logsClearTimer: ReturnType<typeof setTimeout> | undefined
  const requestLogsClear = (): void => {
    if (logs().length === 0) return
    if (!logsClearArmed()) {
      setLogsClearArmed(true)
      logsClearTimer = setTimeout(() => {
        logsClearTimer = undefined
        setLogsClearArmed(false)
      }, 4000)
      return
    }
    if (logsClearTimer !== undefined) clearTimeout(logsClearTimer)
    logsClearTimer = undefined
    setLogsClearArmed(false)
    app.clearLogs()
  }
  onCleanup(() => {
    if (logsClearTimer !== undefined) clearTimeout(logsClearTimer)
  })
  // Built-in browsable collections; sources are live (corpus re-read per
  // page), so one instance each for the app's lifetime is correct.
  const librarySources = [packsSource(app), templatesSource(app), workflowsSource(app), historySource(app), runsSource(app)]
  // The backend the library browses (the active tab's target). A memo so
  // the panel re-pages exactly when the resolved backend IDENTITY changes
  // (tab switch onto another backend, retarget, backend removal) - not on
  // every tab switch between same-backend tabs.
  const libraryOwner = createMemo((): string | undefined => {
    tabs()
    activeTabId()
    backends()
    backendsTick()
    return app.libraryBackend()?.id
  })
  // Re-page the open library when the corpus behind it moves: backends
  // (dis)connect/reload packs, executions arrive or change status, or the
  // library backend itself changes (remote sources now serve a different
  // backend's records - a stale mixed list must not linger).
  const libraryTick = (): number => {
    backendsTick()
    executions()
    libraryOwner()
    return 0
  }
  const activateLibraryEntry = (sourceId: string, entry: CollectionEntry): void => {
    if (sourceId === 'workflows') {
      if (entry.owner === undefined) return
      void app.openFromLibrary(entry.id, entry.owner).then((ok) => {
        if (ok) setPanelOpen(app.panels, app.dock, 'library', 'left', false)
      })
      return
    }
    // Runs entries select-only on click: opening rides the explicit 'open'
    // action, otherwise the delete affordance (rendered on the selected
    // entry) could never be reached - selection would open a tab and close
    // this panel.
    if (sourceId !== 'history') return
    const exec = app.store.executions.get().get(entry.id)
    if (exec?.artifact && app.openExecutionView(exec.ref)) {
      setPanelOpen(app.panels, app.dock, 'library', 'left', false)
    }
  }
  const libraryEntryAction = (sourceId: string, entry: CollectionEntry, actionId: string): void => {
    // Remote entries carry the backend that served them (owner); every
    // action routes back to that owner, never to whatever backend is
    // current when the click lands.
    if (sourceId === 'workflows' && actionId === 'copy-link') {
      if (entry.owner === undefined) return
      const backend = app.backends.get().find((candidate) => candidate.id === entry.owner)
      void navigator.clipboard?.writeText(formatWorkflowDeepLink({
        projectId: activeProjectId(),
        workflowId: entry.id,
        ...(backend && backend.baseUrl !== '' ? { backendUrl: backend.baseUrl } : {}),
      }))
      return
    }
    if (sourceId === 'templates' && actionId === 'open') {
      if (entry.owner === undefined) return
      const split = entry.id.indexOf('/')
      const pack = entry.id.slice(0, split)
      const id = entry.id.slice(split + 1)
      void app.openTemplate(pack, id, entry.title, entry.owner).then((ok) => {
        if (ok) setPanelOpen(app.panels, app.dock, 'library', 'left', false)
      })
      return
    }
    if (sourceId !== 'runs' || entry.owner === undefined) return
    const runId = runIdOfEntry(entry)
    if (actionId === 'delete') void app.deleteHistoryRun(runId, entry.owner)
    if (actionId === 'open') {
      void app.openRunWorkflow(runId, entry.owner).then((ok) => {
        if (ok) setPanelOpen(app.panels, app.dock, 'library', 'left', false)
      })
    }
    if (actionId === 'resubmit') {
      void app.resubmitRunWorkflow(runId, entry.owner).then((ok) => {
        if (ok) setPanelOpen(app.panels, app.dock, 'library', 'left', false)
      })
    }
  }
  // Clearing the whole runs scope is destructive: the button arms on the
  // first click ("Confirm clear") and executes only on a second click
  // within the arming window - no native dialogs, no accidental wipes.
  // Both clicks act on the COMMITTED page's owner (the backend whose runs
  // are actually on screen, handed over by CollectionPanel) - never on
  // whatever backend is current when the click lands. While a replacement
  // page is in flight the panel disables the button AND reports no owner,
  // so old items lingering during a backend switch can never route a
  // clear to the incoming backend; if the page owner changes between arm
  // and confirm, the confirm re-arms instead of clearing a scope the user
  // never looked at.
  const [clearArmed, setClearArmed] = createSolidSignal(false)
  let clearArmTimer: ReturnType<typeof setTimeout> | undefined
  let clearArmOwner: string | undefined
  const librarySourceAction = (sourceId: string, actionId: string, owner?: string): void => {
    if (sourceId !== 'runs' || actionId !== 'clear') return
    if (owner === undefined) return
    if (!clearArmed() || clearArmOwner !== owner) {
      clearArmOwner = owner
      setClearArmed(true)
      if (clearArmTimer !== undefined) clearTimeout(clearArmTimer)
      clearArmTimer = setTimeout(() => setClearArmed(false), 4000)
      return
    }
    if (clearArmTimer !== undefined) clearTimeout(clearArmTimer)
    setClearArmed(false)
    void app.clearRunHistory(owner)
  }
  const multiBackend = () => backends().length > 1

  // Pending close is validated by (id, DocumentSession): a same-id
  // replacement (import or collaboration adoption) installs a new session,
  // invalidating the user's discard decision, while editor-kind switches
  // replace the Tab object but keep the session and must not dismiss it.
  const [pendingClose, setPendingClose] = createSolidSignal<Tab>()
  const pendingCloseStillCurrent = (pending: Tab): boolean =>
    tabs().some((tab) => tab.id === pending.id && tab.store === pending.store)
  createEffect(() => {
    const pending = pendingClose()
    if (pending && !pendingCloseStillCurrent(pending)) setPendingClose(undefined)
  })

  // One tab strip per editor group. Gesture and focus-restore logic
  // resolves the strip that owns an element through this registry.
  const stripElements = new Map<string, HTMLElement>()
  const stripContaining = (node: Node | null): HTMLElement | undefined => {
    if (!node) return undefined
    for (const element of stripElements.values()) {
      if (element.isConnected && element.contains(node)) return element
    }
    return undefined
  }
  const requestTabClose = (tab: Tab, restoreFocus: boolean): void => {
    const strip = stripContaining(document.activeElement)
    // Closing the global active tab: activate the successor the repaired
    // split layout keeps (next tab in the closing group, else the active
    // tab of the group inheriting focus) before the close, so AppState's
    // split-blind remaining[0] fallback never moves focus to another group.
    const successor = tab.id === activeTabId() ? closeSuccessor(tab.id) : undefined
    if (successor !== undefined) app.activeTabId.set(successor)
    app.requestCloseTab(tab.id, () => true)
    if (restoreFocus || strip !== undefined) {
      queueMicrotask(() => {
        const target = strip?.isConnected
          ? strip
          : [...stripElements.values()].find((element) => element.isConnected)
        target?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
      })
    }
  }
  const closeTab = (tab: Tab): void => {
    if (!app.isTabDirty(tab.id)) {
      requestTabClose(tab, false)
      return
    }
    setPendingClose(tab)
  }

  const confirmPendingClose = (): void => {
    const pending = pendingClose()
    setPendingClose(undefined)
    if (!pending || !pendingCloseStillCurrent(pending)) return
    requestTabClose(pending, true)
  }

  const activeTab = () => windowTabs().find((t) => t.id === activeTabId())
  const [boundaryStateTick, setBoundaryStateTick] = createSolidSignal(0)
  createEffect(() => {
    const tab = activeTab()
    if (!tab) return
    const bump = () => setBoundaryStateTick((tick) => tick + 1)
    const unsubDoc = tab.store.document.subscribe(bump)
    const unsubStack = tab.graphStack.subscribe(bump)
    onCleanup(() => {
      unsubDoc()
      unsubStack()
    })
  })
  const boundaryIndicator = (): PanelIndicator | undefined => {
    boundaryStateTick()
    return editedSubgraphDefinition(activeTab())
      ? { count: 1, severity: 'info', label: message('shell.status.boundaryEditable') }
      : undefined
  }
  const splitLayoutRaw = useSignal(app.editorSplits.layout)
  /**
   * The split layout actually rendered: the stored tree repaired against
   * this window's open tabs at the read boundary, with focus following the
   * app-global active tab (whichever group holds it is focused and shows
   * it). Tab open/close/restore code stays split-blind; this derivation
   * absorbs every membership change. Non-primary windows (pop-outs) always
   * render a single group.
   */
  const displayLayout = createMemo<EditorLayout>(() => {
    const ids = windowTabs().map((tab) => tab.id)
    if (managedContext().kind !== 'primary') return singleGroupLayout(ids, activeTabId())
    let layout = repairEditorLayout(splitLayoutRaw(), ids)
    const active = activeTabId()
    if (active !== '') {
      const owner = layoutGroups(layout.root).find((group) => group.tabIds.includes(active))
      if (owner !== undefined) layout = setActiveTab(focusGroup(layout, owner.id), owner.id, active)
    }
    return layout
  })
  /**
   * The tab that becomes active when the given tab closes, per the layout's
   * own repair semantics: repair the displayed layout against the remaining
   * tabs and take the focused group's active tab. Undefined when the layout
   * does not hold the tab or nothing remains.
   */
  const closeSuccessor = (closingId: string): string | undefined => {
    const layout = displayLayout()
    if (!layoutGroups(layout.root).some((group) => group.tabIds.includes(closingId))) return undefined
    const remaining = windowTabs().map((tab) => tab.id).filter((id) => id !== closingId)
    const repaired = repairEditorLayout(layout, remaining)
    const focused = findGroup(repaired, repaired.focusedGroupId)
    return focused === undefined || focused.activeTabId === '' ? undefined : focused.activeTabId
  }
  /**
   * Commit a split gesture: rebase the mutation on the displayed (repaired)
   * layout, persist, and align the global active tab with the focused
   * group so shell chrome (panels, topbar, commands) follows focus.
   */
  const updateSplitLayout = (mutate: (layout: EditorLayout) => EditorLayout): void => {
    if (managedContext().kind !== 'primary') return
    const next = mutate(displayLayout())
    app.editorSplits.layout.set(next)
    const focused = findGroup(next, next.focusedGroupId)
    if (focused !== undefined && focused.activeTabId !== '' && focused.activeTabId !== app.activeTabId.get()) {
      app.activeTabId.set(focused.activeTabId)
    }
  }
  const splitPanelDomId = (groupId: string): string => `editor-panel-${groupId}`
  const openBrowserPopout = (params: Record<string, string>): void => {
    const url = new URL(window.location.href)
    // Pop-outs stay in this window's project so they join the same tab authority.
    url.search = new URLSearchParams(
      activeProjectId() === DEFAULT_PROJECT_ID ? params : { ...params, [PROJECT_URL_PARAM]: activeProjectId() },
    ).toString()
    window.open(url, params['dinksterWindow'], 'popup,width=1200,height=800')
  }
  const popOutWorkflow = (tab: Tab, screenX?: number, screenY?: number): void => {
    app.flushPersistTabs()
    const desktop = desktopBridge()
    if (desktop) {
      void desktop.openWorkflowWindow(tab.id, screenX, screenY)
      return
    }
    openBrowserPopout({ dinksterWindow: `browser-${tab.id}`, dinksterWindowKind: 'workflow', dinksterWorkflow: tab.id })
  }
  const [tabDrag, setTabDrag] = createSolidSignal<{
    readonly tabId: string
    readonly title: string
    readonly sourceGroupId: string
    readonly x: number
    readonly y: number
    /** Reorder preview; set only while the pointer rides the source strip. */
    readonly order: readonly string[] | undefined
    readonly insertionIndex: number | undefined
    /** Pane drop target (split or move) under the pointer. */
    readonly dropTarget: SplitDropTarget | undefined
    /** Another group's strip the pointer is over. */
    readonly targetStripId: string | undefined
    /** True when releasing here would do nothing (refused split, pop-out unavailable). */
    readonly refused: boolean
  } | undefined>(undefined)
  let disposeTabDrag: (() => void) | undefined
  let tabDragPointerId: number | undefined
  /**
   * Reordering the tab list moves the focused tab button in the DOM, and
   * insertBefore blurs it; re-focus so keyboard state survives the reflow.
   */
  const restoreTabFocusAfter = (mutate: () => void): void => {
    const focused = document.activeElement
    mutate()
    if (
      focused instanceof HTMLElement &&
      document.activeElement !== focused &&
      focused.isConnected &&
      stripContaining(focused) !== undefined
    ) focused.focus({ preventScroll: true })
  }
  let suppressTabClick: string | undefined
  let suppressTabClickTimer: ReturnType<typeof setTimeout> | undefined
  const activateTab = (event: MouseEvent, id: string, groupId: string): void => {
    if (suppressTabClick === id || tabDragPointerId !== undefined) {
      event.preventDefault()
      suppressTabClick = undefined
      return
    }
    updateSplitLayout((layout) => focusGroup(setActiveTab(layout, groupId, id), groupId))
    // Non-primary windows have no persisted layout; set the global active
    // tab directly there (updateSplitLayout is a no-op outside primary).
    app.activeTabId.set(id)
  }
  // Geometry of the center editor region. Pane and divider rects derive
  // from the layout tree and the region's observed pixel size, so every
  // pane is real laid-out DOM (App View's container-width breakpoints see
  // true widths).
  let regionElement: HTMLElement | undefined
  let regionObserver: ResizeObserver | undefined
  const [regionSize, setRegionSize] = createSolidSignal({ width: 0, height: 0 })
  const setRegionElement = (element: HTMLElement): void => {
    regionElement = element
    regionObserver?.disconnect()
    regionObserver = new ResizeObserver(() => {
      setRegionSize({ width: element.clientWidth, height: element.clientHeight })
    })
    regionObserver.observe(element)
    setRegionSize({ width: element.clientWidth, height: element.clientHeight })
  }
  onCleanup(() => regionObserver?.disconnect())
  /** Uncommitted divider ratio while a resize drag is in flight. */
  const [dividerPreview, setDividerPreview] = createSolidSignal<{ readonly path: SplitPath; readonly ratio: number }>()
  const previewedRoot = () => {
    const preview = dividerPreview()
    const layout = displayLayout()
    return preview !== undefined ? setSplitRatioAt(layout, preview.path, preview.ratio).root : layout.root
  }
  const regionRects = createMemo(() =>
    computeSplitRects(previewedRoot(), { x: 0, y: 0, width: regionSize().width, height: regionSize().height }))
  // Rects are applied as percentages of the measured region so a region
  // resize (a dock panel opening, a window resize) reflows the panes in the
  // same layout pass instead of one frame later when the ResizeObserver
  // delivers the new size.
  const rectStyle = (rect: SplitRect) => {
    const size = regionSize()
    const pct = (value: number, total: number) => (total > 0 ? `${(value / total) * 100}%` : '0px')
    return {
      left: pct(rect.x, size.width),
      top: pct(rect.y, size.height),
      width: pct(rect.width, size.width),
      height: pct(rect.height, size.height),
    }
  }
  const dropPreviewRect = (): SplitRect | undefined => {
    const target = tabDrag()?.dropTarget
    if (target === undefined) return undefined
    const pane = regionRects().groups.find((group) => group.id === target.groupId)
    return pane !== undefined ? splitDropPreviewRect(pane.rect, target.zone) : undefined
  }
  // Stable per-group render entries so <For> keeps pane DOM (and the live
  // editors inside) mounted across layout changes.
  let paneEntriesPrev: readonly { readonly id: string }[] = []
  const paneList = createMemo(() => {
    const ids = layoutGroups(displayLayout().root).map((group) => group.id)
    const next = ids.map((id) => paneEntriesPrev.find((entry) => entry.id === id) ?? { id })
    paneEntriesPrev = next
    return next
  })
  const beginDividerDrag = (divider: SplitDividerRect, down: PointerEvent): void => {
    if (down.button !== 0 || regionElement === undefined) return
    down.preventDefault()
    const region = regionElement.getBoundingClientRect()
    // The divider's area (its split node's box) is fixed for the whole
    // drag: only this split's own ratio changes.
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== down.pointerId) return
      setDividerPreview({
        path: divider.path,
        ratio: splitRatioAtPointer(divider, event.clientX - region.left, event.clientY - region.top),
      })
    }
    const stop = (commit: boolean) => (event: PointerEvent): void => {
      if (event.pointerId !== down.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', commitStop)
      window.removeEventListener('pointercancel', cancelStop)
      const preview = dividerPreview()
      setDividerPreview(undefined)
      if (commit && preview !== undefined) {
        updateSplitLayout((layout) => setSplitRatioAt(layout, preview.path, preview.ratio))
      }
    }
    const commitStop = stop(true)
    const cancelStop = stop(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', commitStop)
    window.addEventListener('pointercancel', cancelStop)
  }
  const onDividerKeyDown = (divider: SplitDividerRect, event: KeyboardEvent): void => {
    const horizontal = divider.direction === 'row'
    const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp'
    const increase = horizontal ? 'ArrowRight' : 'ArrowDown'
    if (event.key !== decrease && event.key !== increase) return
    event.preventDefault()
    const delta = event.key === increase ? 0.02 : -0.02
    updateSplitLayout((layout) => setSplitRatioAt(layout, divider.path, divider.ratio + delta))
  }
  const beginTabDrag = (tab: Tab, down: PointerEvent, groupId: string): void => {
    if (down.button !== 0) return
    const strip = stripElements.get(groupId)
    if (strip === undefined) return
    const pointerId = down.pointerId
    if (tabDragPointerDisposition(tabDragPointerId, pointerId) !== 'start') {
      down.preventDefault()
      down.stopPropagation()
      return
    }
    if ((down.target as Element | null)?.closest('.tab-close')) return
    tabDragPointerId = pointerId
    let drag = beginTabDragModel(pointerId, tab.id, down.clientX)
    let captured = false
    let disposed = false
    let paneTarget: SplitDropTarget | undefined
    let stripTarget: { readonly groupId: string; readonly index: number } | undefined
    let overSourceStrip = true
    const within = (rect: DOMRect, x: number, y: number, pad = 0): boolean =>
      x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad
    const stripInsertionIndex = (element: HTMLElement, clientX: number): number =>
      Array.from(element.querySelectorAll<HTMLElement>('.tab')).filter((el) => {
        const rect = el.getBoundingClientRect()
        return clientX >= (rect.left + rect.right) / 2
      }).length
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      strip.removeEventListener('lostpointercapture', lostCapture)
      if (captured && strip.hasPointerCapture(pointerId)) strip.releasePointerCapture(pointerId)
      if (tabDragPointerId === pointerId) tabDragPointerId = undefined
      if (disposeTabDrag === dispose) disposeTabDrag = undefined
    }
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      const wasStarted = drag.started
      const elements = Array.from(strip.querySelectorAll<HTMLElement>('.tab'))
      const currentOrder = elements.map((element) => element.dataset['tabId']!)
      const slots: readonly TabDragSlot[] = elements.map((element) => {
        const rect = element.getBoundingClientRect()
        return { id: element.dataset['tabId']!, left: rect.left, right: rect.right }
      })
      drag = moveTabDragModel(drag, event.pointerId, event.clientX, currentOrder, slots)
      if (!drag.started) return
      if (!wasStarted && !captured) {
        try {
          strip.setPointerCapture(pointerId)
          captured = true
          strip.addEventListener('lostpointercapture', lostCapture)
        } catch {
          // The window listeners still own the gesture when capture is not
          // available (for example, a synthetic pointer in a test host).
        }
      }
      event.preventDefault()
      // Resolve what the pointer is over: the source strip (reorder),
      // another group's strip (append/insert there), a pane edge or body
      // (split or move), or nothing useful.
      paneTarget = undefined
      stripTarget = undefined
      let refused = false
      overSourceStrip = within(strip.getBoundingClientRect(), event.clientX, event.clientY, 24)
      if (!overSourceStrip) {
        for (const [gid, element] of stripElements) {
          if (gid === groupId || !element.isConnected) continue
          if (within(element.getBoundingClientRect(), event.clientX, event.clientY, 8)) {
            stripTarget = { groupId: gid, index: stripInsertionIndex(element, event.clientX) }
            break
          }
        }
        if (stripTarget === undefined && regionElement !== undefined) {
          const region = regionElement.getBoundingClientRect()
          if (within(region, event.clientX, event.clientY)) {
            const target = splitDropTargetAt(regionRects(), event.clientX - region.left, event.clientY - region.top)
            if (target !== undefined) {
              const layout = displayLayout()
              if (splitDropNextLayout(layout, target, tab.id) !== layout) paneTarget = target
              else refused = true
            }
          } else {
            // Outside the region entirely: release pops the tab out, which
            // only primary windows support.
            refused = managedContext().kind !== 'primary'
          }
        }
      }
      const preview = drag.preview!
      restoreTabFocusAfter(() => setTabDrag({
        tabId: tab.id,
        title: tab.title,
        sourceGroupId: groupId,
        x: event.clientX,
        y: event.clientY,
        order: overSourceStrip ? preview.order : undefined,
        insertionIndex: overSourceStrip ? preview.insertionIndex : undefined,
        dropTarget: paneTarget,
        targetStripId: stripTarget?.groupId,
        refused,
      }))
    }
    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      const action = tabDragReleaseAction(drag)
      const started = drag.started
      const preview = drag.preview
      const overSource = overSourceStrip
      const pane = paneTarget
      const stripDrop = stripTarget
      const region = regionElement?.getBoundingClientRect()
      const outsideRegion = region === undefined || !within(region, event.clientX, event.clientY, 24)
      dispose()
      restoreTabFocusAfter(() => {
        setTabDrag(undefined)
        if (action === 'commit' && stripDrop !== undefined) {
          updateSplitLayout((layout) => moveTabToGroup(layout, tab.id, stripDrop.groupId, stripDrop.index))
        } else if (action === 'commit' && pane !== undefined) {
          updateSplitLayout((layout) => splitDropNextLayout(layout, pane, tab.id))
        } else if (started && outsideRegion && !overSource && managedContext().kind === 'primary') {
          popOutWorkflow(tab, event.screenX, event.screenY)
        } else if (action === 'commit' && overSource && preview !== undefined) {
          app.tabs.set(applySubsetOrder(tabs(), preview.order))
          updateSplitLayout((layout) => setGroupTabOrder(layout, groupId, preview.order))
        }
      })
      if (action === 'click') return
      suppressClick(tab.id)
    }
    const suppressClick = (id: string): void => {
      suppressTabClick = id
      if (suppressTabClickTimer !== undefined) clearTimeout(suppressTabClickTimer)
      suppressTabClickTimer = setTimeout(() => { suppressTabClick = undefined }, 0)
    }
    const cancel = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      dispose()
      restoreTabFocusAfter(() => setTabDrag(undefined))
      if (drag.started) suppressClick(tab.id)
    }
    const lostCapture = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      captured = false
      drag = rollbackTabDragModel(drag, event.pointerId)
      window.removeEventListener('pointermove', move)
      strip.removeEventListener('lostpointercapture', lostCapture)
      restoreTabFocusAfter(() => setTabDrag(undefined))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    disposeTabDrag = dispose
  }
  onCleanup(() => {
    disposeTabDrag?.()
    if (suppressTabClickTimer !== undefined) clearTimeout(suppressTabClickTimer)
  })
  // Frozen tabs show their OWN execution; live tabs show their overlay
  // binding (pinned run when pinned, else the lineage's latest).
  const activeExecution = (): ExecutionState | undefined => {
    executions()
    overlayPins()
    const tab = activeTab()
    return tab ? app.executionForTab(tab) : undefined
  }
  const workflowExecutions = (): readonly ExecutionState[] => {
    executions()
    const tab = activeTab()
    return tab ? app.executionsForTab(tab) : []
  }

  /** The live tab an execution's lineage belongs to, if it is open. */
  const liveTabOf = (exec: ExecutionState): Tab | undefined => {
    tabs()
    const lineage = exec.artifact?.snapshot.lineage
    return lineage ? app.liveTabFor(lineage) : undefined
  }

  /**
   * How this row relates to its live tab's overlay: 'pinned' when explicitly
   * pinned, 'latest' when it is what follow-latest resolves to, undefined
   * when another run overlays that tab (or no live tab is open).
   */
  const overlayRoleOf = (exec: ExecutionState): 'pinned' | 'latest' | undefined => {
    executions()
    overlayPins()
    const live = liveTabOf(exec)
    if (!live) return undefined
    const shown = app.executionForTab(live)
    if (!shown || executionKey(shown.ref) !== executionKey(exec.ref)) return undefined
    return app.overlayModeForTab(live)
  }

  /**
   * Executions grouped per backend, in backends order (removed backends'
   * leftover runs trail in a "(disconnected)" group). Single-backend: one
   * unlabeled group - none of the multi-backend chrome renders.
   */
  const executionGroups = (): { backend?: Backend; id: string; execs: ExecutionState[] }[] => {
    backendsTick()
    const byConnection = new Map<string, ExecutionState[]>()
    for (const exec of workflowExecutions()) {
      const list = byConnection.get(exec.ref.connection) ?? []
      list.push(exec)
      byConnection.set(exec.ref.connection, list)
    }
    const groups: { backend?: Backend; id: string; execs: ExecutionState[] }[] = []
    for (const backend of backends()) {
      const execs = byConnection.get(backend.id)
      byConnection.delete(backend.id)
      if (execs || backends().length === 1) groups.push({ backend, id: backend.id, execs: execs ?? [] })
    }
    for (const [id, execs] of byConnection) groups.push({ id, execs })
    return groups
  }

  // Per-backend status/registry live in each Backend's OWN core signals;
  // backendsTick is the one Solid-tracked signal that covers them all.
  const statusOf = (b: Backend) => {
    backendsTick()
    return b.connection.status.get()
  }
  const schemaCountOf = (b: Backend): number | undefined => {
    backendsTick()
    return b.registry.get()?.schemas.size
  }
  /** Last /supervisor/status answer (native backends behind a supervisor). */
  const supervisorOf = (b: Backend) => {
    backendsTick()
    return b.supervisor.get()
  }
  /** Composition narration: supervisor progress or engine-level events. */
  const composingOf = (b: Backend) => {
    backendsTick()
    return b.supervisor.get()?.progress ?? b.composition.get()
  }
  /**
   * Supervisor state that gates the active backend (anything but ready):
   * rendered as "Dinkster is starting", never a connection failure (Ask 1).
   */
  const engineGate = () => {
    const sup = supervisorOf(activeBackend())
    return sup && sup.state !== 'ready' ? sup : undefined
  }

  // The backend the ACTIVE tab works against (frozen: its execution's;
  // live: its target). Footer status/schema counts follow the active tab.
  const activeBackend = (): Backend => {
    backends()
    backendsTick()
    tabTargets()
    const tab = activeTab()
    return tab ? app.backendForTab(tab) : backends()[0]!
  }

  /** The active live tab's target backend (drives the topbar selector). */
  const activeTarget = (): Backend | undefined => {
    backendsTick()
    tabTargets()
    const tab = activeTab()
    return tab && !tab.execution ? app.backendForTab(tab) : undefined
  }

  /** One rail row; captures the App closures (overlay role, live tab). */
  const ExecutionRow = (p: { exec: ExecutionState }) => {
    const live = () => liveTabOf(p.exec)
    return <ExecutionActivityCard
      entry={p.exec}
      title={app.tabTitleFor(p.exec.ref)}
      testId="execution-row"
      relation={overlayRoleOf(p.exec)}
      onOpen={() => app.openExecutionView(p.exec.ref)}
      onPin={live() ? () => {
        const tab = live()
        if (!tab) return
        if (overlayRoleOf(p.exec) === 'pinned') app.followLatestExecution(tab.id)
        else app.pinExecutionOverlay(tab.id, p.exec.ref)
      } : undefined}
    />
  }

  // ---- Shell panels ------------------------------------------------------
  // Surfaces are registered descriptors; the sidebar, dock, and rail render
  // from the registry, so moving a surface is a descriptor change, not a
  // JSX rewrite. Bodies stay local components so they can close over App
  // state.
  const LibraryBody = () => (
    <LibraryPanel
      sources={librarySources}
      backend={() => {
        const backend = activeBackend()
        return { label: backend.label, protocol: backend.protocol, status: statusOf(backend) }
      }}
      refreshTick={libraryTick}
      onActivate={activateLibraryEntry}
      onAction={libraryEntryAction}
      sourceActions={[
        { sourceId: 'runs', id: 'clear', label: clearArmed() ? 'Confirm clear' : 'Clear all' },
      ]}
      onSourceAction={librarySourceAction}
    />
  )
  const AssetsPanelBody = () => {
    const backend = activeBackend()
    return backend.protocol === 'dinkster'
      ? <AssetsBody
          connection={backend.connection}
          backendId={String(backend.id)}
          baseUrl={backend.baseUrl}
          {...(props.federatedAssets ? { federatedContract: props.federatedAssets } : {})}
        />
      : <p class="empty">{message('shell.backend.assetsRequireNative')}</p>
  }
  const LogsBody = () => <ActivityLog entries={logs} clearArmed={logsClearArmed} />
  /**
   * Best-effort display title for a runtime node id: resolve through compile
   * provenance (region iteration suffixes and inner path segments included)
   * to the document node and use its title. Falls back to the raw runtime id
   * (foreign runs, unresolvable occurrences).
   */
  const runtimeNodeTitle = (exec: ExecutionState, runtimeId: string): string => {
    const identity = documentIdentityOf(runtimeId, exec.artifact?.provenance.toSource)
    const tab = liveTabOf(exec) ?? activeTab()
    const doc = tab?.store.doc
    if (identity === undefined || tab === undefined || doc === undefined) return runtimeId
    const resolved = resolveNodeOccurrence(doc, identity.occurrence)
    const node = resolved === undefined ? undefined : doc.graphs[resolved.graphId]?.nodes[resolved.nodeId]
    if (node === undefined) return runtimeId
    const registry = app.registryForTab(tab)
    const name = node.title || (registry ? documentResolver(doc, registry.resolve)(node.type)?.displayName : undefined)
    return name !== undefined && name !== '' && name !== runtimeId ? name : runtimeId
  }
  /** Focus a log row's node on canvas through the diagnostic focus path. */
  const focusRuntimeNode = (exec: ExecutionState, runtimeId: string): void => {
    const identity = documentIdentityOf(runtimeId, exec.artifact?.provenance.toSource)
    if (identity === undefined) return
    activateProblem(app, diag('info', 'runtime', 'execution-log.focus', 'focus node from execution log', {
      anchor: { execution: exec.ref, occurrence: identity.occurrence },
    }))
  }
  const executionLogFocus = useSignal(app.executionLogFocus)
  const ExecutionLogBody = () => (
    <ExecutionLogPanel
      executions={workflowExecutions}
      active={activeExecution}
      nodeTitle={runtimeNodeTitle}
      onFocusNode={focusRuntimeNode}
      filterRequest={executionLogFocus}
      onFilterApplied={(token) => app.consumeExecutionLogFocus(token)}
    />
  )
  const QueuePanel = () => (
    <div class="rail-panel-body" data-testid="queue-rail">
      <Show when={workflowExecutions().length > 0} fallback={<p class="empty">Nothing queued for this workflow.</p>}>
        <For each={executionGroups()}>
          {(group) => (
            <div class="backend-group" role="list" aria-label={group.backend?.label ?? `${group.id} removed backend executions`}>
              <Show when={multiBackend() || group.backend === undefined}>
                <h3
                  class="backend-group-title"
                  classList={{ disconnected: group.backend === undefined }}
                  data-testid="backend-group"
                  data-connection={group.id}
                  role={group.backend === undefined ? 'status' : undefined}
                >
                  {group.backend?.label ?? `${group.id} - backend removed or disconnected`}
                </h3>
              </Show>
              <For each={group.execs}>{(exec) => <ExecutionRow exec={exec} />}</For>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
  const OutputsPanel = () => (
    <div class="rail-panel-body" data-testid="outputs-panel">
      <Show when={activeExecution()} fallback={
        <div class="output-state" data-state="no-execution" role="status">
          <strong>No execution selected</strong>
          <span>Run this workflow or open a recorded execution to inspect its outputs.</span>
        </div>
      }>
        {(exec) => <Outputs app={app} execution={exec()} onOpenLayers={(request) => {
          if (imageDocumentsBusy()) return
          setGraphImageRequest(request)
          setImageDocumentsVisible(true)
        }} />}
      </Show>
    </div>
  )
  // One composed problem list feeds every problem surface: the
  // whole-document Problems tab, the Focused tab, and the Problems
  // indicator, so their counts can never disagree.
  const problemDiagnostics = (): readonly Diagnostic[] => {
    const execution = activeExecution()
    return [
      ...solveDiagnostics(),
      ...visibleProblems(problems(), new Set([activeTabId()])),
      ...(activeTab()?.execution ? execution?.artifact?.diagnostics ?? [] : []),
      ...(execution?.errors ?? []),
    ]
  }
  const problemsIndicator = (): PanelIndicator | undefined => {
    const list = problemDiagnostics()
    if (list.length === 0) return undefined
    const severity = list.some((d) => d.severity === 'error')
      ? 'error'
      : list.some((d) => d.severity === 'warning') ? 'warning' : 'info'
    return {
      count: list.length,
      severity,
      label: message('shell.status.problems', { count: list.length, severity }),
    }
  }
  // Whole-document -> focused navigation: focus the owner on canvas (no
  // document mutation) and bring the Focused tab forward so it shows that
  // owner's problems.
  const showProblemInContext = (diagnostic: Diagnostic): void => {
    activateProblem(app, diagnostic)
    setPanelOpen(app.panels, app.dock, 'context', 'right', true)
  }
  const desktopManagementConnection = (): DesktopMountConnection | undefined => {
    const backend = activeBackend()
    const local = backend.baseUrl === '' || new URL(backend.baseUrl, window.location.href).origin === window.location.origin
    return backend.protocol === 'dinkster' && local ? backend.connection : undefined
  }
  const unregisterPanels = [
    app.panels.register({
      id: 'library', get title() { return message('shell.panel.library.title') }, icon: Library,
      get description() { return message('shell.panel.library.description') }, get ariaLabel() { return message('shell.panel.library.ariaLabel') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 10,
      toggleTestId: 'library-toggle', component: LibraryBody,
    }),
    app.panels.register({
      id: 'learn', get title() { return message('learn.panel.title') }, icon: BookOpen,
      get description() { return message('learn.panel.description') }, get ariaLabel() { return message('learn.panel.ariaLabel') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 12,
      toggleTestId: 'learn-toggle', component: () => {
        const backend = activeBackend()
        return <LearnPanel
          backend={backend.protocol === 'dinkster' ? { id: backend.id, connection: backend.connection } : undefined}
          locale={locale().tag}
          onOpenTemplate={(pack, template, title, owner) => { void app.openTemplate(pack, template, title, owner) }}
        />
      },
    }),
    app.panels.register({
      id: 'assets', get title() { return message('shell.panel.assets.title') }, icon: Images,
      get description() { return message('shell.panel.assets.description') }, get ariaLabel() { return message('shell.panel.assets.title') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 15,
      toggleTestId: 'assets-toggle', component: AssetsPanelBody,
    }),
    // Logs live in the BOTTOM panel by default: a wide, short surface suits
    // streaming rows, and it gives the bottom region its first resident
    // (promises.md "Shell layout"). Dock stays an allowed placement.
    app.panels.register({
      id: 'logs', get title() { return message('shell.panel.activity.title') }, icon: ScrollText,
      get description() { return message('shell.panel.activity.description') }, get ariaLabel() { return message('shell.panel.activity.title') },
      placement: 'bottom', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 20,
      toggleTestId: 'logs-toggle',
      headerAction: { get label() { return message('shell.action.clear') }, testId: 'logs-clear', run: requestLogsClear },
      component: LogsBody,
    }),
    // The Execution log is the per-run structured feed (node output,
    // warnings, error reports), deliberately separate from the app-level
    // Activity panel above (Dinkster issue #368).
    app.panels.register({
      id: 'execution-log', get title() { return message('shell.panel.executionLog.title') }, icon: Terminal,
      get description() { return message('shell.panel.executionLog.description') }, get ariaLabel() { return message('shell.panel.executionLog.title') },
      placement: 'bottom', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 25,
      toggleTestId: 'execution-log-toggle',
      component: ExecutionLogBody,
    }),
    app.panels.register({
      id: 'backends', get title() { return message('shell.panel.backends.title') }, icon: Server,
      get description() { return message('shell.panel.backends.description') }, get ariaLabel() { return message('shell.panel.backends.title') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 30,
      toggleTestId: 'backends-sidebar-toggle', component: () => <BackendsPanel app={app} />,
    }),
    app.panels.register({
      id: 'memory', get title() { return message('shell.panel.memory.title') }, icon: Database,
      get description() { return message('shell.panel.memory.description') }, get ariaLabel() { return message('shell.panel.memory.ariaLabel') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 35,
      toggleTestId: 'memory-sidebar-toggle', component: () => <div class="memory-panels">
        <For each={backends().filter((backend): backend is Extract<Backend, { protocol: 'dinkster' }> => backend.protocol === 'dinkster')} fallback={<p>{message('shell.backend.noneNative')}</p>}>
          {(backend) => <MemoryPanel connection={backend.connection} backendId={backend.id} label={backend.label} />}
        </For>
      </div>,
    }),
    app.panels.register({
      id: 'p2p', get title() { return message('p2p.tabTitle') }, icon: Network,
      get description() { return message('p2p.panelDescription') }, get ariaLabel() { return message('p2p.title') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 36,
      toggleTestId: 'p2p-sidebar-toggle', component: () => <div class="p2p-panels">
        <For each={backends().filter((backend): backend is Extract<Backend, { protocol: 'dinkster' }> => backend.protocol === 'dinkster')} fallback={<p>{message('shell.backend.noneNative')}</p>}>
          {(backend) => <P2PPanel connection={backend.connection} backendId={backend.id} backendLabel={backend.label} />}
        </For>
      </div>,
    }),
    app.panels.register({
      id: 'queue', get title() { return message('shell.panel.executions.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 10,
      component: QueuePanel,
    }),
    app.panels.register({
      id: 'outputs', get title() { return message('shell.panel.outputs.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 20,
      component: OutputsPanel,
    }),
    app.panels.register({
      id: 'extensions', get title() { return message('shell.panel.extensions.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 30,
      component: () => <ExtensionsPanel host={app.extensions} />,
    }),
    app.panels.register({
      id: 'boundary', get title() { return message('shell.panel.boundary.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 40,
      indicator: boundaryIndicator,
      component: () => <BoundaryPanel app={app} />,
    }),
    // Control surfaces are parked in the rework queue (rgthree-like
    // controls); hidden by default so they are not mistaken for a settled
    // feature. See docs/rework-queue.md.
    app.panels.register({
      id: 'surfaces', get title() { return message('shell.panel.controlSurfaces.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 50,
      when: controlSurfacesEnabled, component: () => <SurfacePanel app={app} />,
    }),
    // The Focused tab shows the focused entity and only its problems
    // (docs/problem-surfaces.md); the Problems tab remains the whole-document
    // list. Both read the same composed diagnostics.
    app.panels.register({
      id: 'context', get title() { return message('shell.panel.focused.title') },
      get description() { return message('shell.panel.focused.description') }, get ariaLabel() { return message('shell.panel.focused.ariaLabel') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 55,
      component: () => <ContextPanel
        app={app}
        diagnostics={problemDiagnostics}
        execution={activeExecution}
        values={(execution) => {
          backendsTick()
          const backend = app.backendFor(execution.ref.connection)
          return backend?.protocol === 'dinkster' ? backend.connection.values() : undefined
        }}
      />,
    }),
    app.panels.register({
      id: 'node-help', get title() { locale(); return t('nodeHelp.panel.title') },
      get description() { locale(); return t('nodeHelp.panel.description') },
      get ariaLabel() { locale(); return t('nodeHelp.panel.ariaLabel') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 57,
      component: () => <NodeHelpPanel app={app} locale={locale().tag} />,
    }),
    app.panels.register({
      id: 'problems', get title() { return message('shell.panel.problems.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 60,
      indicator: problemsIndicator,
      component: () => <ProblemsPanel app={app} diagnostics={problemDiagnostics}
        compatSkips={() => activeBackend().compatSkips.get()} onShowInContext={showProblemInContext} />,
    }),
    // Settings is the modal host's proving resident: the body is
    // placement-agnostic (SettingsDialog owns content, the host owns
    // backdrop/title/close/Escape), opened via app.modalPanel ('settings'
    // button, Ctrl+, command).
    app.panels.register({
      id: 'settings', get title() { return message('shell.panel.settings.title') },
      get description() { return message('shell.panel.settings.description') }, get ariaLabel() { return message('shell.panel.settings.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 10,
      component: () => <SettingsDialog
        settings={app.settings}
        commands={app.commands}
        keybindings={app.keybindings}
        request={app.settingsOpenRequest.get()}
        onRequestConsumed={() => app.settingsOpenRequest.set(undefined)}
      />,
    }),
    app.panels.register({
      id: 'customize-layout', get title() { return message('shell.panel.customizeLayout.title') },
      get description() { return message('shell.panel.customizeLayout.description') }, get ariaLabel() { return message('shell.panel.customizeLayout.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 15,
      component: () => <CustomizeLayoutDialog
        items={layoutVisibilityItems()}
        onReset={() => {
          app.shell.resetVisibility()
          app.dock.resetOpen()
        }}
      />,
    }),
    app.panels.register({
      id: 'desktop-management', get title() { return message('shell.panel.desktop.title') },
      get description() { return message('shell.panel.desktop.description') }, get ariaLabel() { return message('shell.panel.desktop.ariaLabel') },
      placement: 'modal', allowedPlacements: ['modal'], order: 16,
      component: () => <DesktopManagementDialog connection={desktopManagementConnection()} />,
    }),
    app.panels.register({
      id: 'projects', get title() { return message('shell.panel.projects.title') },
      get description() { return message('shell.panel.projects.description') }, get ariaLabel() { return message('shell.panel.projects.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 18,
      component: () => <ProjectsDialog onSwitch={switchProject} onOpenWindow={openProjectWindow} />,
    }),
    app.panels.register({
      id: 'subgraph-definitions', get title() { return message('shell.panel.subgraphDefinitions.title') },
      get description() { return message('shell.panel.subgraphDefinitions.description') }, get ariaLabel() { return message('shell.panel.subgraphDefinitions.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 17,
      component: () => <SubgraphDefinitionsDialog app={app} />,
    }),
    app.panels.register({
      id: 'collab', get title() { return message('shell.panel.workspace.title') },
      get description() { return message('shell.panel.workspace.description') }, get ariaLabel() { return message('shell.panel.workspace.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 20,
      component: (surface) => <CollabPanel app={app} requestClose={() => surface.requestClose()} />,
    }),
  ]
  onCleanup(() => {
    for (const un of unregisterPanels) un()
  })
  // The center region resolves every editor through EditorRegistry rather
  // than shell JSX branches.
  const unregisterEditors = app.editors.register({
    id: GRAPH_EDITOR_KIND,
    get title() { return message('shell.editor.graph') },
    component: (host) => <CanvasHost app={app} tooltips={tooltips} occurrencePlanner={coreOccurrencePlanner}
      {...(host !== undefined ? { host } : {})}
      {...(props.federatedAssets !== undefined ? { federatedAssets: props.federatedAssets } : {})} />,
  })
  onCleanup(unregisterEditors)
  // The form-style app view uses the same public descriptor API.
  const unregisterAppEditor = app.editors.register({
    id: APP_EDITOR_KIND,
    get title() { return message('shell.editor.appView') },
    component: (host) => <AppView app={app} {...(host !== undefined ? { host } : {})} />,
  })
  onCleanup(unregisterAppEditor)
  const unregisterImageEditor = app.editors.register({
    id: IMAGE_EDITOR_KIND,
    get title() { return message('shell.editor.image') },
    component: (host) => <ImageEditor app={app} {...(host !== undefined ? { host } : {})} />,
  })
  onCleanup(unregisterImageEditor)
  const unregisterCurveEditor = app.editors.register({
    id: CURVE_EDITOR_KIND,
    get title() { return message('shell.editor.curve') },
    component: (host) => <CurveEditor app={app} {...(host !== undefined ? { host } : {})} />,
  })
  onCleanup(unregisterCurveEditor)
  const unregisterGlslEditor = app.editors.register({
    id: GLSL_EDITOR_KIND,
    get title() { return message('shell.editor.glsl') },
    component: (host) => <GlslEditor app={app} {...(host !== undefined ? { host } : {})} />,
  })
  onCleanup(unregisterGlslEditor)
  /**
   * Registry-bound command shortcuts (undo, queue, view toggles, ...)
   * dispatch here at the SHELL level, not inside any editor: they must keep
   * working whichever editor kind owns the center region (the graph canvas
   * is unmounted while e.g. the app view renders). Canvas-only keys
   * (copy/paste, lens, camera bookmarks) stay in CanvasHost behind the SAME
   * shortcutSuppressed guard; the defaultPrevented check keeps a key an
   * editor consumed from double-firing as a command.
   */
  const onCommandKeyDown = (e: KeyboardEvent): void => {
    dispatchAppCommandKey(app, e, activeTab() !== undefined && !imageDocumentsActive())
  }
  window.addEventListener('keydown', onCommandKeyDown)
  onCleanup(() => window.removeEventListener('keydown', onCommandKeyDown))
  const unregisterSearch = registerCoreSearchProviders(app)
  onCleanup(() => unregisterSearch.forEach((dispose) => dispose()))
  const editorsTick = useSignal(app.editors.changed)
  // Keyboard traversal between editor groups, in the tree's reading order.
  const focusEditorGroupByOffset = (offset: 1 | -1): void => {
    const layout = displayLayout()
    const groups = layoutGroups(layout.root)
    if (groups.length < 2) return
    const index = groups.findIndex((group) => group.id === layout.focusedGroupId)
    const next = groups[(index + offset + groups.length) % groups.length]!
    updateSplitLayout((current) => focusGroup(current, next.id))
    queueMicrotask(() => document.getElementById(splitPanelDomId(next.id))?.focus())
  }
  const unregisterGroupFocus = [
    app.commands.register({
      id: 'view.focusNextEditorGroup',
      get label() { return message('command.view.focusNextEditorGroup') },
      run: () => focusEditorGroupByOffset(1),
    }),
    app.commands.register({
      id: 'view.focusPreviousEditorGroup',
      get label() { return message('command.view.focusPreviousEditorGroup') },
      run: () => focusEditorGroupByOffset(-1),
    }),
    app.keybindings.register({ command: 'view.focusNextEditorGroup', combo: 'F6' }),
    app.keybindings.register({ command: 'view.focusPreviousEditorGroup', combo: 'Shift+F6' }),
  ]
  onCleanup(() => unregisterGroupFocus.forEach((dispose) => dispose()))
  const panelsTick = useSignal(app.panels.changed)
  /**
   * Return a floating/windowed panel home through the move boundary, so
   * registry placement and dock-zone membership always change together. The
   * direct placement write remains only as the fallback for panels with no
   * zone home (modal/floating defaults) that the boundary refuses.
   */
  const returnPanel = (id: string, fallback: PanelPlacement): void => {
    if (returnPanelToZone(app.panels, app.dock, id)) return
    app.panels.setPlacement(id, fallback)
  }
  let previousPanelWindows = new Map<string, DesktopPanelPlacement>()
  createEffect(() => {
    panelsTick()
    const next = new Map(managedLayout().windows.flatMap((entry) =>
      entry.kind === 'panel' ? [[entry.panelId, entry.returnPlacement] as const] : []))
    const previous = previousPanelWindows
    previousPanelWindows = next
    for (const [id, placement] of previous) {
      if (!next.has(id)) returnPanel(id, placement)
    }
    for (const id of next.keys()) movePanel(app.panels, app.dock, id, { kind: 'window' })
  })
  const panelIsDetached = (id: string): boolean => detachedPanelIds().has(id)
  // DockLayout membership is the durable zone authority. PanelRegistry's
  // live placement only suppresses floating or windowed members.
  const zoneOpen = (zone: DockZoneId): boolean => {
    dockLayoutState()
    panelsTick()
    return app.dock.effective().zones[zone].open
  }
  const zoneView = (zone: DockZoneId) => {
    dockLayoutState()
    panelsTick()
    return zoneTabsView(app.panels, app.dock, zone, panelIsDetached)
  }
  const zoneSections = (zone: DockZoneId) => {
    dockLayoutState()
    panelsTick()
    return zoneSectionsView(app.panels, app.dock, zone, panelIsDetached)
  }
  const zoneSplit = (zone: DockZoneId): number => {
    dockLayoutState()
    return app.dock.effective().zones[zone].split
  }
  /** Whether `id` is the active tab of ANY of the zone's visible sections. */
  const zoneHasActive = (zone: DockZoneId, id: string): boolean =>
    zoneSections(zone).some((section) => section.activeId === id)
  const railOpen = () => zoneOpen('right')
  const leftView = () => zoneView('left')
  const bottomView = () => zoneView('bottom')
  const railView = () => zoneView('right')
  const leftPanels = () => leftView().panels
  const leftActiveId = () => leftView().activeId
  const bottomZonePanels = () => bottomView().panels
  const bottomActiveId = () => bottomView().activeId
  const dockPanels = leftPanels
  const bottomPanels = bottomZonePanels
  const railPanels = () => railView().panels
  // Aggregate rail-panel indicators onto the region toggle, so attention
  // stays discoverable while the rail is collapsed or the panel's tab is
  // clipped into the overflow menu.
  const railIndicator = (): PanelIndicator | undefined =>
    aggregatePanelIndicators(railPanels().map((panel) => panel.indicator?.()))
  const railActiveId = () => railView().activeId
  const leftOpen = () => zoneOpen('left') && leftPanels().length > 0
  const bottomOpen = () => zoneOpen('bottom') && bottomZonePanels().length > 0
  let bodyElement!: HTMLDivElement
  const [panelDrag, setPanelDrag] = createSolidSignal<PanelDragModel>()
  let panelDragPointerId: number | undefined
  let disposePanelDrag: (() => void) | undefined
  const publishPanelDrag = (drag: PanelDragModel | undefined): void => {
    setPanelDrag(drag)
    const active = drag?.started === true && !drag.rolledBack
    document.body.classList.toggle('panel-drag-active', active)
    document.body.classList.toggle('panel-drag-not-allowed', active && drag.preview?.allowed === false)
  }
  const dragRect = (value: DOMRect): PanelDragRect => ({
    left: value.left,
    top: value.top,
    right: value.right,
    bottom: value.bottom,
  })
  const capturePanelDragSnapshot = (): ReturnType<typeof createPanelDragSnapshot> | undefined => {
    const center = bodyElement.querySelector<HTMLElement>(':scope > .canvas-pane')
    const canvas = center?.querySelector<HTMLElement>(':scope > .editor-split-region')
    if (!center || !canvas) return undefined
    const state = app.dock.effective()
    const visibleZones: Partial<Record<DockZoneId, PanelDragVisibleZoneGeometry>> = {}
    for (const host of bodyElement.querySelectorAll<HTMLElement>('.dock-zone[data-zone]')) {
      const zone = DOCK_ZONE_IDS.find((candidate) => candidate === host.dataset['zone'])
      const hostRect = host.getBoundingClientRect()
      if (zone === undefined || hostRect.width === 0 || hostRect.height === 0) continue
      const sections: PanelDragSectionGeometry[] = []
      for (const element of host.querySelectorAll<HTMLElement>('.dock-zone-section[data-section]')) {
        const section = Number.parseInt(element.dataset['section'] ?? '', 10)
        const tabStrip = element.querySelector<HTMLElement>('.product-tablist')
        const body = element.querySelector<HTMLElement>('.product-tabpanel:not([hidden])')
        const overflowButton = element.querySelector<HTMLElement>('[data-testid="dock-zone-overflow-button"]')
        if (Number.isNaN(section) || tabStrip === null || body === null) continue
        sections.push({
          section,
          bodyRect: dragRect(body.getBoundingClientRect()),
          tabStrip: {
            rect: dragRect(tabStrip.getBoundingClientRect()),
            slots: [...tabStrip.querySelectorAll<HTMLElement>('.product-tab[data-tab-id]')].map((slot) => ({
              id: slot.dataset['tabId']!,
              rect: dragRect(slot.getBoundingClientRect()),
            })),
          },
          appendRects: overflowButton === null ? [] : [dragRect(overflowButton.getBoundingClientRect())],
        })
      }
      if (sections.length === 0) continue
      visibleZones[zone] = { rect: dragRect(hostRect), sections }
    }
    return createPanelDragSnapshot({
      viewportRect: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
      centerRect: dragRect(center.getBoundingClientRect()),
      canvasRect: dragRect(canvas.getBoundingClientRect()),
      zoneSizes: { left: dockWidth(), right: railWidth(), bottom: bottomHeight() },
      zoneOrders: {
        left: state.zones.left.sections.map((section) => section.tabs),
        right: state.zones.right.sections.map((section) => section.tabs),
        bottom: state.zones.bottom.sections.map((section) => section.tabs),
      },
      visibleZones,
    })
  }
  const beginPanelDrag = (down: PointerEvent): void => {
    const target = down.target instanceof Element
      ? down.target.closest<HTMLElement>('.dock-zone .product-tab[data-tab-id]')
      : null
    if (target === null || down.button !== 0) return
    const pointerId = down.pointerId
    if (panelDragPointerDisposition(panelDragPointerId, pointerId) !== 'start') {
      down.preventDefault()
      down.stopImmediatePropagation()
      return
    }
    const panelId = target.dataset['tabId']
    const zoneElement = target.closest<HTMLElement>('.dock-zone[data-zone]')
    const originZone = DOCK_ZONE_IDS.find((zone) => zone === zoneElement?.dataset['zone'])
    const descriptor = panelId === undefined ? undefined : app.panels.get(panelId)
    const snapshot = capturePanelDragSnapshot()
    if (panelId === undefined || originZone === undefined || descriptor === undefined || snapshot === undefined) return

    disposePanelDrag?.()
    panelDragPointerId = pointerId
    let drag = beginPanelDragModel(
      pointerId,
      panelId,
      { x: down.clientX, y: down.clientY },
      snapshot,
      {
        zones: DOCK_ZONE_IDS.filter((zone) => canDockInZone(descriptor.allowedPlacements, zone)),
        floating: descriptor.allowedPlacements.includes('floating'),
      },
    )
    let captured = false
    let disposed = false
    let clickCleanupTimer: ReturnType<typeof setTimeout> | undefined
    const suppressNativeClick = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      target.removeEventListener('click', suppressNativeClick, true)
      if (clickCleanupTimer !== undefined) clearTimeout(clickCleanupTimer)
    }
    const releaseClickSuppressionSoon = (): void => {
      clickCleanupTimer = setTimeout(() => {
        target.removeEventListener('click', suppressNativeClick, true)
        clickCleanupTimer = undefined
      }, 0)
    }
    target.addEventListener('click', suppressNativeClick, true)
    down.preventDefault()

    const cleanup = (): void => {
      if (disposed) return
      disposed = true
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancelPointer)
      window.removeEventListener('keydown', cancelKey, true)
      window.removeEventListener('scroll', invalidateSnapshot, true)
      window.removeEventListener('resize', invalidateSnapshot)
      target.removeEventListener('lostpointercapture', lostCapture)
      if (captured && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      if (panelDragPointerId === pointerId) panelDragPointerId = undefined
      if (disposePanelDrag === dispose) disposePanelDrag = undefined
    }
    const rollback = (): void => {
      if (disposed || drag.rolledBack) return
      drag = rollbackPanelDragModel(drag, pointerId)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('keydown', cancelKey, true)
      window.removeEventListener('scroll', invalidateSnapshot, true)
      window.removeEventListener('resize', invalidateSnapshot)
      target.removeEventListener('lostpointercapture', lostCapture)
      if (captured && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      captured = false
      publishPanelDrag(undefined)
    }
    const dispose = (): void => {
      cleanup()
      publishPanelDrag(undefined)
      target.removeEventListener('click', suppressNativeClick, true)
      if (clickCleanupTimer !== undefined) clearTimeout(clickCleanupTimer)
    }
    const invalidateSnapshot = (): void => rollback()
    const cancelKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      rollback()
    }
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      const wasStarted = drag.started
      drag = movePanelDragModel(drag, pointerId, { x: event.clientX, y: event.clientY })
      if (!drag.started) return
      if (!wasStarted && !captured) {
        try {
          target.addEventListener('lostpointercapture', lostCapture)
          target.setPointerCapture(pointerId)
          captured = true
        } catch {
          target.removeEventListener('lostpointercapture', lostCapture)
          event.preventDefault()
          event.stopImmediatePropagation()
          rollback()
          cleanup()
          releaseClickSuppressionSoon()
          return
        }
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      publishPanelDrag(drag)
    }
    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      const currentSnapshot = drag.started ? capturePanelDragSnapshot() : undefined
      const action = panelDragReleaseAction(drag, currentSnapshot === undefined ? undefined : {
        snapshot: currentSnapshot,
        point: { x: event.clientX, y: event.clientY },
      })
      const preview = drag.preview
      cleanup()
      publishPanelDrag(undefined)
      if (action === 'click') {
        app.dock.activate(originZone, panelId)
        queueMicrotask(() => target.focus({ preventScroll: true }))
      } else if (action === 'commit' && preview !== undefined) {
        const destinationZone = preview.target.kind === 'floating' ? undefined : preview.target.zone
        // A split drop opens the zone's next section; an edge drop on a
        // closed zone appends to its first section.
        const moved = preview.target.kind === 'floating'
          ? movePanel(app.panels, app.dock, panelId, { kind: 'floating' })
          : preview.target.kind === 'split'
            ? movePanel(app.panels, app.dock, panelId, {
                kind: 'zone',
                zone: preview.target.zone,
                section: preview.target.section,
                index: 0,
              })
            : movePanel(app.panels, app.dock, panelId, {
                kind: 'zone',
                zone: preview.target.zone,
                section: preview.target.kind === 'edge' ? 0 : preview.target.section,
                index: preview.target.index,
              })
        if (moved && destinationZone !== undefined) {
          queueMicrotask(() => {
            bodyElement.querySelector<HTMLButtonElement>(
              `.dock-zone[data-zone="${destinationZone}"] .product-tab[data-tab-id="${CSS.escape(panelId)}"]`,
            )?.focus({ preventScroll: true })
          })
        }
      }
      releaseClickSuppressionSoon()
    }
    const cancelPointer = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      rollback()
      cleanup()
      releaseClickSuppressionSoon()
    }
    const lostCapture = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      captured = false
      rollback()
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancelPointer)
    window.addEventListener('keydown', cancelKey, true)
    window.addEventListener('scroll', invalidateSnapshot, true)
    window.addEventListener('resize', invalidateSnapshot)
    disposePanelDrag = dispose
  }
  onCleanup(() => {
    disposePanelDrag?.()
    document.body.classList.remove('panel-drag-active', 'panel-drag-not-allowed')
  })
  const floatingPanels = () => {
    panelsTick()
    // A `when()`-gated panel renders nothing while its gate answers false
    // (same rule as zone tabs); the floating override survives, so the
    // overlay returns when the gate flips back.
    return app.panels.inPlacement('floating').filter((panel) => panel.when?.() ?? true)
  }
  const floatPanel = (panelId: string): void => {
    movePanel(app.panels, app.dock, panelId, { kind: 'floating' })
  }
  const regionOf = (id: string): Extract<DockZoneId, 'left' | 'bottom'> | undefined => {
    // These callers route only activity-bar regions; right-zone panels have
    // no per-panel activity-bar toggle.
    panelsTick()
    dockLayoutState()
    const zone = panelDockZone(app.panels, app.dock, id)
    return zone === 'left' || zone === 'bottom' ? zone : undefined
  }
  const toggleSidebarPanel = (id: string): void => {
    const zone = regionOf(id)
    if (zone === undefined) return
    const open = !(zoneOpen(zone) && zoneHasActive(zone, id))
    setPanelOpen(app.panels, app.dock, id, zone, open)
  }
  const sidebarPressed = (id: string): boolean => {
    const zone = regionOf(id)
    return zone !== undefined && zoneOpen(zone) && zoneHasActive(zone, id)
  }
  const toggleLeftRegion = (): void => {
    if (leftPanels().length > 0) app.dock.setOpen('left', !leftOpen())
  }
  const toggleBottomRegion = (): void => {
    if (bottomZonePanels().length > 0) app.dock.setOpen('bottom', !bottomOpen())
  }
  const layoutVisibilityItems = (): readonly LayoutVisibilityItem[] => [
    {
      id: 'activity-bar',
      label: message('shell.layout.activityBar'),
      checked: activityBarVisible,
      toggle: () => app.shell.activityBarVisible.update((visible) => !visible),
    },
    {
      id: 'primary-dock',
      label: message('shell.layout.primaryDock'),
      checked: leftOpen,
      toggle: toggleLeftRegion,
    },
    {
      id: 'bottom-panel',
      label: message('shell.layout.bottomPanel'),
      checked: bottomOpen,
      toggle: toggleBottomRegion,
    },
    {
      id: 'right-rail',
      label: message('shell.layout.rightRail'),
      checked: railOpen,
      toggle: () => app.dock.setOpen('right', !railOpen()),
    },
    {
      id: 'status-bar',
      label: message('shell.layout.statusBar'),
      checked: statusBarVisible,
      toggle: () => app.shell.statusBarVisible.update((visible) => !visible),
    },
  ]
  const modalDescriptor = () => {
    panelsTick()
    const id = modalPanel()
    return id !== '' && app.panels.placementOf(id) === 'modal' ? app.panels.get(id) : undefined
  }
  const closeModal = () => app.modalPanel.set('')
  const focusPanelToggle = (panelId: string): void => {
    queueMicrotask(() => {
      const buttons = shellEl.querySelectorAll<HTMLButtonElement>('[data-panel-toggle]')
      Array.from(buttons).find((button) => button.dataset.panelToggle === panelId)?.focus()
    })
  }
  const closeZone = (zone: Extract<DockZoneId, 'left' | 'bottom'>): void => {
    const activeId = zoneView(zone).activeId
    app.dock.setOpen(zone, false)
    if (activeId !== undefined) focusPanelToggle(activeId)
  }
  const closeRail = (): void => {
    app.dock.setOpen('right', false)
    queueMicrotask(() => shellEl.querySelector<HTMLButtonElement>('[data-testid="rail-toggle"]')?.focus())
  }
  const popOutPanel = (panelId: string, returnPlacement: DesktopPanelPlacement): void => {
    const desktop = desktopBridge()
    if (desktop) {
      void desktop.openPanelWindow(panelId, returnPlacement)
      return
    }
    openBrowserPopout({
      dinksterWindow: `browser-panel-${panelId}`,
      dinksterWindowKind: 'panel',
      dinksterPanel: panelId,
      dinksterPanelReturn: returnPlacement,
    })
  }
  const redockCurrentWindow = (): void => {
    const desktop = desktopBridge()
    if (desktop) void desktop.redockWindow()
    else window.close()
  }
  const projectUrl = (projectId: string): URL => {
    const url = new URL(window.location.href)
    url.search = projectId === DEFAULT_PROJECT_ID
      ? ''
      : new URLSearchParams({ [PROJECT_URL_PARAM]: projectId }).toString()
    return url
  }
  const switchProject = (projectId: string): void => {
    if (projectId === activeProjectId()) return
    app.flushPersistTabs()
    const desktop = desktopBridge()
    if (desktop) {
      // The shell rolls the binding back on failure; the window stays on the
      // current project, so failure only needs to be visible, not handled.
      desktop.switchProject(projectId).catch((error: unknown) => console.error('project switch failed', error))
      return
    }
    window.location.assign(projectUrl(projectId).toString())
  }
  const openProjectWindow = (projectId: string): void => {
    app.flushPersistTabs()
    const desktop = desktopBridge()
    if (desktop) {
      desktop.openProjectWindow(projectId).catch((error: unknown) => console.error('project window failed', error))
      return
    }
    window.open(projectUrl(projectId).toString(), '_blank')
  }
  const nativePanelDescriptor = () => {
    panelsTick()
    const context = managedContext()
    const panel = context.kind === 'panel' ? app.panels.get(context.panelId) : undefined
    // A `when()`-gated panel is unavailable while its gate answers false
    // (same rule as zone tabs and the floating overlay).
    return panel !== undefined && (panel.when?.() ?? true) ? panel : undefined
  }

  /**
   * One editor group: its own tab strip and editor stage, absolutely
   * positioned inside the split region. Every pane is real laid-out DOM at
   * its true size, so container-width driven editors (App View) choose
   * their presentation per pane.
   */
  const EditorGroupPane = (p: { readonly groupId: string }) => {
    let sectionElement!: HTMLElement
    const group = (): EditorGroup =>
      findGroup(displayLayout(), p.groupId) ?? { kind: 'group', id: p.groupId, tabIds: [], activeTabId: '' }
    const paneFocused = (): boolean => displayLayout().focusedGroupId === p.groupId
    const soleGroup = (): boolean => layoutGroups(displayLayout().root).length === 1
    const paneRect = (): SplitRect | undefined => regionRects().groups.find((entry) => entry.id === p.groupId)?.rect
    const groupTabs = (): readonly Tab[] => {
      const byId = new Map(windowTabs().map((tab) => [tab.id, tab] as const))
      const drag = tabDrag()
      const ids = drag !== undefined && drag.sourceGroupId === p.groupId && drag.order !== undefined
        ? drag.order
        : group().tabIds
      return ids.flatMap((id) => {
        const tab = byId.get(id)
        return tab !== undefined ? [tab] : []
      })
    }
    const paneActiveTab = (): Tab | undefined => windowTabs().find((tab) => tab.id === group().activeTabId)
    const host: EditorHostContext = {
      tabId: () => group().activeTabId,
      focused: () => paneFocused() && !imageDocumentsActive(),
    }
    /**
     * This pane's editor descriptor. No tab defaults to the graph editor so
     * the canvas host stays mounted because it owns the empty state;
     * same-kind tab switches return the SAME descriptor object, so the
     * keyed Show below never remounts the editor and per-tab view state
     * survives.
     */
    const paneEditorKind = () => paneActiveTab()?.editorKind ?? GRAPH_EDITOR_KIND
    const paneDescriptor = () => {
      editorsTick()
      return app.editors.get(paneEditorKind())
    }
    const [paneGraphStackDepth, setPaneGraphStackDepth] = createSolidSignal(0)
    createEffect(() => {
      const tab = paneActiveTab()
      if (!tab) {
        setPaneGraphStackDepth(0)
        return
      }
      setPaneGraphStackDepth(tab.graphStack.get().length)
      const unsubscribe = tab.graphStack.subscribe((stack) => setPaneGraphStackDepth(stack.length))
      onCleanup(unsubscribe)
    })
    const [viewMenu, setViewMenu] = createSolidSignal(false)
    const [lensMenu, setLensMenu] = createSolidSignal(false)
    const paneCanvasLens = () => {
      lenses()
      const tab = paneActiveTab()
      return app.lensRegistry.resolve(tab ? app.lensFor(tab.id) : undefined)
    }
    createEffect(() => {
      const viewOpen = viewMenu()
      const lensOpen = lensMenu()
      if (!viewOpen && !lensOpen) return
      const insideControls = (event: Event): boolean =>
        event.composedPath().some((item) =>
          item instanceof Element && item.matches('.canvas-view-controls') && sectionElement.contains(item))
      const close = (): void => {
        setViewMenu(false)
        setLensMenu(false)
      }
      const onPointerDown = (event: PointerEvent): void => {
        if (!insideControls(event)) close()
      }
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || document.querySelector('dialog[open]') !== null) return
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
      }
      window.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('keydown', onKeyDown, true)
      onCleanup(() => {
        window.removeEventListener('pointerdown', onPointerDown, true)
        window.removeEventListener('keydown', onKeyDown, true)
      })
    })
    const paneWorkflowExecutions = (): readonly ExecutionState[] => {
      executions()
      const tab = paneActiveTab()
      return tab ? app.executionsForTab(tab) : []
    }
    const canSplitTab = (tab: Tab): boolean => splitGroup(displayLayout(), p.groupId, 'row', tab.id) !== displayLayout()
    const focusPane = (): void => {
      if (!paneFocused()) updateSplitLayout((layout) => focusGroup(layout, p.groupId))
    }
    return (
      <section
        class="editor-group"
        classList={{ focused: paneFocused() }}
        data-testid="editor-group"
        data-group-id={p.groupId}
        data-focused={paneFocused() ? 'true' : 'false'}
        style={paneRect() !== undefined ? rectStyle(paneRect()!) : { display: 'none' }}
        onPointerDown={focusPane}
        ref={sectionElement}
      >
        <div class="tab-strip">
          <WorkflowTabs
            tabs={groupTabs()}
            activeId={group().activeTabId}
            draggedId={tabDrag()?.sourceGroupId === p.groupId ? tabDrag()?.tabId : undefined}
            insertionIndex={tabDrag()?.sourceGroupId === p.groupId ? tabDrag()?.insertionIndex : undefined}
            isDirty={(tab) => dirtyTabs().has(tab.id)}
            isFrozen={(tab) => tab.execution !== undefined}
            isShared={(tab) => collabTabs().has(tab.id)}
            renderLeading={(tab) => (
              <Show when={collabTabs().get(tab.id)} keyed>
                {(entry) => <TabCollabDot entry={entry} />}
              </Show>
            )}
            setRoot={(root) => {
              stripElements.set(p.groupId, root)
              onCleanup(() => {
                if (stripElements.get(p.groupId) === root) stripElements.delete(p.groupId)
              })
            }}
            onActivate={(event, tab) => activateTab(event, tab.id, p.groupId)}
            onClose={managedContext().kind === 'workflow' ? redockCurrentWindow : closeTab}
            onPointerDown={(event, tab) => beginTabDrag(tab, event, p.groupId)}
            onNew={() => app.createWorkflow()}
            canShare={(tab) => tab.execution === undefined && !collabTabs().has(tab.id) && backends().some((backend) => backend.protocol === 'dinkster')}
            onShare={(tab) => {
              app.activeTabId.set(tab.id)
              app.showTransientStatus(message('shell.share.sharing', { title: tab.title }))
              void app.shareActiveTab().then((error) => {
                app.showTransientStatus(error === undefined
                  ? message('shell.share.shared', { title: tab.title })
                  : message('shell.share.failed', { error }))
              })
            }}
            onPopOut={managedContext().kind === 'primary' ? popOutWorkflow : undefined}
            showNew={paneFocused() && managedContext().kind === 'primary'}
            panelId={splitPanelDomId(p.groupId)}
            onSplitRight={managedContext().kind === 'primary'
              ? (tab) => updateSplitLayout((layout) => splitGroup(layout, p.groupId, 'row', tab.id))
              : undefined}
            onSplitDown={managedContext().kind === 'primary'
              ? (tab) => updateSplitLayout((layout) => splitGroup(layout, p.groupId, 'column', tab.id))
              : undefined}
            canSplit={managedContext().kind === 'primary' ? canSplitTab : undefined}
            onUnsplit={soleGroup() ? undefined : () => updateSplitLayout((layout) => dissolveGroup(layout, p.groupId))}
            previews={(tab) => tab.store.doc.previews}
            onSetPreviews={(tab, mode) => {
              if (tab.execution !== undefined) return
              app.dispatchTo(tab, { command: 'workflow.setPreviews', params: { previews: mode } })
            }}
          />
          <Show when={paneFocused() && multiBackend() && activeTarget()}>
            {(target) => (
              <ProductSelect
                class="tab-target"
                testId="tab-target"
                dataAttributes={{ 'data-tooltip-label': message('shell.workflow.queueBackend') }}
                ariaLabel={message('shell.workflow.queueBackend')}
                selectedId={target().id}
                options={backends().map((backend) => ({ id: backend.id, label: backend.label, value: backend.id }))}
                onSelect={(option) => {
                  const tab = activeTab()
                  if (tab) app.setTabTarget(tab.id, option.value)
                }}
              />
            )}
          </Show>
        </div>
        <div
          id={splitPanelDomId(p.groupId)}
          class="canvas-stage"
          role="tabpanel"
          aria-label={paneActiveTab() ? undefined : message('shell.workflow.editor')}
          aria-labelledby={paneActiveTab() ? workflowTabDomId(paneActiveTab()!.id) : undefined}
          tabindex="0"
        >
          <Show when={managedContext().kind === 'primary' && !paneActiveTab() && detachedWorkflowIds().size > 0}>
            <div class="detached-workspace-state" data-testid="detached-workspace-state">
              <h2>{message('shell.workflow.detached.title')}</h2>
              <p>{message('shell.workflow.detached.description')}</p>
              <button type="button" onClick={() => app.createWorkflow()}>{message('shell.workflow.new')}</button>
            </div>
          </Show>
          <Show when={managedContext().kind === 'workflow' && !paneActiveTab()}>
            <div class="detached-workspace-state" data-testid="detached-workflow-missing">
              <h2>{message('shell.workflow.unavailable.title')}</h2>
              <p>{message('shell.workflow.unavailable.description')}</p>
              <button type="button" onClick={redockCurrentWindow}>{message('shell.window.moveToMain')}</button>
            </div>
          </Show>
          <div class="canvas-stage-toolbar">
            <CanvasViewControls
              drilled={paneEditorKind() === GRAPH_EDITOR_KIND && paneGraphStackDepth() > 1}
              disabled={!paneActiveTab() || paneActiveTab()!.execution !== undefined}
              activeView={paneEditorKind()}
              activeLens={paneCanvasLens()}
              lenses={app.lensRegistry.list()}
              viewMenuOpen={viewMenu()}
              lensMenuOpen={lensMenu()}
              onToggleViewMenu={() => { setLensMenu(false); setViewMenu((open) => !open) }}
              onToggleLensMenu={() => { setViewMenu(false); setLensMenu((open) => !open) }}
              onSetAllNetsDisplay={(mode) => {
                const tab = paneActiveTab()
                if (tab) app.dispatchTo(tab, { command: 'view.setAllNetsDisplay', params: { graphId: currentGraphId(tab), mode } })
                setViewMenu(false)
              }}
              onSelectView={(kind) => {
                const tab = paneActiveTab()
                if (tab) app.setTabEditorKind(tab.id, kind)
                setViewMenu(false)
              }}
              onSelectLens={(id) => {
                const tab = paneActiveTab()
                if (tab) app.setLens(tab.id, id as import('./data-lens.js').CanvasLens)
                setLensMenu(false)
              }}
            />
            {/* Keyed on the tab id, not the tab object: a tab-store update
                that replaces the Tab object for the SAME id (e.g. an
                execution event) must not remount the control and discard
                its transient popover state. A real tab switch (new id)
                still remounts. The inner Show resolves the live tab object
                reactively. */}
            <Show when={paneEditorKind() === GRAPH_EDITOR_KIND ? paneActiveTab()?.id : undefined} keyed>
              {(_tabId) => (
                <Show when={paneActiveTab()}>
                  {(tab) => (
                    <WorkflowQueueControl
                      owner={{ id: tab().id, title: tab().title, lineage: tab().store.doc.lineage }}
                      executions={paneWorkflowExecutions()}
                      canQueue={(backendsTick(), tab().execution === undefined && app.registryForTab(tab()) !== undefined)}
                      onQueue={() => { void app.queue(tab()) }}
                      onOpenExecution={(ref) => { app.openExecutionView(ref) }}
                    />
                  )}
                </Show>
              )}
            </Show>
          </div>
          <Show
            when={paneDescriptor()}
            keyed
            fallback={
              <div class="editor-missing" data-testid="editor-missing">
                {message('shell.editor.missing', { kind: paneEditorKind() })}
              </div>
            }
          >
            {(editor) => editor.component(host)}
          </Show>
        </div>
      </section>
    )
  }

  return (
    <>
      <Show
        when={nativePanelDescriptor()}
        keyed
        fallback={<Show when={managedContext().kind === 'panel'}>
          <section class="native-panel-window native-panel-window-missing" data-testid="native-panel-window-missing">
            <h1>{message('shell.panel.unavailable.title')}</h1>
            <p>{message('shell.panel.unavailable.description')}</p>
            <button type="button" data-testid="redock-window" onClick={redockCurrentWindow}>
              {message('shell.window.moveToMain')}
            </button>
          </section>
        </Show>}
      >{(panel) => (
        <section class="native-panel-window" data-testid="native-panel-window" data-panel={panel.id}>
          <header class="native-panel-window-header">
            <h1>
              {panel.title}
              <Show when={activePanelIndicator(panel)} keyed>
                {(indicator) => <PanelIndicatorBadge indicator={indicator} />}
              </Show>
            </h1>
            <button type="button" class="shell-panel-header-action" data-testid="redock-window" onClick={redockCurrentWindow}>{message('shell.window.moveToMain')}</button>
          </header>
          <div class="native-panel-window-content">
            {panel.component({
              placement: 'window',
              requestClose: redockCurrentWindow,
            })}
          </div>
        </section>
      )}</Show>
      <Show when={managedContext().kind !== 'panel'}>
      <div class="shell" ref={shellEl}>
      <AssetConsentDialog app={app} />
      <ImportAssetResolutionDialog app={app} />
      <Show when={pendingClose()} keyed>
        {(pending) => (
          <ModalSurface
            title={message('shell.close.title', { title: pending.title })}
            ariaLabel={message('shell.close.confirm', { title: pending.title })}
            modalId="close-tab"
            testId="close-tab-dialog"
            closeLabel={message('shell.close.cancel')}
            onRequestClose={() => setPendingClose(undefined)}
          >
            <div class="close-tab-confirm">
              <p>{message('shell.close.confirm', { title: pending.title })}</p>
              <ProductActionFooter>
                <button type="button" autofocus onClick={() => setPendingClose(undefined)}>{message('shell.action.cancel')}</button>
                <button type="button" class="danger" onClick={confirmPendingClose}>{message('shell.close.discard')}</button>
              </ProductActionFooter>
            </div>
          </ModalSurface>
        )}
      </Show>
      <header class="topbar" aria-label={message('shell.applicationControls')}>
        <div class="topbar-group topbar-group-left">
          <DinksterAppMenu
            commands={app.commands}
            keybindings={app.keybindings}
            invalidationSignals={() => [
              activeLocale,
              app.settings.changed,
              app.canvasBridge,
              app.tabs,
              app.activeTabId,
              app.backendsTick,
              ...(app.activeTab() ? [app.activeTab()!.store.document] : []),
            ]}
          />
          <Show when={managedContext().kind === 'workflow'}>
            <button class="redock-workflow" data-testid="redock-workflow" onClick={redockCurrentWindow}>{message('shell.window.moveToMain')}</button>
          </Show>
        </div>
        <UniversalSearchTrigger shortcut={searchShortcut()} onOpen={() => app.searchOpen.set(true)} />
        <div class="topbar-group topbar-group-right">
          <CustomizeLayoutButton commands={app.commands} />
          <button
            class="shell-region-toggle"
            data-testid="left-panel-toggle"
            data-tooltip-label={message('shell.toggle.leftPanel')}
            aria-label={message('shell.toggle.leftPanel')}
            aria-pressed={leftOpen()}
            disabled={leftPanels().length === 0}
            onClick={toggleLeftRegion}
          >
            <ShellRegionIcon region="left" active={leftOpen()} />
          </button>
          <button
            class="shell-region-toggle"
            data-testid="bottom-panel-toggle"
            data-tooltip-label={message('shell.toggle.bottomPanel')}
            aria-label={message('shell.toggle.bottomPanel')}
            aria-pressed={bottomOpen()}
            disabled={bottomZonePanels().length === 0}
            onClick={toggleBottomRegion}
          >
            <ShellRegionIcon region="bottom" active={bottomOpen()} />
          </button>
          <button
            class="shell-region-toggle"
            data-testid="rail-toggle"
            data-tooltip-label={message('shell.toggle.rightRail')}
            aria-label={railIndicator() === undefined ? message('shell.toggle.rightRail') : message('shell.toggle.rightRailWithStatus', { status: railIndicator()!.label })}
            aria-pressed={railOpen()}
            onClick={() => app.dock.setOpen('right', !railOpen())}
          >
            <ShellRegionIcon region="right" active={railOpen()} />
            <Show when={railIndicator()} keyed>{(indicator) => <PanelIndicatorBadge indicator={indicator} />}</Show>
          </button>
          <Show when={managedContext().kind === 'primary'}>
            <button
              class="settings-button"
              data-testid="image-documents-button"
              data-tooltip-label={message('shell.imageDocuments.title')}
              data-tooltip-detail={message('shell.imageDocuments.description')}
              aria-label={message('shell.imageDocuments.title')}
              aria-pressed={imageDocumentsOpen()}
              disabled={imageDocumentsBusy()}
              onClick={() => setImageDocumentsVisible(!imageDocumentsOpen())}
            ><Icon icon={Images} /></button>
            <button class="settings-button" data-testid="projects-button" data-tooltip-label={message('shell.panel.projects.title')} data-tooltip-detail={message('shell.panel.projects.description')} aria-label={message('shell.panel.projects.title')} onClick={() => app.modalPanel.set('projects')}><Icon icon={FolderOpen} /></button>
          </Show>
          <button class="settings-button" data-testid="collab-button" data-tooltip-label={message('shell.panel.workspace.title')} data-tooltip-detail={message('shell.panel.workspace.description')} aria-label={message('shell.panel.workspace.title')} onClick={() => app.modalPanel.set('collab')}><Icon icon={Users} /></button>
          <Show when={desktopBridge()}>
            <button class="settings-button" data-testid="desktop-management-button" data-tooltip-label={message('shell.panel.desktop.title')} data-tooltip-detail={message('shell.desktop.tooltip')} aria-label={message('shell.panel.desktop.title')} onClick={() => app.modalPanel.set('desktop-management')}><Icon icon={HardDrive} /></button>
          </Show>
        </div>
      </header>
      <Show when={searchOpen()}><UniversalSearch app={app} /></Show>

      {/* ModalHost: actuates the 'modal' placement (docs/shell.md). ONE
          modal at a time, hosted by a native <dialog> opened with
          showModal(), which supplies the modal behaviors for free: initial
          focus moves inside, the background becomes inert (focus cannot
          reach it), Escape requests close (the native 'cancel' -> 'close'
          path), and closing restores focus to the opener. A body that must
          swallow keys - e.g. the settings keybinding capture - calls
          preventDefault on the keydown, which suppresses the native close
          request. The host owns the chrome (::backdrop, title, close
          button); a keyed Show remounts the body per panel, so opening IS
          the reset. aria-modal is redundant on a modal <dialog> but set
          explicitly because CanvasHost gates canvas shortcuts on
          [aria-modal="true"]. */}
      <Show when={modalDescriptor()} keyed>
        {(panel) => {
          return (
            <ModalSurface
              title={panel.title}
              {...(panel.ariaLabel !== undefined ? { ariaLabel: panel.ariaLabel } : {})}
              modalId={panel.id}
              onRequestClose={closeModal}
            >
              {panel.component({ placement: 'modal', requestClose: closeModal })}
            </ModalSurface>
          )
        }}
      </Show>

      <Show when={engineGate()}>
        {(sup) => (
          <div class="engine-banner" data-testid="engine-banner" data-state={sup().state} role="status" aria-live="polite">
            <Show when={sup().state === 'starting'}>
              <span class="engine-spinner" />
            </Show>
            <span class="engine-banner-text">
              {sup().state === 'starting'
                ? message('shell.engine.starting')
                : sup().state === 'failed'
                  ? message('shell.engine.failed')
                  : message('shell.engine.stopped')}
              {sup().detail ? ` - ${sup().detail}` : ''}
            </span>
            <Show when={sup().state === 'failed' || sup().state === 'stopped'}>
              <button
                class="banner-button"
                data-testid="engine-restart"
                onClick={() => void app.restartEngine(activeBackend())}
              >
                {message('shell.engine.restart')}
              </button>
            </Show>
          </div>
        )}
      </Show>

      <div class="body" ref={bodyElement} onPointerDown={beginPanelDrag}>
        <nav class="left-sidebar" aria-label={message('shell.primaryNavigation')} data-tooltip-session="left-rail" hidden={!activityBarVisible()}>
          <div class="sidebar-toggle-stack">
            <div class="sidebar-toggle-group" data-testid="dock-toggle-group">
              <For each={dockPanels()}>
                {(panel) => (
                  <ActivityBarButton
                    icon={panel.icon}
                    label={panel.title}
                    accessibleName={panel.ariaLabel ?? panel.title}
                    tooltip={panel.description ?? panel.title}
                    pressed={sidebarPressed(panel.id)}
                    panelId={panel.id}
                    suppressTooltipWhenPressed={panel.id === 'assets' || panel.id === 'backends'}
                    testId={panel.toggleTestId}
                    onActivate={() => {
                      if (panel.id === 'assets' || panel.id === 'backends') tooltips.hide()
                      toggleSidebarPanel(panel.id)
                    }}
                  />
                )}
              </For>
            </div>
            <div class="sidebar-toggle-group sidebar-toggle-group-bottom" data-testid="bottom-toggle-group">
              <For each={bottomPanels()}>
                {(panel) => (
                  <ActivityBarButton
                    icon={panel.icon}
                    label={panel.title}
                    accessibleName={panel.ariaLabel ?? panel.title}
                    tooltip={panel.description ?? panel.title}
                    pressed={sidebarPressed(panel.id)}
                    panelId={panel.id}
                    testId={panel.toggleTestId}
                    onActivate={() => toggleSidebarPanel(panel.id)}
                  />
                )}
              </For>
            </div>
          </div>
          <ActivityBarButton
            icon={Settings}
            label={message('shell.panel.settings.title')}
            accessibleName={message('shell.panel.settings.title')}
            tooltip={message('shell.panel.settings.title')}
            tooltipDetail="Ctrl+,"
            pressed={undefined}
            testId="settings-button"
            class="sidebar-settings-button"
            onActivate={() => app.commands.get('settings.open')?.run()}
          />
        </nav>
        <Show when={leftOpen()}>
          <aside
            class="dock-panel"
            data-testid="dock-panel"
            data-active-panel={leftActiveId()}
            aria-label={message('shell.primaryDockPanels')}
            style={{ width: `${dockWidth()}px` }}
          >
            <DockZoneHost
              zone="left"
              ariaLabel={message('shell.primaryDockPanels')}
              sections={zoneSections('left')}
              split={zoneSplit('left')}
              onActivate={(id) => { setPanelOpen(app.panels, app.dock, id, 'left', true) }}
              onSplitChange={(split) => app.dock.setSplit('left', split)}
              onRequestClose={() => closeZone('left')}
              onOpenWindow={(id) => popOutPanel(id, 'dock')}
              onFloat={floatPanel}
            />
            <ShellResizeHandle
              region="left"
              label={message('shell.resize.primaryDockPanels')}
              value={dockWidth()}
              min={REGION_SIZE_BOUNDS.left.min}
              max={REGION_SIZE_BOUNDS.left.max}
              testId="dock-resize"
              onPointerDown={beginResize('left', 1)}
              onResize={resizeFromKeyboard('left')}
            />
          </aside>
        </Show>
        <main class="canvas-pane">
          <div
            class="editor-split-region"
            classList={{ 'image-document-hidden': imageDocumentsActive() }}
            data-testid="editor-split-region"
            ref={setRegionElement}
          >
            <For each={paneList()}>
              {(pane) => <EditorGroupPane groupId={pane.id} />}
            </For>
            {/* Index, not For: recomputed rects must move the existing
                divider elements (pointer capture and focus live on them)
                rather than recreate them. */}
            <Index each={regionRects().dividers}>
              {(divider) => (
                <div
                  class="editor-split-divider"
                  data-testid="editor-split-divider"
                  role="separator"
                  tabindex="0"
                  aria-label={message('shell.resize.editorGroups')}
                  aria-orientation={divider().direction === 'row' ? 'vertical' : 'horizontal'}
                  aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
                  aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
                  aria-valuenow={Math.round(divider().ratio * 100)}
                  data-direction={divider().direction}
                  style={rectStyle(divider().rect)}
                  onPointerDown={(event) => beginDividerDrag(divider(), event)}
                  onKeyDown={(event) => onDividerKeyDown(divider(), event)}
                />
              )}
            </Index>
            <Show when={dropPreviewRect()}>
              {(rect) => (
                <div class="editor-split-drop-preview" data-testid="split-drop-preview" style={rectStyle(rect())} />
              )}
            </Show>
          </div>
          <Show when={bottomOpen()}>
            <section
              class="bottom-panel"
              classList={{ 'image-document-hidden': imageDocumentsActive() }}
              data-testid="bottom-panel"
              data-active-panel={bottomActiveId()}
              style={{ height: `${bottomHeight()}px` }}
            >
              <ShellResizeHandle
                region="bottom"
                label={message('shell.resize.bottomPanels')}
                value={bottomHeight()}
                min={REGION_SIZE_BOUNDS.bottom.min}
                max={REGION_SIZE_BOUNDS.bottom.max}
                testId="bottom-resize"
                onPointerDown={beginResize('bottom', -1)}
                onResize={resizeFromKeyboard('bottom')}
              />
              <DockZoneHost
                zone="bottom"
                ariaLabel={message('shell.bottomPanels')}
                sections={zoneSections('bottom')}
                split={zoneSplit('bottom')}
                onActivate={(id) => { setPanelOpen(app.panels, app.dock, id, 'bottom', true) }}
                onSplitChange={(split) => app.dock.setSplit('bottom', split)}
                onRequestClose={() => closeZone('bottom')}
                onOpenWindow={(id) => popOutPanel(id, 'bottom')}
                onFloat={floatPanel}
              />
            </section>
          </Show>
          <Show when={managedContext().kind === 'primary' && imageDocumentsMounted()}>
            <ImageDocumentWorkspace
              active={imageDocumentsActive()}
              app={app}
              onBusyChange={setImageDocumentsBusy}
              onClose={() => setImageDocumentsVisible(false)}
              graphRequest={graphImageRequest()}
              onGraphRequestHandled={() => setGraphImageRequest(undefined)}
            />
          </Show>
        </main>

        <Show when={railOpen()}><aside class="rail" aria-label={message('shell.inspectorPanels')} style={{ width: `${railWidth()}px` }}>
          <ShellResizeHandle
            region="right"
            label={message('shell.resize.inspectorPanels')}
            value={railWidth()}
            min={REGION_SIZE_BOUNDS.right.min}
            max={REGION_SIZE_BOUNDS.right.max}
            testId="rail-resize"
            onPointerDown={beginResize('right', -1)}
            onResize={resizeFromKeyboard('right')}
          />
          {/* requestClose must be idempotent (SurfaceContext contract):
              setOpen(false), never a toggle - a retained or repeated call
              must not reopen the zone. */}
          <DockZoneHost
            zone="right"
            ariaLabel={message('shell.inspectorPanels')}
            sections={zoneSections('right')}
            split={zoneSplit('right')}
            onActivate={(id) => app.dock.activate('right', id)}
            onSplitChange={(split) => app.dock.setSplit('right', split)}
            onRequestClose={closeRail}
            onOpenWindow={(id) => popOutPanel(id, 'rail')}
            onFloat={floatPanel}
          />
        </aside></Show>
      </div>

      <Show when={panelDrag()}>{(drag) => {
        const descriptor = () => app.panels.get(drag().panelId)
        return (
          <PanelDragOverlay
            drag={drag()}
            ghostTitle={descriptor()?.title ?? drag().panelId}
            ghostIcon={descriptor()?.icon}
          />
        )
      }}</Show>
      <Show when={tabDrag()}>{(drag) => (
        <TabDragGhost title={drag().title} x={drag().x} y={drag().y} refused={drag().refused} />
      )}</Show>

      <Show when={tooltip()}>{(tip) => (
        <div class="app-tooltip" data-testid="app-tooltip" style={{ left: `${Math.max(8, Math.min(tip().x, window.innerWidth - 368))}px`, top: `${Math.max(8, Math.min(tip().y, window.innerHeight - 120))}px` }}>
          <Show when={tip().title}><div class="app-tooltip-title">{tip().title}</div></Show>
          <For each={tip().lines}>{(line) => <div>{line}</div>}</For>
          <Show when={tip().detailed}><For each={tip().detail}>{(line) => <div class="app-tooltip-detail">{line}</div>}</For></Show>
        </div>
      )}</Show>
      <TransientStatus message={transientStatus()} />
      <footer class="statusbar" data-testid="status-bar" aria-label={message('shell.applicationStatus')} hidden={!statusBarVisible() && placementStatus() === undefined && transientStatus() === undefined}>
        <div class="statusbar-left" role="group" aria-label={message('shell.workspaceBackendStatus')}>
          <Show when={placementStatus()}>{(status) => <span class="placement-status" data-testid="placement-status">{status()}</span>}</Show>
          <Show when={transientStatus()}>{(status) => <span class="transient-status">{status()}</span>}</Show>
          <HostUiProviderHost
            owner={coreStatusProblemsOwner}
            provider={coreStatusProvider}
            data={{
              connectionStatus: statusOf(activeBackend()),
              schemaText: schemaCountOf(activeBackend()) !== undefined
                ? message('shell.status.nodeSchemas', { count: schemaCountOf(activeBackend())! })
                : message('shell.status.loadingSchemas'),
            }}
            commands={app.commands}
            replaceProblems={(owner, diagnostics) => app.replaceProblems(owner, diagnostics)}
            core
          />
          <Show when={composingOf(activeBackend())}>
            {(p) => (
              <span class="statusbar-composing" data-testid="composition-progress">
                {message('shell.status.composingPacks', { done: p().done, total: p().total })}
                {p().phase ? ` - ${p().phase}` : ''}
              </span>
            )}
          </Show>
          <Show when={multiBackend()}>
            <span class="statusbar-backend" data-testid="statusbar-backend">
              {activeBackend().label}
            </span>
          </Show>
        </div>
        <div class="statusbar-right" data-testid="status-trailing" role="group" aria-label={message('shell.tasksNotifications')}>
          <For each={statusTrailingContributions()}>{(contribution) => (
            <span class="host-ui-contribution" data-host-ui-contribution={contribution.id}>
              <HostUiProviderHost
                owner={contributionProblemsOwner(contribution)}
                provider={contribution.provider}
                data={{
                  connectionId: activeBackend().id,
                  connectionLabel: activeBackend().label,
                  connectionStatus: statusOf(activeBackend()),
                  schemaCount: schemaCountOf(activeBackend()) ?? null,
                } satisfies Json}
                commands={app.commands}
                replaceProblems={(owner, diagnostics) => app.replaceProblems(owner, diagnostics)}
              />
            </span>
          )}</For>
          <button
            class="statusbar-toggle"
            data-testid="backends-toggle"
            aria-pressed={sidebarPressed('backends')}
            onClick={() => toggleSidebarPanel('backends')}
          >
            {multiBackend()
              ? message('shell.status.backendsCount', { count: backends().length })
              : message('shell.panel.backends.title')}
          </button>
          <button
            class="statusbar-toggle"
            data-testid="review-upgrades-toggle"
            data-tooltip-label={message('shell.reviewUpgrades.tooltip')}
            aria-label={message('shell.reviewUpgrades.ariaLabel', { state: message(reviewReplacements() ? 'shell.state.on' : 'shell.state.off') })}
            aria-pressed={reviewReplacements()}
            onClick={() => app.reviewReplacements.update((v) => !v)}
          >
            {message('shell.reviewUpgrades.label', { state: message(reviewReplacements() ? 'shell.state.on' : 'shell.state.off') })}
          </button>
        </div>
      </footer>
      </div>

      <For each={floatingPanels()}>{(panel, index) => (
        <FloatingPanelHost
          panel={panel}
          index={index()}
          onDock={() => returnPanel(panel.id, panel.placement)}
          onOpenWindow={panel.allowedPlacements.includes('window')
            ? () => popOutPanel(panel.id, panel.placement === 'bottom' ? 'bottom' : panel.placement === 'rail' ? 'rail' : 'dock')
            : undefined}
        />
      )}</For>
      </Show>
    </>
  )
}

/**
 * A shared tab's strip indicator. Its OWN subscription to the session's
 * status signal: membership changes replace the collabTabs map, but status
 * transitions (connected -> reconnecting -> closed) mutate the session in
 * place and would otherwise never rerender the dot.
 */
function TabCollabDot(props: { entry: CollabTabState }) {
  const message = useAppMessage()
  const status = useSignal(props.entry.session.status)
  return (
    <span
      class="tab-collab"
      data-testid="tab-collab"
      data-status={status()}
      aria-label={message('shell.sharedSession', { status: status() })}
      data-tooltip-label={message('shell.sharedSession', { status: status() })}
      tabindex="0"
    />
  )
}

function Outputs(props: { app: AppState; execution: ExecutionState; onOpenLayers: (request: GraphImageDocumentRequest) => void }) {
  const backendTick = useSignal(props.app.backendsTick)
  const [viewerIndex, setViewerIndex] = createSolidSignal<number>()
  const [failed, setFailed] = createSolidSignal<ReadonlySet<string>>(new Set())
  const [loaded, setLoaded] = createSolidSignal<ReadonlySet<string>>(new Set())
  const currentExecutionKey = createMemo(() => props.execution.key)
  const values = () => {
    backendTick()
    const backend = props.app.backendFor(props.execution.ref.connection)
    return backend?.protocol === 'dinkster' ? backend.connection.values() : undefined
  }
  const outputIdentities = createMemo(() => {
    const media = new Set<string>()
    const layers = new Set<string>()
    const outputs = [
      ...Object.entries(props.execution.outputs),
      ...Object.entries(props.execution.nodes).map(([nodeId, progress]) => [nodeId, progress.outputs ?? {}] as const),
    ]
    for (const [nodeId, values] of outputs) for (const [outputId, descriptor] of Object.entries(values)) {
      if (typeof descriptor === 'object' && descriptor !== null && 'typeId' in descriptor &&
          typeof descriptor.typeId === 'string') {
        const identity = JSON.stringify([nodeId, outputId])
        if (mediaMetadataOf(descriptor.typeId, undefined) !== undefined) media.add(identity)
        if (isLayerDocumentType(descriptor.typeId)) layers.add(identity)
      }
    }
    return { media: [...media].sort(), layers: [...layers].sort() }
  })
  createEffect(() => {
    currentExecutionKey()
    setViewerIndex(undefined)
    setFailed(new Set<string>())
    setLoaded(new Set<string>())
  })
  const images = () => executedImageInventory(props.execution, {
    viewUrlForExecution: (ref, file) => props.app.viewUrlForExecution(ref, file),
    assetUrlForExecution: (ref, digest) => props.app.assetUrlForExecution(ref, digest),
  })
  const provenance = (): ExecutionOutputProvenance => {
    backendTick()
    return executionOutputProvenance(props.execution, props.app.backendFor(props.execution.ref.connection))
  }
  const markFailed = (key: string): void => {
    setFailed((current) => new Set(current).add(key))
  }
  const markLoaded = (key: string): void => {
    setLoaded((current) => new Set(current).add(key))
  }
  const availability = (key: string): 'Checking' | 'Available' | 'Unavailable' =>
    failed().has(key) ? 'Unavailable' : loaded().has(key) ? 'Available' : 'Checking'
  const layerRequest = (nodeId: string, outputId: string): GraphImageDocumentRequest | undefined => {
    const artifact = props.execution.artifact
    if (artifact === undefined) return undefined
    const identity = documentIdentityOf(nodeId, artifact.provenance.toSource)
    const source = identity === undefined ? undefined : resolveNodeOccurrence(artifact.snapshot, identity.occurrence)
    const graph = source === undefined ? undefined : artifact.snapshot.graphs[source.graphId]
    const tab = props.app.liveTabFor(artifact.snapshot.lineage)
    if (source === undefined || graph === undefined || tab === undefined) return undefined
    const aliases = artifact.provenance.outputAliases?.[nodeId]
    const sourceOutputId = Object.entries(aliases ?? {}).find(([, runtimeOutputId]) => runtimeOutputId === outputId)?.[0] ?? outputId
    return {
      connectionId: props.execution.ref.connection,
      query: { jobId: props.execution.ref.prompt, nodeId, outputId },
      sourceTabId: tab.id,
      graphId: source.graphId,
      sourceNodeId: source.nodeId,
      sourceOutputId,
      expectedGraphFingerprint: sha256Hex(canonicalJson(graph)),
    }
  }
  const emptyState = (): { readonly state: string; readonly title: string; readonly detail: string } => {
    if (props.execution.status === 'error') return {
      state: 'error', title: 'Execution failed without image outputs',
      detail: props.execution.errors.map((error) => error.message).join(' ') || 'The execution reported an error before producing inspectable images.',
    }
    if (!provenance().backendAvailable) return {
      state: 'owner-unavailable', title: 'Output owner unavailable',
      detail: 'The execution backend was removed or disconnected. Retained output media cannot be confirmed.',
    }
    if (props.execution.status === 'queued' || props.execution.status === 'running') return {
      state: 'waiting', title: 'Waiting for image outputs',
      detail: props.execution.status === 'queued' ? 'The execution is queued.' : 'The execution is running.',
    }
    if (props.app.backendFor(props.execution.ref.connection)?.protocol === 'dinkster' &&
      !props.execution.artifactsHydrated && Object.keys(props.execution.outputs).length === 0) return {
      state: 'loading', title: 'Loading retained outputs',
      detail: 'The completed execution is still resolving its retained output inventory.',
    }
    return {
      state: 'empty', title: 'No image outputs',
      detail: 'This execution completed without inspectable image descriptors or assets.',
    }
  }
  return (
    <>
      <section class="output-execution-provenance output-rail-provenance" aria-label="Execution provenance">
        <div><span>Backend</span><strong>{provenance().backendLabel}</strong></div>
        <div><span>Backend ID</span><strong>{provenance().backendId}</strong></div>
        <div><span>Execution</span><strong>{provenance().executionId}</strong></div>
        <div><span>Status</span><strong>{provenance().executionStatus}</strong></div>
        <Show when={!provenance().backendAvailable && images().length > 0}>
          <p role="status">Execution owner removed or disconnected. Retained output routes are used when available.</p>
        </Show>
        <Show when={props.execution.errors.length > 0 && images().length > 0}>
          <p class="output-execution-error" role="alert">{props.execution.errors.map((error) => error.message).join(' ')}</p>
        </Show>
      </section>
      <MediaDiagnostics diagnostics={props.execution.valueDiagnostics ?? []} />
      <For each={outputIdentities().layers}>{(identity) => {
        const [nodeId, outputId] = JSON.parse(identity) as [string, string]
        return <button type="button" disabled={layerRequest(nodeId, outputId) === undefined} onClick={() => {
          const request = layerRequest(nodeId, outputId)
          if (request !== undefined) props.onOpenLayers(request)
        }}>Open layers: {nodeId} / {outputId}</button>
      }}</For>
      <For each={outputIdentities().media}>{(identity) => {
        const [nodeId, outputId] = JSON.parse(identity) as [string, string]
        return <MediaValueInspector values={values()} query={{ jobId: props.execution.ref.prompt, nodeId, outputId }} />
      }}</For>
      <div class="outputs" role="list" aria-label={`${images().length} execution images`}>
        <For each={images()} fallback={
          <div class="output-state" data-state={emptyState().state} role={emptyState().state === 'error' ? 'alert' : 'status'}>
            <strong>{emptyState().title}</strong>
            <span>{emptyState().detail}</span>
          </div>
        }>
          {(image, index) => (
            <div role="listitem">
              <button
                type="button"
                class="output-thumbnail"
                aria-label={`Open ${executedImageLabel(image, index(), images().length)}`}
                onClick={() => setViewerIndex(index())}
              >
                <span class="output-thumbnail-preview">
                  <Show when={!failed().has(image.key)} fallback={<span class="output-thumbnail-unavailable">Image unavailable</span>}>
                    <img src={image.url} alt="" onLoad={() => markLoaded(image.key)} onError={() => markFailed(image.key)} />
                  </Show>
                  <span class="output-thumbnail-position">Output {index() + 1} of {images().length}</span>
                </span>
                <ExecutedImageFacts image={image} availability={availability(image.key)} />
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={viewerIndex() !== undefined}>
        <ExecutedImageViewer images={images()} initialIndex={viewerIndex()!} provenance={provenance()} onRequestClose={() => setViewerIndex(undefined)} />
      </Show>
    </>
  )
}
