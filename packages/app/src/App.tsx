/**
 * Dinkster shell: tab bar, canvas, queue rail, outputs, problems, status.
 * It uses the real signal store and backend loop.
 */

import { createEffect, createMemo, createSignal as createSolidSignal, For, Index, on, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { BrandMark } from './BrandMark.js'
import { StatusBar } from './StatusBar.js'
import { activeLocale, asNodeId, asPromptId, canonicalJson, diag, documentIdentityOf, documentResolver, executionKey, nodeStatesFromDinksterJob, parseDinksterRuntimePath, resolveImportedNodePacks, t, type CollectionEntry, type Diagnostic, type ExtensionHostUiContributionV1, type Json, type MenuItem, type MessageParams, type ReadonlySignal, type ResolvedMenuGroup, type SharedDocumentSession } from '@dinkster/core'
import type { DinksterValuesClient, ExecutionState } from '@dinkster/client'
import CircleAlert from 'lucide-solid/icons/circle-alert'
import Database from 'lucide-solid/icons/database'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Images from 'lucide-solid/icons/images'
import Blocks from 'lucide-solid/icons/blocks'
import Library from 'lucide-solid/icons/library'
import BookOpen from 'lucide-solid/icons/book-open'
import ScrollText from 'lucide-solid/icons/scroll-text'
import Server from 'lucide-solid/icons/server'
import Settings from 'lucide-solid/icons/settings'
import Users from 'lucide-solid/icons/users'
import { backendConnectionStatus, backendMetadataError, currentGraphId, editedSubgraphDefinition, GLOBAL_PROBLEMS_OWNER, LIBRARY_SCOPE, visibleProblems, type AppState, type Backend, type CollabTabState, type Tab } from './app-state.js'
import { formatWorkflowDeepLink, resolveDeepLinkBackend } from './connection-profiles.js'
import { LogPanel } from './LogPanel.js'
import { BoundaryPanel } from './BoundaryPanel.js'
import { CanvasHost, CanvasViewControls, coreOccurrencePlanner } from './CanvasHost.js'
import { ContextMenu } from './ContextMenu.js'
import { historyRunOfEntry, historySource, packsSource, runIdOfEntry, runsSource, templatesSource, workflowsSource, type TemplateCollectionRef } from './collections.js'
import { ExecutionActivityCard, ExecutionOpenButton, executionStatusLabel } from './ExecutionActivityCard.js'
import { executionActivity } from './execution-activity.js'
import { CollectionPanel } from './CollectionPanel.js'
import { MediaDiagnostics, MediaValueInspector } from './MediaValueInspector.js'
import { mediaMetadataOf } from './media-metadata.js'
import { resolveNodeOccurrence } from './problem-display.js'
import { Icon } from './Icon.js'
import { LibraryPanel } from './LibraryPanel.js'
import { APP_EDITOR_KIND, CURVE_EDITOR_KIND, GLSL_EDITOR_KIND, GRAPH_EDITOR_KIND, type EditorHostContext } from './editors.js'
import { builtinEditorBindings, builtinEditorRoles } from './builtin-bindings.js'
import { AppView } from './AppView.js'
import { CurveEditor } from './CurveEditor.js'
import { GlslEditor } from './GlslEditor.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'
import { ProductButton } from './ProductControls.js'
import { ProductButton as SharedProductButton, ProductErrorBanner, ProductIcon, ProductIconButton, ProductMenu, ProductProjectMenu, ProductRunActivity, type ProductAttention, type ProductMenuItem, type ProductProject, ProductToast, ProductWindowAction, ProductWindowToolbar, ProductBrandMark } from '@dinkster/ui'
import PanelTop from 'lucide-solid/icons/panel-top'
import SlidersHorizontal from 'lucide-solid/icons/sliders-horizontal'
import { AccountControl, createAccountSession } from './AccountControl.js'
import '@dinkster/ui/styles.css'
import { ProductEmptyState } from './ProductSurfaces.js'
import { ExtensionsPanel } from './ExtensionsPanel.js'
import { beginRegionResize, REGION_SIZE_BOUNDS, type ShellRegion } from './shell-layout.js'
import { TemplateGallery } from './TemplateGallery.js'
import { useSignal } from './solid-adapter.js'
import { comboFromEvent, isNativeTextScopeTarget, shortcutSuppressed, type CommandRegistry, type KeybindingRegistry } from './settings.js'
import { SettingsDialog } from './SettingsDialog.js'
import { SubgraphDefinitionsDialog } from './SubgraphDefinitionsDialog.js'
import { AssetConsentDialog } from './AssetConsentDialog.js'
import { AssetsBody } from './AssetsBody.js'
import { CollabPanel } from './CollabPanel.js'
import { ImportAssetResolutionDialog } from './ImportAssetResolutionDialog.js'
import { ModalSurface } from './ModalSurface.js'
import { attachDomTooltips, resolveCanvasTooltip, TooltipController, type DomTooltipTarget } from './tooltips.js'
import { activateProblem, ProblemsPanel } from './ProblemsPanel.js'
import { useSelectionContext } from './selection-context.js'
import { RegionIterationInspector } from './RegionIterationInspector.js'
import { regionIterationInventory } from './region-iteration.js'
import { ProductSelect } from './ProductSelect.js'
import { BackendsPanel } from './BackendsPanel.js'
import { StoragePanel } from './StoragePanel.js'
import { ProjectsDialog } from './ProjectsDialog.js'
import { activeProjectId, DEFAULT_PROJECT_ID, PROJECT_URL_PARAM } from './projects.js'
import {
  desktopBridge,
  type DesktopPanelPlacement,
  type DesktopWindowContext,
  type DesktopWindowLayout,
} from './desktop-bridge.js'
import { coordinateBrowserWindows } from './browser-window-layout.js'
import { ResourcesPanel } from './ResourcesPanel.js'
import { LearnPanel } from './help/LearnPanel.js'
import { NodeHelpPanel } from './help/NodeHelpPanel.js'
import { useAppMessage } from './locale.js'
import { UniversalSearch, UniversalSearchTrigger } from './UniversalSearch.js'
import { bindSearchCatalog, registerCoreSearchProviders } from './universal-search.js'
import { NodeInstallPrompt } from './NodeInstallPrompt.js'
import { ProjectNeedsPrompt } from './ProjectNeedsPrompt.js'
import { HostUiProviderHost } from './host-ui.js'
import {
  activePanelIndicator,
  ActivityBarButton,
  DockZoneHost,
  FloatingPanelHost,
  PanelIndicatorBadge,
  ShellRegionIcon,
  ShellResizeHandle,
  ShellTooltip,
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
import { CancelExecutionButton } from './CancelExecutionButton.js'
import { ExecutedImageFacts, ExecutedImageViewer, SavedOutputFiles, ViewerImage, executionOutputProvenance, type ExecutionOutputProvenance } from './ExecutedImageViewer.js'
import { executedImageInventory, executedImageLabel, executionThumbnail, type ExecutedImage } from './executed-image-inventory.js'
import { RunThumbnail } from './RunThumbnail.js'
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

/** A Dinkster menu row that is not a command, such as the account's while the left bar is hidden. */
export interface AppMenuAction {
  readonly id: string
  readonly label: string
  readonly hint?: string
  /** Absent for a row that only informs or opens children. */
  readonly run?: () => void
  /** Rows of a submenu this row opens. */
  readonly children?: readonly AppMenuAction[]
}

const appMenuItem = (action: AppMenuAction): MenuItem => ({
  id: action.id,
  label: action.label,
  ...(action.hint ? { hint: action.hint } : {}),
  ...(action.children !== undefined
    ? { children: action.children.map(appMenuItem) }
    : { action: { kind: 'host', action: action.id }, ...(action.run === undefined ? { disabled: true } : {}) }),
})

const flatAppMenuActions = (actions: readonly AppMenuAction[]): readonly AppMenuAction[] =>
  actions.flatMap((action) => [action, ...flatAppMenuActions(action.children ?? [])])

export function DinksterAppMenu(props: {
  commands: CommandRegistry
  keybindings: KeybindingRegistry
  /** Signals that invalidate ContextMenu's deliberate per-open snapshot. */
  invalidationSignals?: () => readonly ReadonlySignal<unknown>[]
  /** Rows before the commands, in their own group. */
  account?: () => readonly AppMenuAction[]
}) {
  const message = useAppMessage()
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
  const groups = (): readonly ResolvedMenuGroup[] => [...accountGroup(), ...APP_MENU_COMMAND_GROUPS.flatMap(({ group, ids }): ResolvedMenuGroup[] => {
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
  })]
  const accountGroup = (): ResolvedMenuGroup[] => {
    const actions = props.account?.() ?? []
    return actions.length === 0 ? [] : [{
      group: '00-account',
      items: actions.map(appMenuItem),
    }]
  }
  const show = (): void => {
    const rect = button.getBoundingClientRect()
    setAnchor({ x: rect.left, y: rect.bottom + 2 })
    setOpen(true)
    const unsubscribes = props.invalidationSignals?.().map((signal) => signal.subscribe(() => close())) ?? []
    stopInvalidation = () => { for (const unsubscribe of unsubscribes) unsubscribe() }
  }
  const toggle = (): void => open() ? close() : show()
  const invoke = (item: MenuItem): void => {
    const account = flatAppMenuActions(props.account?.() ?? []).find((action) => action.id === item.id)
    if (account?.run !== undefined) {
      close()
      button.focus()
      account.run()
      return
    }
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
      <ProductWindowAction
        label={message('shell.applicationTitle')}
        labelContent={<ProductBrandMark />}
        icon={() => <ProductBrandMark />}
        ref={button}
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
      />
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
          ? `Workflow link: server ${link.backendUrl} is not connected`
          : 'Workflow link: default backend is unavailable',
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
  let shellEl!: HTMLElement
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
  const tabResultClears = useSignal(app.clearedTabResults)
  const collabTabs = useSignal(app.collabTabs)
  const executions = useSignal(app.store.executions)
  const problems = useSignal(app.problems)
  const queueRefusal = useSignal(app.queueRefusal)
  const solveDiagnostics = useSignal(app.solveDiagnostics)
  const migrationNotices = useSignal(app.migrationNotices)
  const logs = useSignal(app.logs)
  const overlayPins = useSignal(app.overlayPins)
  const lenses = useSignal(app.lenses)
  const settingsTick = useSignal(app.settings.changed)
  const defaultRegistry = useSignal(app.registry)
  const searchShortcut = (): string | undefined => {
    settingsTick()
    return app.keybindings.combo('search.open')
  }
  const appViewEnabled = createMemo((): boolean => {
    settingsTick()
    return app.appViewEnabled
  })
  const backends = useSignal(app.backends)
  const backendsTick = useSignal(app.backendsTick)
  const hostUiTick = useSignal(app.hostUiContributions.changed)
  const extensionToolbarPanels = useSignal(app.extensionToolbarPanels)
  const locale = useSignal(activeLocale)
  const message = (key: string, params?: MessageParams): string => {
    locale()
    return t(key, params)
  }
  const modalPanel = useSignal(app.modalPanel)
  const searchOpen = useSignal(app.searchOpen)
  const nodeInstallRequest = useSignal(app.nodeInstallRequest)
  const projectNeedsReview = useSignal(app.projectNeedsReview)
  const projectPackNotification = useSignal(app.projectPackNotification)
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
  // DockLayout owns membership, order, active tab, and open state for all
  // three zones. ShellLayout owns their pixel sizes and bar visibility.
  const dockLayoutState = useSignal(app.dock.state)
  const activityBarVisible = useSignal(app.shell.activityBarVisible)
  // Desktop marks the bar with its platform. On macOS the logo sits at the top
  // of the left bar, and after the window buttons while that bar is hidden.
  const [barPlatform, setBarPlatform] = createSolidSignal<string | undefined>()
  onMount(() => {
    // The bar may mount after this component, and Desktop may set the attribute later.
    const read = (): void => {
      setBarPlatform(document.querySelector<HTMLElement>('.dinkster-window-toolbar-host')?.dataset['platform'])
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-platform'] })
    onCleanup(() => observer.disconnect())
  })
  const logoInLeftBar = (): boolean => barPlatform() === 'darwin' && activityBarVisible()
  const statusBarVisible = useSignal(app.shell.statusBarVisible)
  const dockWidth = useSignal(app.shell.leftWidth)
  const railWidth = useSignal(app.shell.rightWidth)
  const bottomHeight = useSignal(app.shell.bottomHeight)
  // The in-flight resize drag's disposer: unmounting mid-drag must drop the
  // window listeners instead of leaving them until a stray pointerup.
  let endRegionResize: (() => void) | undefined
  const beginResize = (region: ShellRegion, sign: 1 | -1) => (down: PointerEvent): void => {
    endRegionResize?.()
    if (region === 'left') app.shell.previewSize(region, renderedDockWidth())
    if (region === 'right') app.shell.previewSize(region, renderedRailWidth())
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
  const builtinLibrarySources = [packsSource(app), templatesSource(app), workflowsSource(app)]
  const storedRuns = runsSource(app)
  const browserHistory = historySource(app)
  const libraryTemplatesEnabled = createMemo(() => {
    tabs()
    activeTabId()
    backendsTick()
    return app.libraryBackend()?.templatesEnabled.get() === true
  })
  const librarySources = createMemo(() => builtinLibrarySources.filter((source) => source.id !== 'templates' || libraryTemplatesEnabled()))
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
      const ref = entry.ref as TemplateCollectionRef | undefined
      const opening = ref?.kind === 'remote'
        ? app.openRemoteTemplate(ref.template, entry.title)
        : ref?.kind === 'local'
          ? app.openTemplate(ref.pack, ref.id, entry.title, entry.owner)
          : Promise.resolve(false)
      void opening.then((ok) => {
        if (ok) setPanelOpen(app.panels, app.dock, 'library', 'left', false)
      })
      return
    }
    if (sourceId !== 'runs' || entry.owner === undefined) return
    const runId = runIdOfEntry(entry)
    if (actionId === 'delete') void app.deleteHistoryRun(runId, entry.owner)
    if (actionId === 'open') void app.openRunWorkflow(runId, entry.owner)
    if (actionId === 'resubmit') void app.resubmitRunWorkflow(runId, entry.owner)
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

  const [pendingCloseOthers, setPendingCloseOthers] = createSolidSignal<readonly Tab[]>()
  const closeOthers = (tab: Tab, groupTabs: readonly Tab[]): void => {
    const others = groupTabs.filter((candidate) => candidate.id !== tab.id)
    if (others.some((candidate) => app.isTabDirty(candidate.id))) {
      setPendingCloseOthers(others)
      return
    }
    for (const other of others) requestTabClose(other, false)
  }
  const confirmCloseOthers = (): void => {
    const pending = pendingCloseOthers()
    setPendingCloseOthers(undefined)
    if (!pending || !pending.every(pendingCloseStillCurrent)) return
    for (const tab of pending) requestTabClose(tab, false)
  }
  createEffect(() => {
    const pending = pendingCloseOthers()
    if (pending && !pending.every(pendingCloseStillCurrent)) setPendingCloseOthers(undefined)
  })

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
  const [runScope, setRunScope] = createSolidSignal('workflow')
  const [selectedRunKey, setSelectedRunKey] = createSolidSignal<string>()
  const [selectedStoredRun, setSelectedStoredRun] = createSolidSignal<ExecutionState>()
  createEffect(() => { activeTabId(); setSelectedRunKey(undefined); setSelectedStoredRun(undefined) })
  const selectedRun = (): ExecutionState | undefined =>
    selectedRunKey() === undefined ? activeExecution() : executions().get(selectedRunKey()!) ??
      (selectedStoredRun()?.key === selectedRunKey() ? selectedStoredRun() : undefined)
  const hiddenHistoryExecutions = useSignal(app.hiddenHistoryExecutions)
  const workflowExecutions = (): readonly ExecutionState[] => {
    executions()
    const tab = activeTab()
    return tab ? app.executionsForTab(tab).filter((execution) => !hiddenHistoryExecutions().has(execution.key)) : []
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
    return backendConnectionStatus(b)
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

  const servicesKind = (): 'qa' | 'custom' | undefined => {
    backendsTick()
    const name = activeBackend().registry.get()?.server?.services?.name
    return name === 'qa' || name === 'custom' ? name : undefined
  }
  const servicesLabel = (): string | undefined => {
    const name = servicesKind()
    return name === 'qa' ? message('shell.services.qa')
      : name === 'custom' ? message('shell.services.custom') : undefined
  }
  const ServicesBadge = () => <Show when={servicesLabel()}>
    {(label) => <span class="services-badge" data-testid="services-badge">{label()}</span>}
  </Show>

  const ExecutionRow = (p: { exec: ExecutionState }) => {
    const live = () => liveTabOf(p.exec)
    const thumbnail = () => p.exec.status === 'queued' || p.exec.status === 'running' ? undefined : executionThumbnail(p.exec)
    return <article class="runs-row" role="listitem" data-testid="execution-row"
      data-status={p.exec.status} data-selected={selectedRun()?.key === p.exec.key}>
      <div class="runs-row-heading">
        <Show when={thumbnail()}>{(asset) => <RunThumbnail
          url={app.assetUrlForExecution(p.exec.ref, asset().digest)} mediaType={asset().mediaType} />}</Show>
        <ProductButton size="compact" variant="ghost" aria-pressed={selectedRun()?.key === p.exec.key}
          onClick={() => setSelectedRunKey(p.exec.key)}>{app.tabTitleFor(p.exec.ref)}</ProductButton>
        <span class="execution-status">{p.exec.status === 'queued' && app.store.isUnconfirmed(p.exec.ref) ? 'Unconfirmed' : executionStatusLabel(p.exec.status)}</span>
        <Show when={p.exec.submittedBy?.kind === 'agent'}><span class="collab-agent">{message('runs.agent')}</span></Show>
        <ExecutionOpenButton entry={p.exec} title={app.tabTitleFor(p.exec.ref)} onOpen={() => { void app.openExecutionView(p.exec.ref) }} />
        <CancelExecutionButton app={app} execution={p.exec} />
      </div>
      <Outputs app={app} execution={p.exec} details={<ExecutionActivityCard
          entry={p.exec}
          title={app.tabTitleFor(p.exec.ref)}
          testId="run-details"
          relation={overlayRoleOf(p.exec)}
          hideOpen
          onPin={live() ? () => {
            const tab = live()
            if (!tab) return
            if (overlayRoleOf(p.exec) === 'pinned') app.followLatestExecution(tab.id)
            else app.pinExecutionOverlay(tab.id, p.exec.ref)
          } : undefined}
        />} />
    </article>
  }

  const RunList = (p: { runs: readonly ExecutionState[] }) => <For each={p.runs.map((run) => run.key)}>
    {(key) => <Show when={executions().get(key)}>{(execution) => <ExecutionRow exec={execution()} />}</Show>}
  </For>

  // ---- Shell panels ------------------------------------------------------
  // Surfaces are registered descriptors; the sidebar, dock, and rail render
  // from the registry, so moving a surface is a descriptor change, not a
  // JSX rewrite. Bodies stay local components so they can close over App
  // state.
  const BackendMetadataState = (props: { readonly children: JSX.Element; readonly independentMounts?: boolean }) => {
    const [retrying, setRetrying] = createSolidSignal(false)
    const error = () => {
      backendsTick()
      const backend = activeBackend()
      if (props.independentMounts && backend.schemaState.get().status !== 'error') return undefined
      return backendMetadataError(backend)
    }
    const retry = async (): Promise<void> => {
      if (retrying()) return
      const backend = activeBackend()
      setRetrying(true)
      try {
        await Promise.all([
          backend.schemaState.get().status === 'error' ? app.refreshBackendSchemas(backend) : undefined,
          backend.protocol === 'dinkster' && backend.connection.mountError.get() !== undefined
            ? backend.connection.fetchMountSettings().catch(() => undefined) : undefined,
        ])
      } finally { setRetrying(false) }
    }
    return <Show when={error()} fallback={props.children}>
      {(detail) => <ProductEmptyState tone="error" title={message('shell.backend.metadataUnavailable')} hint={detail()} action={
        <ProductButton type="button" disabled={retrying()} onClick={() => void retry()}>{message('templateGallery.retry')}</ProductButton>
      } />}
    </Show>
  }
  const LibraryBody = () => (
    <BackendMetadataState>
    <LibraryPanel
      sources={librarySources()}
      backend={() => {
        const backend = activeBackend()
        return { label: backend.label, protocol: backend.protocol, status: statusOf(backend) }
      }}
      refreshTick={libraryTick}
      onActivate={activateLibraryEntry}
      onAction={libraryEntryAction}
    />
    </BackendMetadataState>
  )
  const [storageFocus, setStorageFocus] = createSolidSignal<{ readonly id: string }>()
  const openStorage = (backend = activeBackend()): void => {
    setStorageFocus({ id: backend.id })
    app.modalPanel.set('')
    setPanelOpen(app.panels, app.dock, 'storage', 'left', true)
  }
  const openBackendSettings = (backend: Backend): void => {
    app.settingsOpenRequest.set({ category: `backend:${backend.id}`, id: '' })
    app.modalPanel.set('settings')
  }
  const unregisterStorageCommand = app.frontendDoors.command('storage.open', {
    get label() { return message('storagePanel.title') },
    run: () => openStorage(),
  })
  onCleanup(unregisterStorageCommand)
  const [assetsBackendId, setAssetsBackendId] = createSolidSignal<string>()
  const activeAssetsBackendId = createMemo(() => activeBackend().id)
  createEffect(() => { activeAssetsBackendId(); setAssetsBackendId(undefined) })
  const AssetsPanelBody = () => <Show when={backends().find((backend) => backend.id === assetsBackendId()) ?? activeBackend()} keyed>
    {(backend) => {
      return backend.protocol === 'dinkster'
      ? <BackendMetadataState independentMounts><AssetsBody
          connection={backend.connection}
          backendId={String(backend.id)}
          baseUrl={backend.baseUrl}
          backendLabel={backend.label}
          onOpenStorage={() => openStorage(backend)}
        /></BackendMetadataState>
      : <ProductEmptyState title={message('shell.backend.assetsRequireNative')} />
    }}
  </Show>
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
  const [resourcesBackend, setResourcesBackend] = createSolidSignal<{ readonly id: string }>()
  const [appLogRequest, setAppLogRequest] = createSolidSignal<number>()
  const LogsBody = () => (
    <LogPanel
      entries={logs}
      appScopeRequest={appLogRequest}
      clearArmed={logsClearArmed}
      onClear={requestLogsClear}
      executions={() => { executions(); return app.executionList() }}
      active={selectedRun}
      nodeTitle={runtimeNodeTitle}
      onFocusNode={focusRuntimeNode}
      filterRequest={executionLogFocus}
      onFilterApplied={(token) => app.consumeExecutionLogFocus(token)}
    />
  )
  const selectionContext = useSelectionContext(app)
  const RunIterations = () => {
    const inspection = createMemo(() => {
      const view = selectionContext()
      const execution = selectedRun()
      if (view === undefined || execution === undefined || view.context.kind !== 'node' ||
          view.context.nodeIds.length !== 1 || view.instancePath === undefined) return undefined
      const node = view.doc.graphs[view.graphId]?.nodes[view.context.nodeIds[0]!]
      if (node?.region === undefined) return undefined
      const occurrence = { node: node.id, instancePath: view.instancePath.map(asNodeId) }
      const registry = app.registryForTab(view.tab)
      if (registry === undefined || regionIterationInventory(execution, occurrence) === undefined) return undefined
      return { view, execution, occurrence, registry }
    })
    return <Show when={inspection()}>{(current) => <RegionIterationInspector
      execution={current().execution} regionOccurrence={current().occurrence}
      document={current().view.doc} resolveSchema={current().registry.resolve}
      values={(() => { backendsTick(); return app.valuesForExecution(current().execution.ref) })()}
    />}</Show>
  }
  const storedExecution = (entry: CollectionEntry): ExecutionState | undefined => {
    executions()
    return app.executionList().find((execution) => entry.owner === undefined
      ? execution.key === entry.id
      : execution.ref.connection === entry.owner && execution.jobRef === runIdOfEntry(entry))
  }
  const StoredRun = (p: { entry: CollectionEntry; selected: () => boolean; actions: JSX.Element }) => {
    const [loaded, setLoaded] = createSolidSignal<{ execution: ExecutionState; values: DinksterValuesClient }>()
    const [loadError, setLoadError] = createSolidSignal<string>()
    const [loading, setLoading] = createSolidSignal(false)
    let requested = false
    let alive = true
    let unsubscribe: (() => void) | undefined
    onCleanup(() => {
      alive = false
      unsubscribe?.()
    })
    const load = async (): Promise<void> => {
      const entry = p.entry
      const backend = app.backends.get().find((candidate) => candidate.id === entry.owner)
      if (backend?.protocol !== 'dinkster') return
      const project = activeProjectId()
      let connectionChanged = false
      unsubscribe = backend.connection.status.subscribe(() => { connectionChanged = true })
      const current = () => alive && !connectionChanged && p.entry.id === entry.id && p.entry.owner === entry.owner &&
        activeProjectId() === project && app.backends.get().includes(backend)
      setLoading(true)
      try {
        const runId = runIdOfEntry(entry)
        const run = await backend.connection.getHistoryRun(runId, LIBRARY_SCOPE)
        if (!current()) return
        if (run === undefined || run.scope !== LIBRARY_SCOPE || (run.jobRef ?? run.runId) !== runId) throw new Error('Stored run is no longer available')
        const job = await backend.connection.fetchHistoryJob(run)
        if (!current()) return
        if (job === undefined) throw new Error('Retained outputs are no longer available')
        if (job.state === 'queued' || job.state === 'running') throw new Error('Stored run is no longer terminal')
        const rawOutputs = job.outputs
        if (rawOutputs !== undefined && (typeof rawOutputs !== 'object' || rawOutputs === null || Array.isArray(rawOutputs) ||
          !Object.values(rawOutputs).every((outputs) => typeof outputs === 'object' && outputs !== null && !Array.isArray(outputs)))) {
          throw new Error('Stored run outputs are malformed')
        }
        const execution: ExecutionState = {
          ref: { connection: backend.id, prompt: asPromptId(run.jobId) },
          key: JSON.stringify([backend.id, run.clientId, run.jobId, runId]),
          status: run.state === 'failed' ? 'error' : run.state,
          nodes: nodeStatesFromDinksterJob(job), blockedNodes: {}, expandedNodes: {}, regions: {},
          outputs: rawOutputs as ExecutionState['outputs'] ?? {}, artifacts: job.artifacts ?? [], artifactsHydrated: true,
          previews: {}, activities: [], logs: [], logsDropped: 0,
          errors: run.error?.message === undefined ? [] : [diag('error', 'runtime', 'history.failed', run.error.message)],
          jobRef: runId, ...(run.sourceDocument === undefined ? {} : { sourceDocument: run.sourceDocument }),
          queuedAt: run.submittedAt * 1000, endedAt: run.finishedAt * 1000,
        }
        const values = backend.connection.historyValues(run)
        setLoaded({ execution, values })
      } catch (error) {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (alive) setLoading(false)
      }
    }
    createEffect(() => {
      if (!p.selected()) return
      const known = storedExecution(p.entry)
      const inspected = loaded()?.execution
      setSelectedStoredRun(known === undefined ? inspected : undefined)
      setSelectedRunKey(known?.key ?? inspected?.key ?? p.entry.id)
      if (known === undefined && !requested) { requested = true; void load() }
    })
    const thumbnail = () => {
      backendsTick()
      const asset = historyRunOfEntry(p.entry)?.thumbnail
      const backend = app.backends.get().find((candidate) => candidate.id === p.entry.owner)
      return asset !== undefined && backend?.protocol === 'dinkster'
        ? { url: backend.connection.assetUrl(asset.digest), mediaType: asset.mediaType } : undefined
    }
    const Facts = () => <>
      <dl class="output-facts"><For each={p.entry.details}>{(detail) => <div><dt>{detail.label}</dt><dd>{detail.text}</dd></div>}</For></dl>
    </>
    return <div class="runs-stored-row">
      <div class="runs-row-heading">
        <Show when={thumbnail()}>{(asset) => <RunThumbnail url={asset().url} mediaType={asset().mediaType} />}</Show>
        <strong>{p.entry.title}</strong>
        <Show when={storedExecution(p.entry)?.artifact && storedExecution(p.entry)}>{(execution) =>
          <ExecutionOpenButton entry={execution()} title={p.entry.title} onOpen={() => { void app.openExecutionView(execution().ref) }} />
        }</Show>
      </div>
      <p>{p.entry.subtitle}</p>
      <div class="collection-badges"><For each={p.entry.badges}>{(badge) => <span class="collection-badge">{badge}</span>}</For></div>
      <Show when={loading()}><p role="status">{message('runs.loading')}</p></Show>
      <Show when={loadError()}>{(error) => <p role="status" title={message('runs.loadError', { error: error() })}>{message('runs.loadError', { error: error() })}</p>}</Show>
      <Show when={storedExecution(p.entry)} fallback={<Show when={loaded()} fallback={<details class="runs-details" onClick={(event) => event.stopPropagation()}>
        <summary>{message('runs.details')}</summary><Facts />
      </details>}>{(source) => <Outputs app={app} execution={source().execution} source={source()} details={<Facts />} />}</Show>}>
        {(execution) => <>
          <CancelExecutionButton app={app} execution={execution()} />
          <Outputs app={app} execution={execution()} details={<Facts />} />
        </>}
      </Show>
      <Show when={p.selected()}>{p.actions}</Show>
    </div>
  }
  const pendingRuns = () => {
    executions()
    return app.executionList().filter((execution) => execution.status === 'queued' || execution.status === 'running')
  }
  const allWorkflowActivity = () => {
    executions()
    return executionActivity(app.executionList())
  }
  const runsActivity = () => {
    executions()
    const tab = activeTab()
    return executionActivity(runScope() === 'all' ? app.executionList() : tab ? app.executionsForTab(tab) : [])
  }
  const RunsPanel = () => (
    <div class="rail-panel-body runs-panel" data-testid="runs-panel">
      <ProductSelect testId="runs-scope" ariaLabel={message('runs.scope')}
        selectedId={runScope()} options={[
          { id: 'workflow', label: message('runs.scope.workflow'), value: 'workflow' },
          { id: 'all', label: message('runs.scope.all'), value: 'all' },
        ]} onSelect={(option) => setRunScope(option.value)} />
      <Show when={runsActivity().running > 0 || runsActivity().waiting > 0}>
        <ProductRunActivity running={runsActivity().running} waiting={runsActivity().waiting}
          label={message('runs.activity', runsActivity())} />
      </Show>
      <Show when={runScope() === 'workflow'} fallback={<>
        <Show when={clearArmed() && clearArmOwner === activeBackend().id}>
          <ProductNotice tone="info" testId="runs-clear-confirmation">{message('runs.clear.confirmation')}</ProductNotice>
        </Show>
        <Show when={activeBackend().protocol === 'dinkster'}>
          <div role="list" aria-label={message('runs.pending')}>
            <RunList runs={pendingRuns()} />
          </div>
        </Show>
        <CollectionPanel sources={[activeBackend().protocol === 'dinkster' ? storedRuns : browserHistory]}
          listOnly refreshTick={libraryTick} searchLabel={message('runs.search')}
          renderState={(state) => state.kind === 'empty' && activeBackend().protocol === 'dinkster'
            ? <ProductEmptyState title={message('runs.stored.empty')} /> : undefined}
          entryContent={(entry, selected, actions) => <StoredRun entry={entry()} selected={selected} actions={actions} />}
          onAction={libraryEntryAction}
          sourceActions={[{ sourceId: 'runs', id: 'clear', label: message(clearArmed() ? 'runs.clear.confirm' : 'runs.clear.action') }]}
          onSourceAction={librarySourceAction} />
      </>}>
      <Show when={workflowExecutions().length > 0} fallback={<ProductEmptyState title={message('runs.empty')} />}>
        <For each={executionGroups().map((group) => group.id)}>
          {(id) => <Show when={executionGroups().find((group) => group.id === id)}>{(group) => (
            <div class="backend-group" role="list" aria-label={group().backend?.label ?? `${id} removed backend executions`}>
              <Show when={multiBackend() || group().backend === undefined}>
                <h3
                  class="backend-group-title"
                  classList={{ disconnected: group().backend === undefined }}
                  data-testid="backend-group"
                  data-connection={id}
                  role={group().backend === undefined ? 'status' : undefined}
                >
                  {group().backend?.label ?? `${id} - backend removed or disconnected`}
                </h3>
              </Show>
              <RunList runs={group().execs} />
            </div>
          )}</Show>}
        </For>
        <RunIterations />
      </Show>
      </Show>
    </div>
  )
  // The indicator always counts the full list, regardless of the selection filter.
  const problemDiagnostics = (): readonly Diagnostic[] => {
    const execution = activeExecution()
    return [
      ...solveDiagnostics(),
      ...visibleProblems(problems(), new Set([activeTabId()])),
      ...(activeTab()?.execution ? execution?.artifact?.diagnostics ?? [] : []),
      ...(execution?.errors ?? []),
    ]
  }
  const importedNodes = () => {
    boundaryStateTick()
    backendsTick()
    const tab = activeTab()
    if (tab === undefined || tab.execution || tab.store.doc.ext?.['importer.comfyWorkflow'] === undefined) return []
    return resolveImportedNodePacks(tab.store.doc, app.registryForTab(tab)?.resolve ?? (() => undefined))
  }
  const problemsIndicator = (): PanelIndicator | undefined => {
    const list = problemDiagnostics()
    const notice = migrationNotices().get(activeTabId())
    const missingPackCount = new Set(importedNodes().filter((node) => node.status === 'installable').map((node) => node.pack)).size
    if (list.length === 0 && notice === undefined && missingPackCount === 0) return undefined
    const severity = list.some((d) => d.severity === 'error')
      ? 'error'
      : missingPackCount > 0 || list.some((d) => d.severity === 'warning') || notice?.entries.some((d) => d.severity === 'warning') ? 'warning' : 'info'
    const count = list.length + (notice === undefined ? 0 : 1) + missingPackCount
    return {
      count,
      severity,
      label: message('shell.status.problems', { count, severity }),
    }
  }
  const learnBackend = createMemo<Backend | undefined>(() => {
    backendsTick()
    const available = (backend: Backend): boolean =>
      backendConnectionStatus(backend) === 'connected' && backend.guidesAvailable.get()
    const active = activeBackend()
    return available(active) ? active : backends().find(available)
  })
  const registerBuiltinPanel = (descriptor: import('./panels.js').PanelDescriptor): (() => void) =>
    app.frontendDoors.panel(descriptor.id, descriptor)
  const unregisterPanels = [
    registerBuiltinPanel({
      id: 'library', get title() { return message('shell.panel.library.title') }, icon: Library,
      get description() { return message('shell.panel.library.description') }, get ariaLabel() { return message('shell.panel.library.ariaLabel') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 10,
      toggleTestId: 'library-toggle', component: LibraryBody,
    }),
    registerBuiltinPanel({
      id: 'learn', get title() { return message('learn.panel.title') }, icon: BookOpen,
      get description() { return message('learn.panel.description') }, get ariaLabel() { return message('learn.panel.ariaLabel') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 25,
      when: () => learnBackend() !== undefined,
      toggleTestId: 'learn-toggle', component: () => {
        return <LearnPanel
          backend={learnBackend()}
          locale={locale().tag}
          templatesEnabled={learnBackend()?.templatesEnabled.get() === true}
          onOpenTemplate={(pack, template, title, owner) => { void app.openTemplate(pack, template, title, owner) }}
        />
      },
    }),
    registerBuiltinPanel({
      id: 'assets', get title() { return message('shell.panel.assets.title') }, icon: Images,
      get description() { return message('shell.panel.assets.description') }, get ariaLabel() { return message('shell.panel.assets.title') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 15,
      toggleTestId: 'assets-toggle', component: AssetsPanelBody,
    }),
    registerBuiltinPanel({
      id: 'logs', get title() { return message('shell.panel.log.title') }, icon: ScrollText,
      get description() { return message('shell.panel.log.description') }, get ariaLabel() { return message('shell.panel.log.title') },
      placement: 'bottom', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 20,
      toggleTestId: 'logs-toggle',
      component: LogsBody,
    }),
    registerBuiltinPanel({
      id: 'storage', get title() { return message('storagePanel.title') }, icon: FolderOpen,
      get description() { return message('storagePanel.description') }, get ariaLabel() { return message('storagePanel.title') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 29,
      toggleTestId: 'storage-sidebar-toggle', component: () => <StoragePanel app={app} focusBackend={storageFocus()} activeBackend={activeBackend}
        onOpenAssets={(backend) => {
          setAssetsBackendId(backend.id)
          setPanelOpen(app.panels, app.dock, 'assets', 'left', true)
        }} />,
    }),
    registerBuiltinPanel({
      id: 'backends', get title() { return message('shell.panel.backends.title') }, icon: Server,
      get description() { return message('shell.panel.backends.description') }, get ariaLabel() { return message('shell.panel.backends.title') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 30,
      toggleTestId: 'backends-sidebar-toggle', component: () => <BackendsPanel app={app} activeBackendId={activeBackend().id}
        onOpenStorage={openStorage} onOpenSettings={openBackendSettings}
        onOpenResources={(backend) => {
          setResourcesBackend({ id: backend.id })
          setPanelOpen(app.panels, app.dock, 'memory', 'left', true)
        }} />,
    }),
    registerBuiltinPanel({
      id: 'memory', get title() { return message('shell.panel.memory.title') }, icon: Database,
      get description() { return message('shell.panel.memory.description') }, get ariaLabel() { return message('shell.panel.memory.ariaLabel') },
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 35,
      toggleTestId: 'memory-sidebar-toggle', component: () => <ResourcesPanel backends={backends()} activeBackendId={activeBackend().id} focusBackend={resourcesBackend()} />,
    }),
    registerBuiltinPanel({
      id: 'runs', get title() { return message('shell.panel.runs.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 10,
      component: RunsPanel,
    }),
    registerBuiltinPanel({
      id: 'extensions', get title() { return message('shell.panel.extensions.title') }, icon: Blocks,
      placement: 'dock', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 20,
      toggleTestId: 'extensions-toggle',
      component: () => <ExtensionsPanel host={app.extensions} />,
    }),
    registerBuiltinPanel({
      id: 'boundary', get title() { return message('shell.panel.boundary.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 40,
      indicator: boundaryIndicator,
      when: () => {
        boundaryStateTick()
        const tab = activeTab()
        return tab !== undefined && currentGraphId(tab) !== tab.store.doc.root
      },
      component: () => <BoundaryPanel app={app} />,
    }),
    registerBuiltinPanel({
      id: 'node-help', get title() { locale(); return t('nodeHelp.panel.title') },
      get description() { locale(); return t('nodeHelp.panel.description') },
      get ariaLabel() { locale(); return t('nodeHelp.panel.ariaLabel') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 30,
      component: () => <NodeHelpPanel app={app} locale={locale().tag} />,
    }),
    registerBuiltinPanel({
      id: 'problems', get title() { return message('shell.panel.problems.title') },
      placement: 'rail', allowedPlacements: ['dock', 'rail', 'bottom', 'floating', 'window'], order: 20,
      indicator: problemsIndicator,
      component: () => <ProblemsPanel app={app} diagnostics={problemDiagnostics}
        importedNodes={importedNodes}
        migrationNotice={() => migrationNotices().get(activeTabId())}
        compatSkips={() => activeBackend().compatSkips.get()}
        packInferenceUnavailable={() => activeBackend().packInferenceUnavailable.get()}
        selection={selectionContext} />,
    }),
    // Settings is the modal host's proving resident: the body is
    // placement-agnostic (SettingsDialog owns content, the host owns
    // backdrop/title/close/Escape), opened via app.modalPanel ('settings'
    // button, Ctrl+, command).
    registerBuiltinPanel({
      id: 'settings', get title() { return message('shell.panel.settings.title') },
      get description() { return message('shell.panel.settings.description') }, get ariaLabel() { return message('shell.panel.settings.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 10,
      component: () => <SettingsDialog
        settings={app.settings}
        commands={app.commands}
        keybindings={app.keybindings}
        request={app.settingsOpenRequest.get()}
        onRequestConsumed={() => app.settingsOpenRequest.set(undefined)}
        storageConnection={activeBackend().connection}
        backends={backends()}
        onOpenStorage={() => openStorage()}
        packSettings={'fetchPackSettings' in app.connection ? {
          client: app.connection,
          packs: () => [...(defaultRegistry()?.packs ?? [])]
            .filter(([, info]) => info.settings === true)
            .map(([id, info]) => ({ id, displayName: info.displayName })),
        } : undefined}
      />,
    }),
    registerBuiltinPanel({
      id: 'projects', get title() { return message('shell.panel.projects.title') },
      get description() { return message('shell.panel.projects.description') }, get ariaLabel() { return message('shell.panel.projects.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 18,
      component: () => <ProjectsDialog connection={activeBackend().connection} onSwitch={switchProject} onOpenWindow={openProjectWindow} focusNewProject={projectsFocusNew()} />,
    }),
    registerBuiltinPanel({
      id: 'subgraph-definitions', get title() { return message('shell.panel.subgraphDefinitions.title') },
      get description() { return message('shell.panel.subgraphDefinitions.description') }, get ariaLabel() { return message('shell.panel.subgraphDefinitions.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 17,
      component: () => <SubgraphDefinitionsDialog app={app} />,
    }),
    registerBuiltinPanel({
      id: 'collab', get title() { return message('shell.panel.workspace.title') },
      get description() { return message('shell.panel.workspace.description') }, get ariaLabel() { return message('shell.panel.workspace.title') },
      placement: 'modal', allowedPlacements: ['modal'], order: 20,
      component: (surface) => <CollabPanel app={app} requestClose={() => surface.requestClose()} />,
    }),
  ]
  onCleanup(() => {
    for (const un of unregisterPanels) un()
  })
  const templatesAvailable = createMemo(() => {
    backendsTick()
    return backends().some((backend) => backend.templatesEnabled.get())
  })
  createEffect(() => {
    if (!templatesAvailable()) {
      app.templateGalleryOpen.set(false)
      return
    }
    const unregisterSetting = app.settings.register({
      id: 'templates.registryUrl',
      get name() { return t('settings.templates.registryUrl.name') },
      get description() { return t('settings.templates.registryUrl.description') },
      category: 'templates', type: 'string', defaultValue: '',
    })
    const unregisterCommand = app.frontendDoors.command('workflow.openTemplateGallery', {
      get label() { return t('command.workflow.openTemplateGallery') },
      run: () => app.templateGalleryOpen.set(true),
      enabled: () => app.activeTab() !== undefined && app.activeTab()?.execution === undefined && activeBackend().templatesEnabled.get(),
    })
    onCleanup(() => { unregisterCommand(); unregisterSetting() })
  })
  // The center region resolves every editor through EditorRegistry rather
  // than shell JSX branches.
  const GraphEditor = (editorProps: { readonly host?: EditorHostContext }) => {
    const tabs = useSignal(app.tabs)
    const globalActiveTabId = useSignal(app.activeTabId)
    const galleryRequested = useSignal(app.templateGalleryOpen)
    const [documentRevision, setDocumentRevision] = createSolidSignal(0)
    const activeTabId = () => editorProps.host?.tabId() ?? globalActiveTabId()
    const activeEditorTab = () => tabs().find((tab) => tab.id === activeTabId())
    const [sessionFailed, setSessionFailed] = createSolidSignal(false)
    const [recovering, setRecovering] = createSolidSignal(false)
    createEffect(() => {
      const store = activeEditorTab()?.store
      if (store === undefined || !('status' in store)) {
        setSessionFailed(false)
        return
      }
      const status = (store as SharedDocumentSession).status
      const update = () => setSessionFailed(status.get() === 'error' || status.get() === 'closed')
      update()
      onCleanup(status.subscribe(update))
    })
    const recover = async (): Promise<void> => {
      const tab = activeEditorTab()
      if (!tab || recovering()) return
      setRecovering(true)
      try {
        const recovered = await app.recoverWorkflow(tab.id, message('shell.workflow.recovery.title', { title: tab.title }))
        if (recovered && managedContext().kind === 'workflow') redockCurrentWindow()
      } finally {
        setRecovering(false)
      }
    }
    createEffect(() => {
      const tab = activeEditorTab()
      if (tab === undefined) return
      setDocumentRevision((value) => value + 1)
      const unsubscribe = tab.store.document.subscribe(() => setDocumentRevision((value) => value + 1))
      onCleanup(unsubscribe)
    })
    const empty = (): boolean => {
      documentRevision()
      const tab = activeEditorTab()
      if (tab === undefined) return false
      const root = tab.store.doc.graphs[tab.store.doc.root]
      return root !== undefined && Object.keys(root.nodes).length === 0
    }
    const close = (): void => {
      app.templateGalleryOpen.set(false)
    }
    return <div class="graph-editor-with-gallery">
      <div class="graph-editor-canvas">
        <Show when={!sessionFailed()} fallback={
          <ProductEmptyState tone="error" testId="workflow-session-recovery" icon={<Icon icon={CircleAlert} />}
            title={message('shell.workflow.recovery.failed')}
            hint={message('shell.workflow.recovery.description')}
            action={<ProductButton variant="primary" loading={recovering()} onClick={() => void recover()}>
              {message('shell.workflow.recovery.action')}
            </ProductButton>} />
        }>
          <CanvasHost app={app} tooltips={tooltips} occurrencePlanner={coreOccurrencePlanner}
            {...(editorProps.host !== undefined ? { host: editorProps.host } : {})}
            />
        </Show>
      </div>
      <Show when={activeBackend().templatesEnabled.get() && empty() && !galleryRequested()}>
        <ProductButton class="template-gallery-open" type="button" onClick={() => app.templateGalleryOpen.set(true)}>
          {message('templateGallery.open')}
        </ProductButton>
      </Show>
      <Show when={activeBackend().templatesEnabled.get()}>
        <TemplateGallery app={app} visible={galleryRequested} onClose={close} />
      </Show>
    </div>
  }
  const unregisterEditors = app.frontendDoors.editor(GRAPH_EDITOR_KIND, {
    roles: builtinEditorRoles(GRAPH_EDITOR_KIND),
    get title() { return message('shell.editor.graph') },
    component: (host) => <GraphEditor {...(host !== undefined ? { host } : {})} />,
  })
  onCleanup(unregisterEditors)
  createEffect(() => {
    if (!appViewEnabled()) return
    onCleanup(app.frontendDoors.editor(APP_EDITOR_KIND, {
      roles: builtinEditorRoles(APP_EDITOR_KIND),
      get title() { return message('shell.editor.appView') },
      component: (host) => <AppView app={app} {...(host !== undefined ? { host } : {})} />,
    }))
    for (const { id, ...binding } of builtinEditorBindings.filter((binding) => binding.editor === APP_EDITOR_KIND)) {
      onCleanup(app.frontendDoors.editorBinding(id, binding))
    }
  })
  const unregisterCurveEditor = app.frontendDoors.editor(CURVE_EDITOR_KIND, {
    roles: builtinEditorRoles(CURVE_EDITOR_KIND),
    get title() { return message('shell.editor.curve') },
    component: (host) => <CurveEditor app={app} {...(host !== undefined ? { host } : {})} />,
  })
  onCleanup(unregisterCurveEditor)
  const unregisterGlslEditor = app.frontendDoors.editor(GLSL_EDITOR_KIND, {
    roles: builtinEditorRoles(GLSL_EDITOR_KIND),
    get title() { return message('shell.editor.glsl') },
    component: (host) => <GlslEditor app={app} {...(host !== undefined ? { host } : {})} />,
  })
  onCleanup(unregisterGlslEditor)
  const unregisterEditorBindings = builtinEditorBindings.filter((binding) => binding.editor !== APP_EDITOR_KIND).map(({ id, ...binding }) =>
    app.frontendDoors.editorBinding(id, binding))
  onCleanup(() => unregisterEditorBindings.reverse().forEach((unregister) => unregister()))
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
    dispatchAppCommandKey(app, e, activeTab() !== undefined)
  }
  window.addEventListener('keydown', onCommandKeyDown)
  onCleanup(() => window.removeEventListener('keydown', onCommandKeyDown))
  const unregisterSearch = registerCoreSearchProviders(app)
  const unbindSearchCatalog = bindSearchCatalog(app)
  onCleanup(unbindSearchCatalog)
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
    app.frontendDoors.command('view.focusNextEditorGroup', {
      get label() { return message('command.view.focusNextEditorGroup') },
      run: () => focusEditorGroupByOffset(1),
    }),
    app.frontendDoors.command('view.focusPreviousEditorGroup', {
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
  const railPanels = () => railView().panels
  // Aggregate rail-panel indicators onto the region toggle, so attention
  // stays discoverable while the rail is collapsed or the panel's tab is
  // clipped into the overflow menu.
  const railIndicator = (): PanelIndicator | undefined =>
    aggregatePanelIndicators(railPanels().map((panel) => panel.indicator?.()))
  const railAttention = (): ProductAttention | undefined => {
    const indicator = railIndicator()
    return indicator && {
      count: indicator.count,
      tone: indicator.severity === 'error' ? 'problem' : indicator.severity,
      label: indicator.label,
    }
  }
  const railActiveId = () => railView().activeId
  const leftOpen = () => zoneOpen('left') && leftPanels().length > 0
  const bottomOpen = () => zoneOpen('bottom') && bottomZonePanels().length > 0
  let bodyElement!: HTMLDivElement
  const [sideSpace, setSideSpace] = createSolidSignal<{ single: number; both: number }>()
  onMount(() => {
    if (managedContext().kind === 'panel') return
    const sidebar = bodyElement.querySelector<HTMLElement>(':scope > .left-sidebar')!
    const measure = (): void => {
      const style = getComputedStyle(bodyElement)
      const gap = Number.parseFloat(style.columnGap) || 0
      const sidebarWidth = sidebar.getBoundingClientRect().width
      const available = bodyElement.clientWidth - Number.parseFloat(style.paddingLeft)
        - Number.parseFloat(style.paddingRight) - sidebarWidth - (sidebarWidth > 0 ? gap : 0) - 320
      setSideSpace(bodyElement.clientWidth <= 520
        ? undefined
        : { single: Math.max(0, available - gap), both: Math.max(0, available - 2 * gap) })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(bodyElement)
    observer.observe(sidebar)
    measure()
    onCleanup(() => observer.disconnect())
  })
  const renderedDockWidth = () => Math.min(dockWidth(), Math.max(REGION_SIZE_BOUNDS.left.min, sideSpace()?.single ?? dockWidth()))
  const renderedRailWidth = () => Math.min(railWidth(), Math.max(REGION_SIZE_BOUNDS.right.min, sideSpace()?.single ?? railWidth()))
  let previousRailOpen = railOpen()
  createEffect(() => {
    const right = railOpen()
    const left = leftOpen()
    const space = sideSpace()?.both
    const openedRail = right && !previousRailOpen
    previousRailOpen = right
    if (space !== undefined && left && right && dockWidth() + railWidth() > space) {
      // Preserve a newly opened region; shrinking the window closes the rail.
      app.dock.setOpen(openedRail ? 'left' : 'right', false)
    }
  })
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
        const overflowButton = element.querySelector<HTMLElement>('[data-panel-title], [data-testid="dock-zone-overflow-button"]')
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
      ? down.target.closest<HTMLElement>('.dock-zone .product-tab[data-tab-id], .dock-zone [data-panel-title][data-tab-id]')
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
    const invalidateSnapshot = (event: Event): void => {
      const scroller = event.target
      if (event.type === 'scroll' && scroller instanceof Element && bodyElement.contains(scroller)) {
        const panelBody = scroller.closest('.dock-zone .product-tabpanel')
        // Scrolling panel content cannot move its enclosing drop box. Anything
        // containing the source or measured geometry still invalidates it.
        if (panelBody !== null && scroller !== panelBody && !scroller.contains(target)
          && ![...bodyElement.querySelectorAll(
            '.canvas-pane, .editor-split-region, .dock-zone, .dock-zone-section, .product-tabpanel, .product-tablist, .product-tab, [data-testid="dock-zone-overflow-button"]',
          )].some((element) => scroller.contains(element))) return
      }
      rollback()
    }
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
            const handle = destinationZone === 'left' && activityBarVisible() ? '[data-panel-title]' : '.product-tab'
            bodyElement.querySelector<HTMLElement>(
              `.dock-zone[data-zone="${destinationZone}"] ${handle}[data-tab-id="${CSS.escape(panelId)}"]`,
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
  /** The layout menu holds the region switches the bar is not showing, then Reset layout. */
  const layoutMenuItems = (narrow: boolean): readonly ProductMenuItem[] => [
    ...(narrow ? [
      { label: message('shell.layout.leftPanel'), checked: leftOpen(), disabled: leftPanels().length === 0, onSelect: toggleLeftRegion },
      { label: message('shell.layout.bottomPanel'), checked: bottomOpen(), disabled: bottomZonePanels().length === 0, onSelect: toggleBottomRegion },
      { label: message('shell.layout.rightPanel'), checked: railOpen(), attention: railAttention(), onSelect: () => app.dock.setOpen('right', !railOpen()) },
    ] : []),
    { label: message('shell.layout.leftBar'), checked: activityBarVisible(), onSelect: () => app.shell.activityBarVisible.update((visible) => !visible) },
    { label: message('shell.layout.statusBar'), checked: statusBarVisible(), onSelect: () => app.shell.statusBarVisible.update((visible) => !visible) },
    {
      label: message('shell.layout.reset'),
      onSelect: () => {
        app.shell.resetVisibility()
        app.dock.resetOpen()
      },
    },
  ]
  let layoutMenu!: HTMLSpanElement
  const layoutMenuRequests = useSignal(app.layoutMenuRequests)
  // The command opens the layout menu like a click, or focuses its first item when it is open,
  // and focus goes back to where it was when the menu closes. A menu item that runs the
  // command restores focus to its own trigger first, so this waits for that.
  createEffect(on(layoutMenuRequests, () => queueMicrotask(() => {
    const trigger = layoutMenu.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    if (trigger === null) return
    if (trigger.getAttribute('aria-expanded') === 'true') {
      document.getElementById(trigger.getAttribute('aria-controls') ?? '')
        ?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
      return
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    trigger.click()
    const observer = new MutationObserver(() => {
      if (trigger.getAttribute('aria-expanded') === 'true') return
      observer.disconnect()
      if (previous?.isConnected && (document.activeElement === trigger || document.activeElement === document.body)) previous.focus()
    })
    observer.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded'] })
  }), { defer: true }))
  const [projectName, setProjectName] = createSolidSignal<string>()
  const primaryConnected = createMemo(() => {
    const backend = backends()[0]
    return backend !== undefined && statusOf(backend) === 'connected' ? backend : undefined
  })
  // The name is read again when a modal closes, since the Projects dialog renames projects.
  createEffect(() => {
    const backend = primaryConnected()
    if (backend === undefined || modalPanel() !== '') return
    const controller = new AbortController()
    backend.connection.getProject(activeProjectId(), controller.signal)
      .then((project) => setProjectName(project.name), () => {})
    onCleanup(() => controller.abort())
  })
  const account = createAccountSession(() => app.connection)
  const [projectList, setProjectList] = createSolidSignal<readonly ProductProject[]>()
  const [projectListFailed, setProjectListFailed] = createSolidSignal(false)
  const [projectsFocusNew, setProjectsFocusNew] = createSolidSignal(false)
  let projectListRead: AbortController | undefined
  // The menu shows the first page of projects, read again each time it opens.
  const readProjectList = (): void => {
    projectListRead?.abort()
    setProjectListFailed(false)
    const backend = primaryConnected()
    if (backend === undefined) {
      setProjectListFailed(true)
      return
    }
    const controller = new AbortController()
    projectListRead = controller
    backend.connection.listProjects(undefined, controller.signal).then((page) => {
      setProjectListFailed(false)
      setProjectList(page.items.filter((project) => !project.deleted).map(({ id, name }) => ({ id, name })))
    }, () => {
      if (!controller.signal.aborted) setProjectListFailed(true)
    })
  }
  onCleanup(() => projectListRead?.abort())
  const openProjects = (focusNewProject: boolean): void => {
    setProjectsFocusNew(focusNewProject)
    app.modalPanel.set('projects')
  }
  // The account lives in the left bar. While that bar is hidden the Dinkster menu
  // carries it as one row that opens the left bar button's menu, so Settings stays in view.
  const accountMenuActions = (): readonly AppMenuAction[] => {
    const status = account.status()
    if (activityBarVisible() || status?.available !== true) return []
    if (account.pending()) {
      return [{ id: 'account', label: message('shell.account.signingIn'), children: [
        ...(account.authorizationUrl() === undefined ? [] : [{ id: 'account.openSignInPage', label: message('shell.account.openSignInPage'), run: () => account.openSignInPage() }]),
        { id: 'account.cancelSignIn', label: message('shell.account.cancelSignIn'), run: () => account.cancelSignIn() },
      ] }]
    }
    if (status.signedIn) {
      const name = status.profile?.displayName?.trim() || ''
      const email = status.profile?.email?.trim() || ''
      const identity = name || email || message('shell.account.signedIn')
      return [{ id: 'account', label: identity, children: [
        { id: 'account.identity', label: identity, ...(name && email && email !== name ? { hint: email } : {}) },
        { id: 'account.signOut', label: message('shell.account.signOut'), run: () => account.signOut() },
      ] }]
    }
    return status.signInUnavailableReason === 'account-sign-in-requires-engine-machine'
      ? [{ id: 'account.signIn', label: message('shell.account.signInRequiresEngineMachine') }]
      : [{ id: 'account.signIn', label: message('shell.account.signIn'), run: () => account.signIn() }]
  }
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
    if (zone === 'left' && activityBarVisible() && activeId !== undefined) focusPanelToggle(activeId)
    else queueMicrotask(() => shellEl.querySelector<HTMLButtonElement>(`[data-testid="${zone === 'bottom' ? 'bottom' : 'left'}-panel-toggle"]`)?.focus())
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
    const paneTarget = (): Backend | undefined => {
      backendsTick()
      tabTargets()
      const tab = paneActiveTab()
      return tab && !tab.execution ? app.backendForTab(tab) : undefined
    }
    const host: EditorHostContext = {
      tabId: () => group().activeTabId,
      focused: () => paneFocused(),
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
    const [paneGraphStack, setPaneGraphStack] = createSolidSignal<readonly string[]>([])
    createEffect(() => {
      const tab = paneActiveTab()
      if (!tab) {
        setPaneGraphStack([])
        return
      }
      setPaneGraphStack(tab.graphStack.get())
      const unsubscribe = tab.graphStack.subscribe((stack) => setPaneGraphStack(stack))
      onCleanup(unsubscribe)
    })
    const paneCommandScope = createMemo(() => ({ tab: paneActiveTab(), store: paneActiveTab()?.store, stack: paneGraphStack() }))
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
    onMount(() => {
      // Minimap gestures stop propagation; focus before any control handles them.
      sectionElement.addEventListener('pointerdown', focusPane, true)
      onCleanup(() => sectionElement.removeEventListener('pointerdown', focusPane, true))
    })
    return (
      <section
        class="editor-group"
        classList={{ focused: paneFocused() }}
        data-testid="editor-group"
        data-group-id={p.groupId}
        data-focused={paneFocused() ? 'true' : 'false'}
        style={paneRect() !== undefined ? rectStyle(paneRect()!) : { display: 'none' }}
        onFocusIn={focusPane}
        ref={sectionElement}
      >
        <div class="tab-strip">
          <WorkflowTabs
            tabs={groupTabs()}
            activeId={group().activeTabId}
            draggedId={tabDrag()?.sourceGroupId === p.groupId ? tabDrag()?.tabId : undefined}
            insertionIndex={tabDrag()?.sourceGroupId === p.groupId ? tabDrag()?.insertionIndex : undefined}
            runState={(tab) => {
              executions()
              tabResultClears()
              return app.tabRunState(tab)
            }}
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
            onRename={(tab, title) => app.renameTab(tab.id, title)}
            onDuplicate={(tab) => {
              void app.duplicateTab(tab.id).then((copy) => {
                if (!copy) return
                updateSplitLayout((layout) => {
                  const source = findGroup(layout, p.groupId)
                  return source ? moveTabToGroup(layout, copy.id, p.groupId, source.tabIds.indexOf(tab.id) + 1) : layout
                })
              })
            }}
            onCloseOthers={managedContext().kind === 'primary' ? (tab) => closeOthers(tab, groupTabs()) : undefined}
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
            targets={backends()}
            targetId={(tab) => {
              tabTargets()
              return app.backendForTab(tab).id
            }}
            onSetTarget={(tab, id) => {
              const backend = backends().find((candidate) => candidate.id === id)
              if (backend) app.setTabTarget(tab.id, backend.id)
            }}
            previews={(tab) => tab.store.doc.previews}
            onSetPreviews={(tab, mode) => {
              if (tab.execution !== undefined) return
              app.dispatchTo(tab, { command: 'workflow.setPreviews', params: { previews: mode } })
            }}
          />
          <Show when={multiBackend() && paneTarget()}>
            {(target) => (
              <ProductSelect
                class="tab-target"
                testId="tab-target"
                dataAttributes={{ 'data-tooltip-label': message('shell.workflow.queueBackend') }}
                ariaLabel={message('shell.workflow.queueBackend')}
                selectedId={target().id}
                options={backends().map((backend) => ({ id: backend.id, label: backend.label, value: backend.id }))}
                onSelect={(option) => {
                  const tab = paneActiveTab()
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
              <ProductButton variant="primary" type="button" onClick={() => app.createWorkflow()}>{message('shell.workflow.new')}</ProductButton>
            </div>
          </Show>
          <Show when={managedContext().kind === 'workflow' && !paneActiveTab()}>
            <div class="detached-workspace-state" data-testid="detached-workflow-missing">
              <h2>{message('shell.workflow.unavailable.title')}</h2>
              <p>{message('shell.workflow.unavailable.description')}</p>
              <ProductButton type="button" onClick={redockCurrentWindow}>{message('shell.window.moveToMain')}</ProductButton>
            </div>
          </Show>
          <div class="canvas-stage-toolbar" ref={(toolbar) => {
            onMount(() => {
              const stage = toolbar.parentElement!
              const measure = (): void => {
                stage.style.setProperty('--canvas-toolbar-bottom', `${toolbar.offsetTop + toolbar.offsetHeight}px`)
              }
              const observer = new ResizeObserver(measure)
              observer.observe(toolbar)
              measure()
              onCleanup(() => observer.disconnect())
            })
          }}>
            <CanvasViewControls
              drilled={paneEditorKind() === GRAPH_EDITOR_KIND && paneGraphStack().length > 1}
              disabled={!paneActiveTab() || paneActiveTab()!.execution !== undefined}
              activeView={paneEditorKind()}
              appViewEnabled={appViewEnabled()}
              activeLens={paneCanvasLens()}
              lenses={app.lensRegistry.list().filter((lens) => lens.id !== 'exposure' || appViewEnabled())}
              viewMenuOpen={viewMenu()}
              lensMenuOpen={lensMenu()}
              onToggleViewMenu={() => { setLensMenu(false); setViewMenu((open) => !open) }}
              onToggleLensMenu={() => { setViewMenu(false); setLensMenu((open) => !open) }}
              commandScope={paneCommandScope()}
              onSetAllNetsDisplay={async (mode) => {
                const tab = paneActiveTab()
                if (!tab) return
                const scope = paneCommandScope()
                const outcome = await app.dispatchTo(tab, { command: 'view.setAllNetsDisplay', params: { graphId: currentGraphId(tab), mode } })
                if (paneCommandScope() === scope) return outcome
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
            <For each={extensionToolbarPanels()}>
              {(panel) => (
                <div class="extension-toolbar-panel" data-testid={`extension-toolbar-panel-${panel.id}`}>
                  <HostUiProviderHost
                    owner={`extension-toolbar:${panel.id}`}
                    provider={panel.provider}
                    surface="toolbar"
                    data={{ panel: panel.id, slot: panel.slot }}
                    commands={app.commands}
                    replaceProblems={(owner, diagnostics) => app.replaceProblems(owner, diagnostics)}
                    errorText="Unable to render extension toolbar panel."
                  />
                </div>
              )}
            </For>
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
                      app={app}
                      owner={{ id: tab().id, title: tab().title, lineage: tab().store.doc.lineage }}
                      executions={paneWorkflowExecutions()}
                      canQueue={(backendsTick(), tab().execution === undefined && app.registryForTab(tab()) !== undefined)}
                      onQueue={() => { void app.queue(tab()) }}
                      onOpenExecution={(ref) => { void app.openExecutionView(ref) }}
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
              <div class="editor-unavailable">
                <ProductEmptyState tone="error" testId="editor-missing"
                  title={message('shell.editor.missing', { kind: paneEditorKind() })} />
              </div>
            }
          >
            {(editor) => editor.component(host)}
          </Show>
        </div>
      </section>
    )
  }

  const appMenu = () => (
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
      account={accountMenuActions}
    />
  )

  return (
    <>
      <Show
        when={nativePanelDescriptor()}
        keyed
        fallback={<Show when={managedContext().kind === 'panel'}>
          <section class="native-panel-window native-panel-window-missing" data-testid="native-panel-window-missing" ref={shellEl}>
            <Show when={servicesLabel()}>
              <header class="native-panel-window-header"><div class="topbar-group"><BrandMark symbol /><ServicesBadge /></div></header>
            </Show>
            <h1>{message('shell.panel.unavailable.title')}</h1>
            <p>{message('shell.panel.unavailable.description')}</p>
            <ProductButton type="button" data-testid="redock-window" onClick={redockCurrentWindow}>
              {message('shell.window.moveToMain')}
            </ProductButton>
          </section>
        </Show>}
      >{(panel) => (
        <section class="native-panel-window" data-testid="native-panel-window" data-panel={panel.id} ref={shellEl}>
          <header class="native-panel-window-header">
            <Show when={servicesLabel()}><div class="topbar-group"><BrandMark symbol /><ServicesBadge /></div></Show>
            <h1>
              {panel.title}
              <Show when={activePanelIndicator(panel)} keyed>
                {(indicator) => <PanelIndicatorBadge indicator={indicator} />}
              </Show>
            </h1>
            <ProductButton variant="ghost" size="compact" type="button" class="shell-panel-header-action" data-testid="redock-window" onClick={redockCurrentWindow}>{message('shell.window.moveToMain')}</ProductButton>
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
      <div class="shell" ref={(el) => { shellEl = el }}>
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
                <ProductButton type="button" autofocus onClick={() => setPendingClose(undefined)}>{message('shell.action.cancel')}</ProductButton>
                <SharedProductButton intent="remove" fill="solid" onClick={confirmPendingClose}>{message('shell.close.discard')}</SharedProductButton>
              </ProductActionFooter>
            </div>
          </ModalSurface>
        )}
      </Show>
      <Show when={pendingCloseOthers()} keyed>{(pending) => (
        <ModalSurface
          title={message('shell.workflowTabs.closeOthers')}
          ariaLabel={message('shell.workflowTabs.closeOthers')}
          modalId="close-other-tabs"
          testId="close-other-tabs-dialog"
          closeLabel={message('shell.close.cancel')}
          onRequestClose={() => setPendingCloseOthers(undefined)}
        >
          <div class="close-tab-confirm">
            <p>{message('shell.close.othersConfirm')}</p>
            <ul><For each={pending.filter((tab) => dirtyTabs().has(tab.id))}>{(tab) => <li>{tab.title}</li>}</For></ul>
            <ProductActionFooter>
              <ProductButton type="button" autofocus onClick={() => setPendingCloseOthers(undefined)}>{message('shell.action.cancel')}</ProductButton>
              <SharedProductButton intent="remove" fill="solid" onClick={confirmCloseOthers}>{message('shell.close.discard')}</SharedProductButton>
            </ProductActionFooter>
          </div>
        </ModalSurface>
      )}</Show>
      <h1 class="visually-hidden">{message('shell.applicationTitle')}</h1>
      <ProductWindowToolbar title={message('shell.applicationControls')} platform="linux" service={servicesLabel()}
        serviceKind={servicesKind()}
        brand={<>
          <Show when={!logoInLeftBar()}>{appMenu()}</Show>
          <Show when={managedContext().kind === 'primary'}>
            {/* Until the library names the project, the button is the folder alone. */}
            <Show when={projectName()} keyed fallback={
              <ProductIconButton label={message('shell.panel.projects.title')} icon={FolderOpen} data-testid="projects-button" data-tooltip-label={message('shell.panel.projects.title')} data-tooltip-detail={message('shell.panel.projects.description')} onClick={() => openProjects(false)} />
            }>{(name) => (
              <ProductProjectMenu
                name={name}
                projects={projectList()?.filter((project) => project.id !== activeProjectId())}
                failed={projectListFailed()}
                onOpen={readProjectList}
                onSwitch={switchProject}
                onOpenWindow={openProjectWindow}
                onAllProjects={() => openProjects(false)}
                onNewProject={() => openProjects(true)}
              />
            )}</Show>
          </Show>
        </>}
        search={<UniversalSearchTrigger shortcut={searchShortcut()} onOpen={() => app.searchOpen.set(true)} />}
        actions={(narrow) => <>
          <Show when={allWorkflowActivity().running > 0}>
            <ProductRunActivity {...allWorkflowActivity()} label={message('runs.activity', allWorkflowActivity())} />
          </Show>
          <Show when={managedContext().kind === 'workflow'}>
            <ProductWindowAction label={message('shell.window.moveToMain')} icon={PanelTop} data-testid="redock-workflow" onClick={redockCurrentWindow} />
          </Show>
          <CancelExecutionButton toolbar app={app} execution={(executions(), activeTab(), app.currentCancellableExecution())} />
          <ProductIconButton label={message('shell.panel.workspace.title')} icon={Users} data-testid="collab-button" data-tooltip-label={message('shell.panel.workspace.title')} data-tooltip-detail={message('shell.panel.workspace.description')} onClick={() => app.modalPanel.set('collab')} />
          <span class="app-layout-menu" ref={layoutMenu}><ProductMenu
            label={message('command.layout.customize')}
            icon={SlidersHorizontal}
            attention={narrow() ? railAttention() : undefined}
            items={layoutMenuItems(narrow())}
          /></span>
          <Show when={!narrow()}>
            <ProductIconButton label={message('shell.toggle.leftPanel')} icon={() => <ShellRegionIcon region="left" active={leftOpen()} />}
              data-testid="left-panel-toggle"
              data-tooltip-label={message('shell.toggle.leftPanel')}
              aria-pressed={leftOpen()}
              disabled={leftPanels().length === 0}
              onClick={toggleLeftRegion}
            />
            <ProductIconButton label={message('shell.toggle.bottomPanel')} icon={() => <ShellRegionIcon region="bottom" active={bottomOpen()} />}
              data-testid="bottom-panel-toggle"
              data-tooltip-label={message('shell.toggle.bottomPanel')}
              aria-pressed={bottomOpen()}
              disabled={bottomZonePanels().length === 0}
              onClick={toggleBottomRegion}
            />
            <ProductIconButton
              label={railIndicator() === undefined ? message('shell.toggle.rightRail') : message('shell.toggle.rightRailWithStatus', { status: railIndicator()!.label })}
              icon={() => <><ShellRegionIcon region="right" active={railOpen()} /><Show when={railIndicator()} keyed>{(indicator) => <PanelIndicatorBadge indicator={indicator} />}</Show></>}
              data-testid="rail-toggle"
              data-tooltip-label={message('shell.toggle.rightRail')}
              aria-pressed={railOpen()}
              onClick={() => app.dock.setOpen('right', !railOpen())}
            />
          </Show>
        </>}
      />
      <ProductToast notification={projectPackNotification()} onDismiss={() => app.projectPackNotification.set(undefined)} />
      <Show when={searchOpen()}><UniversalSearch app={app} /></Show>
      <Show when={nodeInstallRequest()} keyed>{(request) => <NodeInstallPrompt app={app} request={request} />}</Show>
      <Show when={nodeInstallRequest() === undefined && modalPanel() === '' ? projectNeedsReview() : undefined} keyed>{(review) => <ProjectNeedsPrompt app={app} review={review} />}</Show>

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
              <ProductButton size="compact"
                data-testid="engine-restart"
                onClick={() => void app.restartEngine(activeBackend())}
              >
                {message('shell.engine.restart')}
              </ProductButton>
            </Show>
          </div>
        )}
      </Show>

      <Show when={problems().find((problem) => problem.code === 'workspace.recovery.storageFailed')} keyed>
        {(problem) => (
          <div class="dinkster-root" data-testid="recovery-storage-error">
            <ProductErrorBanner onDismiss={() => app.clearProblems(problem.owner)}>
              {problem.message}
            </ProductErrorBanner>
          </div>
        )}
      </Show>

      <div class="body" ref={bodyElement} onPointerDown={beginPanelDrag}>
        <nav class="left-sidebar" aria-label={message('shell.primaryNavigation')} data-tooltip-session="left-rail" hidden={!activityBarVisible()}>
          <Show when={logoInLeftBar()}><div class="sidebar-logo">{appMenu()}</div></Show>
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
                    testId={panel.toggleTestId}
                    onActivate={() => {
                      tooltips.hide()
                      toggleSidebarPanel(panel.id)
                    }}
                  />
                )}
              </For>
            </div>
          </div>
          <div class="sidebar-account">
            <AccountControl session={account} rail />
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
            style={{ width: `${renderedDockWidth()}px` }}
          >
            <DockZoneHost
              zone="left"
              titleOnly={activityBarVisible()}
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
              value={renderedDockWidth()}
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
        </main>

        <Show when={railOpen()}><aside class="rail" aria-label={message('shell.inspectorPanels')} style={{ width: `${renderedRailWidth()}px` }}>
          <ShellResizeHandle
            region="right"
            label={message('shell.resize.inspectorPanels')}
            value={renderedRailWidth()}
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

      <Show when={tooltip()}>{(tip) => <ShellTooltip tip={tip()} />}</Show>
      <Show when={queueRefusal() !== undefined && queueRefusal() === activeTab() && problemsIndicator()}>{(summary) => (
        <ProductEmptyState
          class="queue-refusal-toast"
          testId="queue-refusal-toast"
          tone="error"
          title={message('problems.queueRefused')}
          hint={<>
            <span>{summary().label}</span>
            <span>{message('problems.severityCounts', {
              errors: problemDiagnostics().filter((problem) => problem.severity === 'error').length,
              warnings: problemDiagnostics().filter((problem) => problem.severity === 'warning').length,
              info: problemDiagnostics().filter((problem) => problem.severity === 'info').length,
            })}</span>
          </>}
          action={<>
            <ProductButton size="compact" onClick={() => {
              setPanelOpen(app.panels, app.dock, 'problems', 'right', true)
              app.queueRefusal.set(undefined)
            }}>{message('problems.action.open')}</ProductButton>
            <ProductButton size="compact" variant="ghost" onClick={() => app.queueRefusal.set(undefined)}>
              {message('problems.action.dismiss')}
            </ProductButton>
          </>}
        />
      )}</Show>
      <TransientStatus message={transientStatus()} />
      <StatusBar app={app} backend={activeBackend} tab={activeTab} problems={problemsIndicator}
        visible={statusBarVisible} placement={placementStatus} transient={transientStatus}
        context={() => {
          const tab = activeTab()
          const view = selectionContext()
          const selected = app.canvasSelection.get()
          if (tab === undefined || (tab.editorKind !== undefined && tab.editorKind !== GRAPH_EDITOR_KIND) || view === undefined) return undefined
          return message('shell.status.workflowContext', { count: Object.keys(view.doc.graphs[view.graphId]?.nodes ?? {}).length, selected: selected.nodes.length })
        }}
        openPanel={(id) => {
          if (id === 'memory') setResourcesBackend({ id: activeBackend().id })
          setPanelOpen(app.panels, app.dock, id, id === 'problems' ? 'right' : 'left', true)
        }}
        openRuns={() => {
          setRunScope('workflow')
          setPanelOpen(app.panels, app.dock, 'runs', 'right', true)
        }}
        openAppLog={() => {
          setAppLogRequest((token) => (token ?? 0) + 1)
          setPanelOpen(app.panels, app.dock, 'logs', 'bottom', true)
        }}
        extensions={<For each={statusTrailingContributions()}>{(contribution) => (
          <span class="host-ui-contribution" data-host-ui-contribution={contribution.id}>
            <HostUiProviderHost owner={contributionProblemsOwner(contribution)} provider={contribution.provider}
              data={{ connectionId: activeBackend().id, connectionLabel: activeBackend().label,
                connectionStatus: statusOf(activeBackend()), schemaCount: schemaCountOf(activeBackend()) ?? null } satisfies Json}
              commands={app.commands} replaceProblems={(owner, diagnostics) => app.replaceProblems(owner, diagnostics)} />
          </span>
        )}</For>}
      />
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

function outputIterationGroup(runtimeId: string, workflowLabel: string): { readonly key: string; readonly label: string } {
  const iterations = parseDinksterRuntimePath(runtimeId)?.flatMap((segment) =>
    segment.iteration === undefined ? [] : [{ nodeId: segment.nodeId, iteration: segment.iteration }]) ?? []
  if (iterations.length === 0) return { key: 'workflow', label: workflowLabel }
  return {
    key: JSON.stringify(iterations),
    label: iterations.map((segment) => `${segment.nodeId} - item ${segment.iteration + 1}`).join(' / '),
  }
}

function Outputs(props: { app: AppState; execution: ExecutionState; details?: JSX.Element; source?: {
  values: DinksterValuesClient
} }) {
  const message = useAppMessage()
  const backendTick = useSignal(props.app.backendsTick)
  const [viewerIndex, setViewerIndex] = createSolidSignal<number>()
  const [viewerGrid, setViewerGrid] = createSolidSignal(false)
  const [detailsOpen, setDetailsOpen] = createSolidSignal(false)
  const [failed, setFailed] = createSolidSignal<ReadonlySet<string>>(new Set())
  const [loaded, setLoaded] = createSolidSignal<ReadonlySet<string>>(new Set())
  const currentExecutionKey = createMemo(() => props.execution.key)
  const values = () => {
    backendTick()
    return props.source?.values ?? props.app.valuesForExecution(props.execution.ref)
  }
  const outputIdentities = createMemo(() => {
    const media = new Set<string>()
    const outputs = [
      ...Object.entries(props.execution.outputs),
      ...Object.entries(props.execution.nodes).map(([nodeId, progress]) => [nodeId, progress.outputs ?? {}] as const),
    ]
    for (const [nodeId, values] of outputs) for (const [outputId, descriptor] of Object.entries(values)) {
      if (typeof descriptor === 'object' && descriptor !== null && 'typeId' in descriptor &&
          typeof descriptor.typeId === 'string') {
        const identity = JSON.stringify([nodeId, outputId])
        if (mediaMetadataOf(descriptor.typeId, undefined) !== undefined) media.add(identity)
      }
    }
    return { media: [...media].sort() }
  }, undefined, { equals: (previous, next) => canonicalJson(previous) === canonicalJson(next) })
  const mediaValueGroups = createMemo(() => {
    const groups = new Map<string, { readonly label: string; readonly identities: string[] }>()
    for (const identity of outputIdentities().media) {
      const [runtimeId] = JSON.parse(identity) as [string, string]
      const { key, label } = outputIterationGroup(runtimeId, 'Workflow values')
      const group = groups.get(key) ?? { label, identities: [] }
      group.identities.push(identity)
      groups.set(key, group)
    }
    return [...groups.values()]
  })
  createEffect(() => {
    currentExecutionKey()
    setViewerIndex(undefined)
    setViewerGrid(false)
    setFailed(new Set<string>())
    setLoaded(new Set<string>())
  })
  const images = createMemo(() => executedImageInventory(props.execution, {
    assetUrlForExecution: (ref, digest) => props.app.assetUrlForExecution(ref, digest),
    values: values(),
  }))
  const imageGroups = createMemo(() => {
    const groups = new Map<string, { readonly label: string; readonly images: { readonly image: ExecutedImage; readonly index: number }[] }>()
    for (const [index, image] of images().slice(0, 3).entries()) {
      const { key, label } = outputIterationGroup(image.runtimeId, 'Workflow outputs')
      const group = groups.get(key) ?? { label, images: [] }
      group.images.push({ image, index })
      groups.set(key, group)
    }
    return [...groups.values()]
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
  const emptyState = (): { readonly state: string; readonly title: string; readonly detail: string } => {
    if (props.execution.status === 'error') return {
      state: 'error', title: 'Execution failed without image outputs',
      detail: props.execution.errors.map((error) => error.message).join(' ') || 'The execution reported an error before producing inspectable images.',
    }
    if (!provenance().backendAvailable) return {
      state: 'owner-unavailable', title: 'Output backend unavailable',
      detail: 'The execution backend was removed or disconnected. Output media may no longer be available.',
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
      <details class="runs-details" onClick={(event) => event.stopPropagation()}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
        <summary>{message('runs.details')}</summary>
        <Show when={detailsOpen()}>
        {props.details}
      <section class="output-execution-provenance output-rail-provenance" aria-label="Execution provenance">
        <div><span>Backend</span><strong>{provenance().backendLabel}</strong></div>
        <div><span>Backend ID</span><strong>{provenance().backendId}</strong></div>
        <div><span>Execution</span><strong>{provenance().executionId}</strong></div>
        <div><span>Status</span><strong>{provenance().executionStatus}</strong></div>
        <Show when={!provenance().backendAvailable && images().length > 0}>
          <p role="status">{message('outputs.backendDisconnected')}</p>
        </Show>
        <Show when={props.execution.errors.length > 0}>
          <p class="output-execution-error" role="alert">{props.execution.errors.map((error) => error.message).join(' ')}</p>
        </Show>
      </section>
      <MediaDiagnostics diagnostics={props.execution.valueDiagnostics ?? []} />
      <SavedOutputFiles artifacts={props.execution.artifacts} images={images()} />
      <For each={mediaValueGroups()}>{(group) => (
        <section class="output-iteration-group output-value-group" aria-label={group.label}>
          <h3>{group.label}</h3>
          <For each={group.identities}>{(identity) => {
            const [nodeId, outputId] = JSON.parse(identity) as [string, string]
            return <MediaValueInspector values={values()} query={{ jobId: props.execution.ref.prompt, nodeId, outputId }} />
          }}</For>
        </section>
      )}</For>
      <For each={images()}>{(image) => <ExecutedImageFacts image={image} availability={availability(image.key)} />}</For>
        </Show>
      </details>
      <div class="outputs runs-output-thumbnails" aria-label={`${images().length} execution images`}>
        <For each={imageGroups()} fallback={
          <span data-state={emptyState().state} role="status" title={emptyState().detail}>{emptyState().title}</span>
        }>
          {(group) => (
            <section class="output-iteration-group" aria-label={group.label}>
              <h3>{group.label}</h3>
              <div class="output-iteration-images" role="list">
              <For each={group.images}>{({ image, index }) => (
              <div role="listitem">
              <ProductButton
                type="button"
                class="output-thumbnail"
                aria-label={`Open ${executedImageLabel(image, index, images().length)}`}
                onClick={(event) => { event.stopPropagation(); setViewerGrid(false); setViewerIndex(index) }}
              >
                <span class="output-thumbnail-preview">
                  <Show when={!failed().has(image.key)} fallback={<span class="output-thumbnail-unavailable">Image unavailable</span>}>
                    <ViewerImage image={image} alt="" onLoad={() => markLoaded(image.key)} onError={() => markFailed(image.key)} />
                  </Show>
                  <span class="output-thumbnail-position">Output {index + 1} of {images().length}</span>
                </span>
              </ProductButton>
              </div>
              )}</For>
              </div>
            </section>
          )}
        </For>
        <Show when={images().length > 3}>
          <ProductButton size="compact" aria-label={message('runs.outputs.all', { count: images().length })}
            onClick={(event) => { event.stopPropagation(); setViewerGrid(true); setViewerIndex(0) }}>+{images().length - 3}</ProductButton>
        </Show>
      </div>
      <Show when={viewerIndex() !== undefined}>
        <ExecutedImageViewer images={images()} initialIndex={viewerIndex()!} initialMode={viewerGrid() ? 'grid' : 'single'} provenance={provenance()} backendUrl={props.app.backendFor(props.execution.ref.connection)?.baseUrl} onRequestClose={() => setViewerIndex(undefined)} />
      </Show>
    </>
  )
}
