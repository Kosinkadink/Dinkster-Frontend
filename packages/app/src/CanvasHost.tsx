/**
 * Canvas host: owns the framework-free CanvasRenderer + InteractionController.
 * Solid provides the mount point, change propagation, and the DOM widget
 * editor overlay; rendering and gesture handling never touch the framework.
 *
 * Data flow: gestures -> commands -> DocumentStore -> document signal ->
 * scene rebuild -> renderer. Ephemeral state (selection, drag offsets, ghost
 * links) lives in the controller/renderer overlay, never in the document.
 */

import { createEffect, createMemo, createSignal as createSolidSignal, on, onCleanup, onMount, Show, For, Index, untrack } from 'solid-js'
import type { AssetDtoV1WireContract, ExecutionLogEntry } from '@dinkster/client'
import {
  buildScene,
  boundarySceneId,
  CANVAS_DETAIL_MIN_SCALE,
  CanvasRenderer,
  createRegistryPainter,
  defaultTokens,
  hitTest,
  InteractionController,
  nodesInGroup,
  partialExecutionButtons,
  scenesEqual,
  splitPreviewRect,
  toolboxButton,
  toolboxSeparator,
  updateSceneNodePositions,
  type Hit,
  type GhostLink,
  type LinkDoubleClickContext,
  type LinkDropContext,
  type CompanionMap,
  type PresenceActor,
  type RowMarkMap,
  type LayoutRow,
  type Scene,
  type SceneNetStub,
  type SceneNode,
  type SceneSelector,
  type SceneValueSource,
  type ScopeHighlight,
  type ToolboxRow,
  type ToolboxButtonRect,
  type TextMeasurer,
  type WheelNavigationMode,
  type WidgetMeasure,
  type NodePreview,
  type OccurrenceLinkIntention,
  type OccurrenceMutationPlanner,
  type BoundaryExposureSource,
} from '@dinkster/canvas'
import { VideoPreview } from './VideoPreview.js'
import type { VideoPreferences } from './video-preview.js'
import { AudioTransport } from './AudioTransport.js'
import { PreviewDownload } from './PreviewDownload.js'
import { ExecutedImageViewer, executionOutputProvenance, type ExecutionOutputProvenance } from './ExecutedImageViewer.js'
import { placeFloatingSurface } from './floating-surface.js'
import {
  defaultValuesOf,
  initialDynamicStateOf,
  documentResolver,
  elabOutputsOf,
  outputDescriptorAssetOf,
  outputDescriptorValueOf,
  parseOutputDescriptors,
  effectiveOccurrenceTopology,
  effectiveWidgetDefault,
  effectiveValueSourceSpec,
  elabInputsOf,
  formatWidgetValue,
  flattenShellRefusalDiagnostic,
  pinnedSpecOf,
  scopeClosure,
  selectorCandidateKey,
  parseOccurrenceKey,
  asPortId,
  asNodeId,
  subgraphDefIdOf,
  diag,
  occurrenceDynamicView,
  occurrencesForView,
  autoConnectTarget,
  canonicalJson,
  canonicalTypeIdOf,
  nodeSearchFields,
  searchVisibilityOf,
  isPortEndpoint,
  planOccurrenceLinkMutation,
  samePortRef,
  serializeSelection,
  type CommandInvocation,
  type CommandOutcome,
  type ControllerMode,
  type Diagnostic,
  type EditorSizing,
  type ElaboratedInterface,
  type EffectiveLink,
  type ExternalIncomingStub,
  type ExecutionScope,
  type GraphDef,
  type Json,
  type JsonObject,
  type MenuContext,
  type MenuActionItem,
  type MenuTarget,
  type ResolvedMenuGroup,
  type NodeSchema,
  type PackBlueprintDescriptor,
  type CompanionSourceMap,
  type ReplacementScanItem,
  type ResolvedGeometryItem,
  type ViewBookmark,
  type WidgetSpec,
  type WidgetView,
  type WorkflowDocument,
} from '@dinkster/core'
import { AppWindow, Bookmark, Check, CheckCircle2, ChevronDown, CircleSlash2, Dice5, FileUp, Frame, Layers, LoaderCircle, Lock, Map as MapIcon, Maximize2, MessageCircleWarning, Minus, Palette, Plus, Route, Settings2, TriangleAlert, X, ZoomIn, ZoomOut } from 'lucide-solid'
import { currentGraphId, diagnosticFocusPlan, EMPTY_CANVAS_SELECTION, pushGraph, restoreNavigation, toggledSelectionCollapsed, toggledSelectionMode, truncateGraphStack, viewInstancePath, type AppState, type CanvasBridge, type CanvasSelectionSnapshot, type RegionKind, type Tab, type WorkerCatalogState } from './app-state.js'
import { BUILTIN_EDITOR_NODE_IDS } from './builtin-bindings.js'
import { actorColor, actorLabel, PresenceProjector, type PresenceChannel, type PresenceLinkDrag } from './collab-presence.js'
import { liveExactnessFor } from './companion-display.js'
import { createGlslMirrorRunner } from './mirror-glsl-runner.js'
import { createMirrorImageEstimator } from './mirror-image-previews.js'
import { createPreviewLoader, validateBrowserMediaRendition } from './node-previews.js'
import { tabDocumentUnchanged, widgetEditorAnchorAlive } from './widget-editor-anchor.js'
import type { ExecutedImagePreview } from './scene-overlays.js'
import { deriveSceneOverlays, retainProvenExecution, type SelectedInputPreview } from './scene-overlays.js'
import { composeCanvasProblemDiagnostics, deriveProblemProjection, problemDisplay, type NodeProblemKind, type NodeProblemMap } from './problem-display.js'
import { BlueprintBodyCache, blueprintFailureDiagnostic, insertBlueprintIntoTab } from './blueprints.js'
import { pasteClipboardIntoTab } from './clipboard-paste.js'
import { pastedImageName, readClipboardImage } from './clipboard-image.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'
import { isNativeTextScopeTarget, shortcutSuppressed } from './settings.js'
import { bookmarkJumpMode, bookmarkJumpPlan, bookmarkMarkerWorldPoint, bookmarkSaveMode, bookmarkViewFromViewport, bookmarkViewportForView, createCameraAnimator, viewportCenteredOnNode, type BookmarkJumpPlan } from './bookmark-camera.js'
import { Icon } from './Icon.js'
import { autoSpecialization } from './dynamic-slot.js'
import { minimapMenuPlacement, setupMinimap, type MinimapMarker, type MinimapMenuPlacement } from './minimap.js'
import { NodePalette, type PaletteAnchor, type PaletteEntry } from './NodePalette.js'
import { ContextMenu } from './ContextMenu.js'
import { canvasMenuContext, menuTargetOf, mirrorCapabilityOf, previewCapabilityOf, resolveNodeMenuGroups, selectionLifecycleMenuGroups, widgetMenuTarget, widgetRepresentationAddress, widgetRepresentationMenuGroup, type MenuAnchor } from './menu-target.js'
import { BadgePopover, type BadgeAnchor } from './BadgePopover.js'
import { NamePrompt } from './NamePrompt.js'
import { nodeHeaderTooltipImmediate, type TooltipController } from './tooltips.js'
import { replacementBadgeInfo, subgraphBadgeInfo } from './badge-info.js'
import { isInNodeTextEditor, unresolvedAssetBasename, WidgetEditor, withMaterializeFrames, type WidgetEditorState } from './WidgetEditor.js'
import { APP_EDITOR_KIND, GRAPH_EDITOR_KIND, type EditorHostContext } from './editors.js'
import { commitExtract, extractInvocation, flattenInvocation, hasExtractSelection, isFlattenSelection, type LifecycleSelectionSnapshot } from './subgraph-lifecycle.js'
import { classifyDroppedFile, insertDroppedImage, insertDroppedLatent, singleUseFileDropChoice, startCanvasFileDrop, watchFileDropGraphOwner } from './file-drop.js'
import type { LatentMetadata } from './latent-metadata.js'
import { ModalSurface } from './ModalSurface.js'
import { palettePreviewLayout, placementSchemaKey } from './palette-node-preview.js'
import { ProductActionFooter } from './ProductForm.js'
import {
  CanvasSemanticNavigator,
  buildCanvasSemanticItems,
  type CanvasSemanticItem,
  type CanvasSemanticSource,
  type CanvasSemanticTarget,
} from './CanvasSemanticNavigator.js'
import { boundedVisibleOverlayKeys, mediaScreenRect, retainActiveOverlayKeys, type EditorWorldRect } from './widget-editor-position.js'
import { bindFocusedCanvasTestBridge } from './test-bridge.js'

const outputPreviewDocumentTokens = new WeakMap<object, number>()
let nextOutputPreviewDocumentToken = 1

function outputPreviewDocumentToken(document: object): number {
  const existing = outputPreviewDocumentTokens.get(document)
  if (existing !== undefined) return existing
  const token = nextOutputPreviewDocumentToken++
  outputPreviewDocumentTokens.set(document, token)
  return token
}

function widgetEditorSizing(view: WidgetView, spec: WidgetSpec): EditorSizing | undefined {
  try {
    const sizing = view.editorSizing?.(spec)
    if (sizing === undefined) return undefined
    const validSize = (size: { readonly width: number; readonly height: number }): boolean =>
      Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0
    if (!validSize(sizing.preferred) ||
      (sizing.min !== undefined && !validSize(sizing.min)) ||
      (sizing.max !== undefined && !validSize(sizing.max)) ||
      (sizing.min !== undefined && sizing.max !== undefined &&
        (sizing.min.width > sizing.max.width || sizing.min.height > sizing.max.height))) return undefined
    return {
      preferred: { ...sizing.preferred },
      ...(sizing.min === undefined ? {} : { min: { ...sizing.min } }),
      ...(sizing.max === undefined ? {} : { max: { ...sizing.max } }),
      ...(sizing.resizable === true ? { resizable: true } : {}),
    }
  } catch {
    return undefined
  }
}

/** Project compiler occurrence cones onto the graph occurrence being viewed. */
export function inactiveSceneNodesFor(
  inactiveExclusive: ReadonlyMap<string, ReadonlySet<string>>,
  instancePath: readonly string[],
): ReadonlySet<string> {
  const runtimeIds = new Set<string>()
  for (const cone of inactiveExclusive.values()) {
    for (const runtimeId of cone) runtimeIds.add(runtimeId)
  }
  const occurrences = occurrencesForView({ instancePath, runtimeIds })
  return new Set([...occurrences.own.keys(), ...occurrences.inner.keys()])
}

interface CanvasPreviewA11yTarget {
  readonly id: string
  readonly label: string
}

export function selectedInputPreviewA11yTargets(
  scene: Scene,
  previews: Readonly<Record<string, SelectedInputPreview>>,
): readonly CanvasPreviewA11yTarget[] {
  return scene.nodes.flatMap((node) => {
    const selected = previews[node.id]
    if (selected === undefined) return []
    const preview = selected.preview
    const state = preview.status === 'unavailable' || preview.status === 'failed'
      ? 'unavailable'
      : preview.status === 'loading'
        ? 'loading'
        : Number.isFinite(preview.width) && Number.isFinite(preview.height)
          ? `${preview.width} by ${preview.height} pixels`
          : 'unavailable'
    const count = selected.count > 1 ? `, ${selected.count} selected images` : ''
    return [{
      id: node.id,
      label: `${node.layout.title}, selected input ${selected.name}${count}: ${state}`,
    }]
  })
}

export function CanvasPreviewA11y(props: { readonly targets: readonly CanvasPreviewA11yTarget[] }) {
  return (
    <Show when={props.targets.length > 0}>
      <div class="canvas-widget-a11y" aria-label="Selected input previews">
        <For each={props.targets}>{(item) => (
          <div role="img" data-testid="canvas-preview-a11y" aria-label={item.label}>{item.label}</div>
        )}</For>
      </div>
    </Show>
  )
}

/** Derive the installed lazy-cone overlay, including every clearing state. */
export function lazyInactiveSceneNodes(args: {
  readonly frozen: boolean
  readonly closure: ReturnType<typeof scopeClosure>
  readonly instancePath: readonly string[] | undefined
}): ReadonlySet<string> | undefined {
  if (args.frozen || !args.closure || !args.instancePath) return undefined
  return inactiveSceneNodesFor(args.closure.inactiveExclusive, args.instancePath)
}

export function runOnMachineMenuGroup(args: {
  readonly document: WorkflowDocument
  readonly graphId: string
  readonly nodeIds: readonly string[]
  readonly catalog: WorkerCatalogState
  readonly frozen: boolean
}): ResolvedMenuGroup | undefined {
  if (args.frozen || args.graphId !== args.document.root) return undefined
  const graph = args.document.graphs[args.graphId]
  const nodes = graph === undefined ? [] : [...new Set(args.nodeIds)].flatMap((nodeId) => {
    if (!Object.hasOwn(graph.nodes, nodeId)) return []
    const node = graph.nodes[nodeId]!
    return node !== undefined && (node.region !== undefined || subgraphDefIdOf(node.type) === undefined)
      ? [node]
      : []
  })
  const catalog = args.catalog
  if (nodes.length === 0 || catalog.status === 'unsupported') return undefined
  const unavailable = catalog.status === 'ready'
    ? (catalog.workers.length === 0 ? 'No machines configured' : undefined)
    : catalog.status === 'loading'
      ? 'Loading machines...'
      : 'Machines unavailable'
  const children: readonly MenuActionItem[] = catalog.status === 'ready'
    ? catalog.workers.map((worker) => {
        const routed = new Set(worker.routedNodeTypes)
        const routeMismatch = nodes.some((node) => node.region === undefined && !routed.has(node.type))
        const disabled = worker.status !== 'connected' || routeMismatch
        return {
          id: `core.node.runOnMachine.${worker.name}`,
          label: `${worker.name} - ${worker.status}`,
          ...(disabled
            ? {
                disabled: true,
                ...(worker.status === 'connected' ? { hint: 'Missing selected node type' } : {}),
              }
            : {}),
          action: {
            kind: 'host' as const,
            action: 'runOnMachine',
            params: { worker: worker.name, nodeIds: nodes.map((node) => node.id) },
          },
        }
      })
    : []
  return {
    group: '16-run-location',
    items: [{
      id: 'core.node.runOnMachine',
      label: 'Run on machine',
      ...(unavailable !== undefined ? { disabled: true, hint: unavailable } : {}),
      children,
    }],
  }
}

let clipboardFallback: string | undefined
let clipboardScopeSeq = 0
const clipboardScopes = new Map<string, {
  readonly tab: Tab
  readonly graphId: string
  readonly sources: ReadonlyMap<string, GraphDef['nodes'][string]>
  readonly endpointTypes: ReadonlyMap<string, string>
}>()
const clipboardEndpointKey = (
  kind: 'input' | 'output' | 'tap', node: string, port: string, members: readonly string[] | undefined,
): string => JSON.stringify([kind, node, port, members ?? []])

export const clipboardSceneEndpointTypes = (source: Scene): ReadonlyMap<string, string> => {
  const result = new Map<string, string>()
  for (const node of source.nodes) {
    // Pins are the single harvest source: every ports row emits a matching
    // pin, and widget-backed inputs and collapsed-section ports exist ONLY
    // as pins. Pins also carry the solver-substituted type on both the copy
    // and paste side, so a section collapse between copy and paste cannot
    // flip the type representation and falsely reject a stub.
    for (const pin of node.layout.pins) {
      if (pin.widgetTap === true) {
        if (node.missingSchema !== true && pin.staticWidgetTap === true && pin.familyOwner === undefined && (pin.address.members?.length ?? 0) === 0)
          result.set(clipboardEndpointKey('tap', node.id, pin.address.port, undefined), JSON.stringify(pin.type))
        continue
      }
      result.set(clipboardEndpointKey(pin.direction === 'in' ? 'input' : 'output', node.id, pin.address.port, pin.address.members), JSON.stringify(pin.type))
    }
  }
  return result
}

export function armedPlacementStatus(displayName: string): string {
  return `Placing ${displayName} - click the canvas to place, Esc to cancel`
}

/**
 * World position for a client-space pointer that lies inside the canvas
 * rect; undefined outside it. Arming a placement seeds its ghost from the
 * last window-level pointer position through this, so the node appears
 * under the cursor immediately even when an overlay (Search Dinkster, the
 * palette) was the pointer's hit target and the canvas never heard a
 * pointermove there.
 */
export function seededPointerWorld(
  client: { readonly x: number; readonly y: number } | undefined,
  rect: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  toWorld: (x: number, y: number) => { x: number; y: number },
): { x: number; y: number } | undefined {
  if (client === undefined) return undefined
  if (client.x < rect.left || client.x > rect.right || client.y < rect.top || client.y > rect.bottom) return undefined
  return toWorld(client.x - rect.left, client.y - rect.top)
}

export interface PlacementGeometry {
  readonly width: number
  readonly height: number
  readonly headerHeight: number
}

export function titleCenteredPlacement(
  pointer: { readonly x: number; readonly y: number },
  geometry: PlacementGeometry,
): { readonly x: number; readonly y: number } {
  return { x: pointer.x - geometry.width / 2, y: pointer.y - geometry.headerHeight / 2 }
}

export function armedPlacementGhost(
  displayName: string,
  pointer: { readonly x: number; readonly y: number },
  geometry: PlacementGeometry,
) {
  return { ...titleCenteredPlacement(pointer, geometry), width: geometry.width, height: geometry.height, title: displayName }
}

export function palettePickCommitsImmediately(type: string, placement: PaletteAnchor): boolean {
  return type === '__dinkster.reroute' || placement.linkDrop !== undefined || placement.splice !== undefined
}

export function unresolvedAssetImportDiagnostic(args: {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly valueKey: string
  readonly requested: string
  readonly expectedKind?: string
}): Diagnostic {
  const where = `${args.nodeId}.${args.valueKey}`
  const basename = unresolvedAssetBasename(args.requested)
  return diag(
    'error',
    'schema',
    'widget.ASSET.unresolvedImport',
    `${where}: imported asset "${args.requested}" is unresolved (file "${basename}", expected kind "${args.expectedKind ?? 'unspecified'}")`,
    { refs: [{ graphId: args.graphId, nodeId: args.nodeId, portId: args.inputId, valueKey: args.valueKey, direction: 'input' }] },
  )
}

export function textEditorInputInventory(
  elaborated: ElaboratedInterface | undefined,
  inputFamilies: readonly string[],
): {
  readonly inputFamilyMembers: Readonly<Record<string, readonly string[]>>
} {
  const apiNames = elaborated === undefined
    ? []
    : elabInputsOf(elaborated).flatMap((input) => input.apiName === undefined ? [] : [input.apiName])
  return {
    inputFamilyMembers: Object.fromEntries(inputFamilies.map((family) => {
      const prefix = `${family}.`
      const members = apiNames.flatMap((apiName) => {
        if (!apiName.startsWith(prefix)) return []
        const member = apiName.slice(prefix.length).split('.')[0]
        return member === undefined || member === '' ? [] : [member]
      })
      return [family, [...new Set(members)]]
    })),
  }
}

/** Keep native selection/drag behavior from stealing canvas pointer gestures. */
export function installCanvasGestureGuards(canvas: HTMLCanvasElement): () => void {
  const onPointerDown = (): void => {
    const active = canvas.ownerDocument.activeElement
    // An input's selection is not represented consistently by getSelection(),
    // and clearing it while the user is editing would be worse than the stray
    // shell-selection bug. The dragstart guard below still protects the canvas.
    if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return

    const selection = canvas.ownerDocument.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const ancestor = selection.getRangeAt(index).commonAncestorContainer
      if (ancestor !== canvas && !canvas.contains(ancestor)) {
        selection.removeAllRanges()
        return
      }
    }
  }
  const onDragStart = (event: DragEvent): void => event.preventDefault()

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('dragstart', onDragStart)
  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('dragstart', onDragStart)
  }
}

export function linkSpliceInvocations(
  graphId: string,
  nodeId: string,
  schema: NodeSchema,
  splice: LinkDoubleClickContext,
): CommandInvocation[] {
  const input = autoConnectTarget(schema, splice.fromType, 'in')
  const output = autoConnectTarget(schema, splice.toType, 'out')
  if (!input || !output) return []
  const materialize = (target: NonNullable<typeof input>): CommandInvocation[] => target.materialize ? [{
    command: 'dynamic.materialize',
    params: { graphId, nodeId, frames: target.materialize.map((frame) => ({ construct: frame.construct, members: [...frame.members] })) },
  }] : []
  const inputEnd = { node: nodeId, port: input.port, ...(input.members ? { members: [...input.members] } : {}) }
  const outputEnd = { node: nodeId, port: output.port, ...(output.members ? { members: [...output.members] } : {}) }
  return [
    { command: 'link.disconnect', params: { graphId, linkId: splice.linkId } },
    ...materialize(input),
    ...materialize(output),
    { command: 'link.connect', params: { graphId, from: splice.fixedFrom, to: inputEnd } },
    { command: 'link.connect', params: { graphId, from: outputEnd, to: splice.fixedInto } },
  ]
}

export function rerouteDropInvocations(
  graphId: string,
  rerouteId: string,
  position: { readonly x: number; readonly y: number },
  drop: LinkDropContext,
): CommandInvocation[] {
  const reroute = { reroute: rerouteId }
  const from = drop.seeking === 'in' ? drop.fixedFrom : reroute
  const to = drop.seeking === 'in' ? reroute : drop.fixedInto
  if (!from || !to) return []
  return [
    { command: 'reroute.add', params: { graphId, position } },
    ...(drop.fixedMaterialize ? [{ command: 'dynamic.materialize', params: { graphId, nodeId: drop.fixedMaterialize.nodeId, frames: drop.fixedMaterialize.frames.map((frame) => ({ construct: frame.construct, members: [...frame.members] })) } } as CommandInvocation] : []),
    { command: 'link.connect', params: { graphId, from, to } },
  ]
}

/**
 * Finish a link-drop insertion against the fresh node's elaborated surface.
 * Materialization and connect stay in the caller's node.add batch so the
 * operation remains atomic and one-step undoable.
 */
export function linkDropInvocations(
  drop: LinkDropContext,
  graphId: string,
  nodeId: string,
  schema: NodeSchema | undefined,
): CommandInvocation[] {
  const target = schema ? autoConnectTarget(schema, drop.anchorType, drop.seeking) : undefined
  if (target === undefined) return []
  const newEnd = {
    node: nodeId,
    port: target.port,
    ...(target.members !== undefined ? { members: [...target.members] } : {}),
  }
  const from = drop.seeking === 'in' ? drop.fixedFrom : newEnd
  const to = drop.seeking === 'in' ? newEnd : drop.fixedInto
  if (from === undefined || to === undefined) return []
  const out: CommandInvocation[] = []
  const materializeOf = (owner: string, frames: readonly { construct: string; members: readonly string[] }[]): CommandInvocation => ({
    command: 'dynamic.materialize',
    params: {
      graphId,
      nodeId: owner,
      frames: frames.map((f) => ({ construct: f.construct, members: [...f.members] })),
    },
  })
  if (drop.fixedMaterialize !== undefined) {
    out.push(materializeOf(drop.fixedMaterialize.nodeId, drop.fixedMaterialize.frames))
  }
  if (target.materialize !== undefined) {
    out.push(materializeOf(nodeId, target.materialize))
  }
  out.push({ command: 'link.connect', params: { graphId, from, to } })
  return out
}

/** Presentation-only dangling noodle shown while a link-drop palette is open. */
export function linkDropPaletteGhost(context: LinkDropContext, worldX: number, worldY: number): GhostLink {
  const presentation = {
    ...(context.anchorTypeName !== undefined ? { typeName: context.anchorTypeName } : {}),
  }
  return context.seeking === 'in'
    ? { x1: context.anchorX, y1: context.anchorY, x2: worldX, y2: worldY, ...presentation }
    : { x1: worldX, y1: worldY, x2: context.anchorX, y2: context.anchorY, ...presentation }
}

export function CanvasViewControls(props: {
  readonly drilled: boolean
  readonly disabled: boolean
  readonly activeView: string
  readonly activeLens: { readonly id: string; readonly label: string }
  readonly lenses: readonly { readonly id: string; readonly label: string; readonly description: string }[]
  readonly viewMenuOpen: boolean
  readonly lensMenuOpen: boolean
  readonly onToggleViewMenu: () => void
  readonly onToggleLensMenu: () => void
  readonly onSelectView: (kind: string) => void
  readonly onSelectLens: (id: string) => void
  readonly onSetAllNetsDisplay: (mode: 'noodle' | 'tags' | 'guide') => void
}) {
  const message = useAppMessage()
  const viewLabel = () => message(`canvas.viewControls.active.${props.activeView === APP_EDITOR_KIND ? 'app' : 'graph'}`)
  return (
    <div class="canvas-view-controls" classList={{ drilled: props.drilled }}>
      <div class="canvas-view-control">
        <button
          type="button"
          data-testid="views-switcher"
          data-tooltip-label={props.viewMenuOpen ? undefined : message('canvas.viewControls.view.tooltip')}
          aria-haspopup="menu"
          aria-expanded={props.viewMenuOpen}
          disabled={props.disabled}
          onClick={props.onToggleViewMenu}
        ><Icon icon={AppWindow} /> {viewLabel()} <Icon icon={ChevronDown} /></button>
        <Show when={props.viewMenuOpen}>
          <div class="lens-menu view-menu" role="menu">
            <div class="lens-menu-heading">{message('canvas.viewControls.heading.views')}</div>
            <button role="menuitemradio" aria-checked={props.activeView === GRAPH_EDITOR_KIND} onClick={() => props.onSelectView(GRAPH_EDITOR_KIND)}><strong>{message('canvas.viewControls.active.graph')}</strong></button>
            <button role="menuitemradio" aria-checked={props.activeView === APP_EDITOR_KIND} onClick={() => props.onSelectView(APP_EDITOR_KIND)}><strong>{message('canvas.viewControls.view.app')}</strong></button>
            <div class="lens-menu-heading">{message('canvas.viewControls.heading.namedNets')}</div>
            <button
              role="menuitem"
              data-testid="net-display-all-noodle"
              onClick={() => props.onSetAllNetsDisplay('noodle')}
            ><strong>{message('canvas.viewControls.namedNets.noodles.label')}</strong><small>{message('canvas.viewControls.namedNets.noodles.description')}</small></button>
            <button
              role="menuitem"
              data-testid="net-display-all-tags"
              onClick={() => props.onSetAllNetsDisplay('tags')}
            ><strong>{message('canvas.viewControls.namedNets.tags.label')}</strong><small>{message('canvas.viewControls.namedNets.tags.description')}</small></button>
            <button
              role="menuitem"
              data-testid="net-display-all-guide"
              onClick={() => props.onSetAllNetsDisplay('guide')}
            ><strong>{message('canvas.viewControls.namedNets.guides.label')}</strong><small>{message('canvas.viewControls.namedNets.guides.description')}</small></button>
          </div>
        </Show>
      </div>
      <div class="canvas-view-control">
        <button
          type="button"
          data-testid="lens-switcher"
          data-tooltip-label={props.lensMenuOpen ? undefined : message('canvas.viewControls.lens.tooltip')}
          aria-haspopup="menu"
          aria-expanded={props.lensMenuOpen}
          onClick={props.onToggleLensMenu}
        ><Icon icon={Layers} /> {props.activeLens.label} <Icon icon={ChevronDown} /></button>
        <Show when={props.lensMenuOpen}>
          <div class="lens-menu" role="menu">
            <div class="lens-menu-heading">{message('canvas.viewControls.heading.lenses')}</div>
            <For each={props.lenses}>{(lens) => <button role="menuitemradio" aria-checked={props.activeLens.id === lens.id} onClick={() => props.onSelectLens(lens.id)}><strong>{lens.label}</strong><small>{lens.description}</small></button>}</For>
          </div>
        </Show>
      </div>
    </div>
  )
}

/** Turn toolbar menu buttons into the same node target used by right-click. */
export function toolboxMenuRequest(
  hit: ToolboxButtonRect,
  selectedNodeIds: readonly string[],
): { readonly target: MenuTarget; readonly worldX: number; readonly worldY: number; readonly submenuId?: string } | undefined {
  const nodeId = selectedNodeIds[0]
  const menuButton = hit.button.id === 'core.more' ||
    hit.button.id === 'core.color' ||
    hit.button.id === 'core.mode'
  if (!menuButton || nodeId === undefined) return undefined
  return {
    target: { kind: 'node', nodeId },
    worldX: hit.x + hit.size / 2,
    worldY: hit.y + hit.size / 2,
    ...(hit.button.id === 'core.color'
      ? { submenuId: 'core.node.color' }
      : hit.button.id === 'core.mode'
        ? { submenuId: 'core.node.mode' }
        : {}),
  }
}

/** Normalize a node-name edit into the one collaborative document command. */
export function nodeTitleInvocation(
  graphId: string,
  nodeId: string,
  entered: string,
  originalTitle: string,
): CommandInvocation | undefined {
  const title = entered.trim()
  if (title.length === 0) return undefined
  return {
    command: 'node.setTitle',
    params: { graphId, nodeId, title: title === originalTitle ? null : title },
  }
}

const lifecyclePlanFailure = (
  action: 'extract' | 'flatten',
  message: string,
  graphId?: string,
  nodeId?: string,
  instancePath: readonly string[] = [],
): Diagnostic => diag('error', 'command', 'subgraph.lifecycle.boundaryUnresolved', `subgraph.${action}: ${message}`, {
  ...(graphId !== undefined && nodeId !== undefined
    ? {
        refs: [{ graphId, nodeId }],
        anchor: { occurrence: { instancePath: instancePath.map(asNodeId), node: asNodeId(nodeId) } },
      }
    : {}),
})

export function extractSubgraphInvocationThroughBridge(args: {
  readonly document: WorkflowDocument
  readonly graphId: string
  readonly instancePath: readonly string[]
  readonly selection: LifecycleSelectionSnapshot
  readonly resolveSchema: (type: string) => NodeSchema | undefined
  readonly report: (diagnostic: Diagnostic) => void
}): CommandInvocation | undefined {
  try {
    const invocation = extractInvocation(args.document, args.graphId, args.instancePath, args.selection, undefined, args.resolveSchema)
    if (invocation !== undefined) return invocation
    args.report(lifecyclePlanFailure('extract', 'selection geometry or schema plan could not be resolved'))
  } catch (error) {
    args.report(lifecyclePlanFailure('extract', `selection planning failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  return undefined
}

export function flattenSubgraphThroughBridge(args: {
  readonly document: WorkflowDocument
  readonly graphId: string
  readonly instancePath: readonly string[]
  readonly nodeId: string
  readonly occurrence: ResolvedGeometryItem | undefined
  readonly resolveSchema: (type: string) => NodeSchema | undefined
  readonly seedControllerEnabled: boolean
  readonly measure: TextMeasurer
  readonly widgetMeasure: WidgetMeasure
  readonly report: (diagnostic: Diagnostic) => void
  readonly dispatch: (invocation: CommandInvocation) => CommandOutcome
  readonly selectNodes: (nodeIds: readonly string[]) => void
}): boolean {
  const report = (message: string): false => {
    args.report(lifecyclePlanFailure('flatten', message, args.graphId, args.nodeId, args.instancePath))
    return false
  }
  const occurrenceNode = args.document.graphs[args.graphId]?.nodes[args.nodeId]
  const bodyId = subgraphDefIdOf(occurrenceNode?.type ?? '')
  if (bodyId === undefined) return report('selected occurrence definition could not be resolved')
  const shellRefusal = occurrenceNode === undefined
    ? undefined
    : flattenShellRefusalDiagnostic(occurrenceNode, args.graphId, args.instancePath, args.nodeId)
  if (shellRefusal !== undefined) {
    args.report(shellRefusal)
    return false
  }
  if (args.occurrence === undefined) return report('occurrence geometry could not be resolved')

  let invocation: CommandInvocation | undefined
  try {
    const resolve = documentResolver(args.document, args.resolveSchema)
    const bodyScene = buildScene({
      document: args.document,
      seedControllerEnabled: args.seedControllerEnabled,
      graphId: bodyId,
      resolve,
      tokens: defaultTokens,
      measure: args.measure,
      widgetMeasure: args.widgetMeasure,
      occurrenceView: occurrenceDynamicView(args.document, resolve, [...args.instancePath, args.nodeId]),
    })
    invocation = flattenInvocation(
      args.document,
      args.graphId,
      args.instancePath,
      args.nodeId,
      args.occurrence,
      geometryOfLifecycleScene(bodyScene),
      args.resolveSchema,
    )
  } catch (error) {
    return report(`occurrence planning failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (invocation === undefined) return report('occurrence geometry or schema plan could not be resolved')

  const before = new Set(Object.keys(args.document.graphs[args.graphId]?.nodes ?? {}))
  let outcome: CommandOutcome
  try {
    outcome = args.dispatch(invocation)
  } catch (error) {
    return report(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!outcome.ok) {
    if (outcome.diagnostics.length === 0) return report('command was refused without diagnostics')
    for (const diagnostic of outcome.diagnostics) args.report(diagnostic)
    return false
  }
  try {
    args.selectNodes(Object.keys(outcome.doc.graphs[args.graphId]?.nodes ?? {}).filter((id) => !before.has(id)))
  } catch (error) {
    args.report(diag('error', 'command', 'subgraph.lifecycle.selectionUpdateFailed', `subgraph.flatten: document committed but result selection failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  return true
}

const geometryOfLifecycleScene = (source: Scene): readonly ResolvedGeometryItem[] => [
  ...source.nodes.map((node): ResolvedGeometryItem => ({ id: node.id, kind: 'node', x: node.x, y: node.y, width: node.layout.width, height: node.layout.height })),
  ...source.reroutes.map((item): ResolvedGeometryItem => ({ id: item.id, kind: 'reroute', x: item.x, y: item.y, width: 0, height: 0 })),
  ...source.valueSources.map((item): ResolvedGeometryItem => ({ id: item.id, kind: 'valueSource', x: item.x, y: item.y, width: item.width, height: item.height })),
  ...source.selectors.map((item): ResolvedGeometryItem => ({ id: item.id, kind: 'selector', x: item.x, y: item.y, width: item.width, height: item.height })),
  ...source.groups.map((item): ResolvedGeometryItem => ({ id: item.id, kind: 'group', x: item.x, y: item.y, width: item.width, height: item.height })),
]

/**
 * Classify a delete gesture whose selection includes at least one effective
 * occurrence link. Occurrence deliveries delete one at a time through the
 * planner seam; any accompanying definition item, boundary pseudo-node, or
 * second delivery refuses by name instead of splitting across command paths.
 */
export function occurrenceDeleteDecision<Identity>(args: {
  readonly effectiveLinks: readonly (readonly Identity[] | undefined)[]
  readonly boundaryCount: number
  readonly nodeCount: number
  readonly rerouteCount: number
  readonly valueSourceCount: number
  readonly selectorCount: number
  readonly groupCount: number
  readonly netViewCount?: number
  readonly drilled: boolean
}): { kind: 'mixed' } | { kind: 'multi' } | { kind: 'occurrence'; identity: Identity } {
  const onlyEffectiveLinks =
    args.effectiveLinks.length > 0 && args.effectiveLinks.every((identity) => identity !== undefined) &&
    args.boundaryCount === 0 && args.nodeCount === 0 && args.rerouteCount === 0 &&
    args.valueSourceCount === 0 && args.selectorCount === 0 && args.groupCount === 0 &&
    (args.netViewCount ?? 0) === 0
  if (!onlyEffectiveLinks || !args.drilled) return { kind: 'mixed' }
  const identities = args.effectiveLinks.flatMap((items) => items ?? [])
  const unique = identities.filter((identity, index) =>
    identities.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(identity)) === index,
  )
  return unique.length === 1 ? { kind: 'occurrence', identity: unique[0]! } : { kind: 'multi' }
}

export function lifecycleOtherSelectionCount(controller: Pick<InteractionController,
  'getLinkSelection' | 'getRerouteSelection' | 'getValueSourceSelection' | 'getSelectorSelection' | 'getGroupSelection' | 'getNetViewSelection'
>): number {
  return controller.getLinkSelection().size + controller.getRerouteSelection().size +
    controller.getValueSourceSelection().size + controller.getSelectorSelection().size +
    controller.getGroupSelection().size + controller.getNetViewSelection().size
}

export function selectionDeleteInvocation(args: {
  readonly graphId: string
  readonly def: GraphDef
  readonly scene: Scene
  readonly nodeIds: readonly string[]
  readonly selectedLinks: readonly string[]
  readonly rerouteIds?: readonly string[]
  readonly valueSourceIds?: readonly string[]
  readonly selectorIds?: readonly string[]
  readonly groupIds?: readonly string[]
  readonly selectedNetViews?: readonly SceneNetStub[]
}): CommandInvocation | undefined {
  const { graphId, def, scene, nodeIds, selectedLinks } = args
  const rerouteIds = [...(args.rerouteIds ?? [])]
  const valueSourceIds = [...(args.valueSourceIds ?? [])]
  const selectorIds = [...(args.selectorIds ?? [])]
  const groupIds = [...(args.groupIds ?? [])]
  const selectedNetViews = [...(args.selectedNetViews ?? [])]
  const deletedNodes = new Set(nodeIds)
  const linkIds: string[] = []
  const netSinks: { node: string; port: string; members?: string[] }[] = []
  const boundaryOps: { command: string; params: JsonObject }[] = []
  const freedNodes = new Set<string>()
  for (const id of selectedLinks) {
    const link = scene.links.find((candidate) => candidate.id === id)
    if (!link) continue
    if (link.from.kind === 'boundary' && link.to.kind === 'port') {
      const boundaryFrom = link.from
      const primaryDeleted = boundaryFrom.side === 'inputs' &&
        deletedNodes.has(def.boundary?.inputs.find((item) => item.id === boundaryFrom.item)?.binds.node ?? '')
      if (deletedNodes.has(link.to.node) || primaryDeleted) continue
      boundaryOps.push({
        command: 'boundary.unbind',
        params: {
          graphId, side: link.from.side, itemId: link.from.item,
          node: link.to.node, port: link.to.port,
          ...(link.to.members !== undefined ? { members: [...link.to.members] } : {}),
        },
      })
      freedNodes.add(link.to.node)
    } else if (link.to.kind === 'boundary' && link.from.kind === 'port') {
      if (deletedNodes.has(link.from.node)) continue
      boundaryOps.push({
        command: 'boundary.unbind',
        params: {
          graphId, side: link.to.side, itemId: link.to.item,
          node: link.from.node, port: link.from.port,
          ...(link.from.members !== undefined ? { members: [...link.from.members] } : {}),
        },
      })
    } else if (link.to.kind === 'boundary' && link.from.kind === 'widgetTap') {
      if (deletedNodes.has(link.from.node)) continue
      boundaryOps.push({
        command: 'boundary.unbind',
        params: {
          graphId, side: link.to.side, itemId: link.to.item,
          node: link.from.node, tap: link.from.input,
        },
      })
    } else if (link.netId !== undefined && link.to.kind === 'port') {
      netSinks.push({
        node: link.to.node, port: link.to.port,
        ...(link.to.members !== undefined ? { members: [...link.to.members] } : {}),
      })
      freedNodes.add(link.to.node)
    } else {
      linkIds.push(id)
      if (link.to.kind === 'port') freedNodes.add(link.to.node)
    }
  }
  if (nodeIds.length > 0) {
    for (const link of Object.values(def.links)) {
      if ('node' in link.from && deletedNodes.has(link.from.node) && isPortEndpoint(link.to) && !deletedNodes.has(link.to.node))
        freedNodes.add(link.to.node)
    }
    for (const net of Object.values(def.nets)) {
      if (!deletedNodes.has(net.source.node)) continue
      for (const sink of net.sinks) if (!deletedNodes.has(sink.node)) freedNodes.add(sink.node)
    }
    for (const item of def.boundary?.inputs ?? []) {
      if (!deletedNodes.has(item.binds.node)) continue
      for (const binding of item.alsoBinds ?? []) {
        if (!deletedNodes.has(binding.node)) freedNodes.add(binding.node)
      }
    }
  }
  const hasDeleteItems =
    nodeIds.length > 0 || linkIds.length > 0 || netSinks.length > 0 ||
    rerouteIds.length > 0 || valueSourceIds.length > 0 || selectorIds.length > 0
  const removedNets = new Set(selectedNetViews.filter((stub) => stub.role === 'source').map((stub) => stub.netId))
  const graphDeletesNet = (netId: string): boolean => {
    const net = def.nets[netId]
    return net !== undefined && deletedNodes.has(net.source.node)
  }
  const graphDeletesSink = (stub: SceneNetStub): boolean =>
    deletedNodes.has(stub.nodeId) || netSinks.some((sink) =>
      sink.node === stub.nodeId && sink.port === stub.portId &&
      JSON.stringify(sink.members ?? []) === JSON.stringify(stub.members ?? []),
    )
  const invocations: { command: string; params: JsonObject }[] = [
    ...(hasDeleteItems ? [{
      command: 'graph.deleteItems',
      params: { graphId, nodeIds: [...nodeIds], linkIds, netSinks, rerouteIds, valueSourceIds, selectorIds } as JsonObject,
    }] : []),
    ...boundaryOps,
    ...groupIds.map((groupId) => ({
      command: 'view.removeGroup', params: { graphId, groupId } as JsonObject,
    })),
    ...[...removedNets].filter((netId) => !graphDeletesNet(netId)).map((netId) => ({
      command: 'net.remove', params: { graphId, netId } as JsonObject,
    })),
    ...selectedNetViews.flatMap((stub) =>
      stub.role === 'sink' && !removedNets.has(stub.netId) && !graphDeletesNet(stub.netId) && !graphDeletesSink(stub)
        ? [{
            command: 'net.disconnectInput',
            params: {
              graphId,
              to: {
                node: stub.nodeId,
                port: stub.portId,
                ...(stub.members === undefined ? {} : { members: [...stub.members] }),
              },
            } as JsonObject,
          }]
        : [],
    ),
    ...[...freedNodes]
      .filter((nodeId) => !nodeIds.includes(nodeId))
      .map((nodeId) => ({
        command: 'dynamic.compact', params: { graphId, nodeId } as JsonObject,
      })),
  ]
  if (invocations.length === 0) return undefined
  return invocations.length === 1
    ? invocations[0]! as CommandInvocation
    : { command: 'batch', params: { invocations } } as unknown as CommandInvocation
}

export function reportBoundaryExposureRefusal(args: {
  readonly tabId: string | undefined
  readonly reportProblems: (tabId: string, diagnostics: readonly Diagnostic[]) => void
  readonly source: BoundaryExposureSource
  readonly side: 'inputs' | 'outputs'
}): void {
  if (args.tabId === undefined) return
  const producer = args.source.kind === 'widgetTap'
    ? `widget tap '${args.source.node}.${args.source.tap}'`
    : `${args.source.kind === 'valueSource' ? 'value source' : args.source.kind} '${args.source.id}'`
  const reason = args.source.kind === 'widgetTap'
    ? 'widget taps are output bindings only'
    : 'structural producers require stamped public output types'
  args.reportProblems(args.tabId, [diag(
    'warning',
    'command',
    'boundary.structuralProducerUnsupported',
    `Cannot expose ${producer} on boundary ${args.side}: ${reason}`,
  )])
}

/** Fixed-position style for a node overlay, clipped to the canvas rect. */
function overlayClipStyle(rect: EditorWorldRect, canvasEl: HTMLCanvasElement): Record<string, string> {
  const canvas = canvasEl.getBoundingClientRect()
  const top = Math.max(0, canvas.top - rect.y)
  const right = Math.max(0, rect.x + rect.width - (canvas.left + canvas.width))
  const bottom = Math.max(0, rect.y + rect.height - (canvas.top + canvas.height))
  const left = Math.max(0, canvas.left - rect.x)
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    'clip-path': `inset(${top}px ${right}px ${bottom}px ${left}px)`,
  }
}

export function NodeMediaOverlay(props: {
  readonly ownerId?: string
  readonly media: NodePreview & { readonly kind: 'video' | 'audio'; readonly src: string }
  readonly rect: EditorWorldRect
  readonly scale: number
  readonly canvas: HTMLCanvasElement
  readonly onMediaError?: () => void
  readonly onActiveChange?: (active: boolean) => void
  readonly videoPreferences?: VideoPreferences | undefined
  readonly onVideoPreferences?: (preferences: VideoPreferences) => void
}) {
  const interactive = () => props.scale >= defaultTokens.mediaControlMinScale
  const style = () => overlayClipStyle(props.rect, props.canvas)
  const forwardWheel = (event: WheelEvent): void => {
    event.preventDefault()
    props.canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: event.clientX,
      clientY: event.clientY,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    }))
  }
  return (
    <div class="node-media-overlay" data-node-id={props.ownerId} data-media-kind={props.media.kind} style={style()} onWheel={forwardWheel}>
      <Show when={props.media.kind !== 'video' && interactive() && props.media.download}>
        {(download) => <PreviewDownload class="node-output-download" download={download()} label="Download" />}
      </Show>
      <Show when={props.media.kind === 'video'} fallback={
        <AudioTransport media={props.media} interactive={interactive()} onActiveChange={(active) => props.onActiveChange?.(active)}
          onMediaError={() => props.onMediaError?.()} />
      }>
        <VideoPreview media={props.media} preferences={props.videoPreferences} onPreferences={props.onVideoPreferences}
          overview={!interactive()} onActiveChange={props.onActiveChange} onMediaError={props.onMediaError} />
      </Show>
    </div>
  )
}

/**
 * Orbit viewport for a model3d node preview. The canvas paints the poster;
 * this overlay owns download and orbit actions. Opening the viewer mounts
 * three.js lazily over the poster. Camera state stays local to the viewer.
 */
export function NodeModel3dOverlay(props: {
  readonly ownerId?: string
  readonly media: NodePreview & { readonly kind: 'model3d'; readonly src: string }
  readonly rect: EditorWorldRect
  readonly scale: number
  readonly canvas: HTMLCanvasElement
  readonly onActiveChange?: (active: boolean) => void
}) {
  const [active, setActive] = createSolidSignal(false)
  const [failed, setFailed] = createSolidSignal(false)
  let container: HTMLDivElement | undefined
  let viewer: { dispose(): void } | undefined
  let mountToken = 0
  const interactive = () => props.scale >= defaultTokens.mediaControlMinScale
  const close = (): void => {
    mountToken += 1
    viewer?.dispose()
    viewer = undefined
    setActive(false)
    props.onActiveChange?.(false)
  }
  const open = async (): Promise<void> => {
    if (active()) return
    setFailed(false)
    setActive(true)
    props.onActiveChange?.(true)
    const token = ++mountToken
    const src = props.media.src
    try {
      const { mountModel3dViewer } = await import('./model3d-viewer.js')
      if (token !== mountToken || container === undefined) return
      const handle = await mountModel3dViewer(container, src, props.media.mime)
      if (token !== mountToken) {
        handle.dispose()
        return
      }
      viewer = handle
    } catch {
      if (token === mountToken) setFailed(true)
    }
  }
  // A page change or new execution swaps the source without remounting the
  // overlay; an open viewer would keep showing the old model.
  createEffect(on(() => props.media.src, () => close(), { defer: true }))
  onCleanup(() => {
    mountToken += 1
    viewer?.dispose()
    viewer = undefined
    queueMicrotask(() => props.onActiveChange?.(false))
  })
  return (
    <div
      class="node-media-overlay"
      data-node-id={props.ownerId}
      data-media-kind="model3d"
      style={overlayClipStyle(props.rect, props.canvas)}
    >
      <Show when={active()} fallback={
        <Show when={interactive()}>
          <div class="node-model3d-actions">
            <Show when={props.media.download}>
              {(download) => <a class="node-output-download" href={download().src} download={download().name}>Download</a>}
            </Show>
            <button
              type="button"
              class="node-model3d-open"
              aria-label="Open 3D orbit view"
              onClick={() => void open()}
            >Orbit</button>
          </div>
        </Show>
      }>
        <div class="node-model3d-viewport" ref={(value) => { container = value }}>
          <Show when={failed()}>
            <div class="node-media-failed">3D viewer unavailable</div>
          </Show>
          <button
            type="button"
            class="node-model3d-close"
            aria-label="Close 3D orbit view"
            onClick={close}
          >Close</button>
          <Show when={props.media.download}>
            {(download) => <a class="node-output-download" href={download().src} download={download().name}>Download</a>}
          </Show>
        </div>
      </Show>
    </div>
  )
}

function forwardOverlayWheel(event: WheelEvent, canvas: HTMLCanvasElement): void {
  event.preventDefault()
  canvas.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: event.clientX,
    clientY: event.clientY,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  }))
}

export function NodeOutputPager(props: {
  readonly title: string
  readonly index: number
  readonly count: number
  readonly outputKey?: string
  readonly mediaKind?: 'image' | 'video' | 'audio' | 'model3d'
  readonly refusal?: string | undefined
  readonly download?: NonNullable<NodePreview['download']> | undefined
  readonly width?: number
  readonly height?: number
  readonly rect: EditorWorldRect
  readonly canvas: HTMLCanvasElement
  readonly onPrevious: () => void
  readonly onNext: () => void
  readonly onOpen?: () => void
  readonly onActiveChange?: (active: boolean) => void
}) {
  const mediaKind = () => props.mediaKind ?? 'image'
  const style = () => ({
    left: `${props.rect.x}px`, top: `${props.rect.y}px`, width: `${props.rect.width}px`, height: `${props.rect.height}px`,
  })
  let root!: HTMLDivElement
  const page = (action: () => void): void => {
    const focusedLabel = root.contains(document.activeElement)
      ? document.activeElement?.getAttribute('aria-label')
      : undefined
    action()
    if (focusedLabel === undefined || props.outputKey === undefined) return
    queueMicrotask(() => {
      const replacement = [...document.querySelectorAll<HTMLElement>('[data-testid="node-output-pager"]')]
        .find((element) => element.dataset['outputKey'] === props.outputKey)
      const nextControl = [...(replacement?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((button) => button.getAttribute('aria-label') === focusedLabel)
      nextControl?.focus()
    })
  }
  onCleanup(() => {
    const focusedLabel = root.contains(document.activeElement)
      ? document.activeElement?.getAttribute('aria-label')
      : undefined
    queueMicrotask(() => {
      const replacement = props.outputKey === undefined
        ? undefined
        : [...document.querySelectorAll<HTMLElement>('[data-testid="node-output-pager"]')]
            .find((element) => element.dataset['outputKey'] === props.outputKey)
      if (replacement !== undefined) {
        if (focusedLabel !== undefined) {
          [...replacement.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.getAttribute('aria-label') === focusedLabel)?.focus()
        }
        return
      }
      props.onActiveChange?.(false)
    })
  })
  return (
    <div
      ref={root}
      class="node-output-pager"
      data-testid="node-output-pager"
      data-output-key={props.outputKey}
      data-media-kind={mediaKind()}
      style={style()}
      onWheel={(event) => forwardOverlayWheel(event, props.canvas)}
      onKeyDown={(event) => {
        if (mediaKind() !== 'image' || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'ArrowLeft' && props.index > 0) page(props.onPrevious)
        if (event.key === 'ArrowRight' && props.index < props.count - 1) page(props.onNext)
      }}
      onFocusIn={() => props.onActiveChange?.(true)}
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onActiveChange?.(false)
      }}
    >
      <div class="node-output-pager-controls" role="group" aria-label={`${props.title} execution ${mediaKind()}s`}>
        <Show when={props.refusal}>{(reason) => <span class="image-preview-refusal" role="alert">{reason()}</span>}</Show>
        <Show when={props.count > 1}>
          <button type="button" aria-label={`Previous ${mediaKind()} for ${props.title}`} disabled={props.index <= 0} onClick={() => page(props.onPrevious)}>Previous</button>
          <Show when={props.onOpen !== undefined} fallback={
            <span class="node-output-position node-output-label" aria-label={`${mediaKind()} ${props.index + 1} of ${props.count} for ${props.title}`}>
              <span>{props.index + 1}/{props.count}</span>
            </span>
          }>
            <button type="button" class="node-output-position" aria-label={`Open ${mediaKind()} ${props.index + 1} of ${props.count} for ${props.title}`} onClick={() => props.onOpen?.()}>
              <span>{props.index + 1}/{props.count}</span>
              <Show when={props.width !== undefined && props.height !== undefined}>
                <small>{props.width}x{props.height}</small>
              </Show>
            </button>
          </Show>
          <button type="button" aria-label={`Next ${mediaKind()} for ${props.title}`} disabled={props.index >= props.count - 1} onClick={() => page(props.onNext)}>Next</button>
        </Show>
        <Show when={props.count === 1 && props.onOpen !== undefined}>
          <button type="button" class="node-output-position" aria-label={`Open image 1 of 1 for ${props.title}`} onClick={() => props.onOpen?.()}>Open image</button>
        </Show>
        <Show when={props.download}>
          {(download) => <a href={download().src} download={download().name}>Download</a>}
        </Show>
      </div>
    </div>
  )
}

export function visibleOutputPagerRect(
  rect: EditorWorldRect,
  canvas: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): EditorWorldRect | undefined {
  const left = Math.max(rect.x, canvas.left)
  const top = Math.max(rect.y, canvas.top)
  const right = Math.min(rect.x + rect.width, canvas.left + canvas.width)
  const bottom = Math.min(rect.y + rect.height, canvas.top + canvas.height)
  if (right - left < 150 || bottom - top < 72) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function commitRegionCreation(
  app: AppState,
  tab: Tab,
  graphId: string,
  position: { x: number; y: number },
  kind: RegionKind,
  selectOccurrence: (nodeId: string) => void,
): CommandOutcome {
  if (tab.execution) return { ok: false, diagnostics: [] }
  const occurrenceNodeId = tab.store.predictedNodeId(graphId)
  if (occurrenceNodeId === undefined) return { ok: false, diagnostics: [] }
  const outcome = app.createRegion(tab, graphId, position, kind)
  if (outcome.ok) selectOccurrence(occurrenceNodeId)
  return outcome
}

/**
 * Production occurrence mutation planner: the core trusted-plan pipeline
 * behind the canvas planner seam. Snapshot-backed planning keeps stale or
 * unresolvable intentions refusing by name instead of dispatching.
 */
export const coreOccurrencePlanner: OccurrenceMutationPlanner = { planOccurrenceLinkMutation }

export function occurrenceCompactionTarget(
  document: WorkflowDocument,
  link: EffectiveLink,
): { readonly graphId: string; readonly nodeId: string } | undefined {
  if (link.identity.kind === 'parentLeg') {
    const delivery = link.identity.delivery
    const graph = document.graphs[delivery.graph]
    const endpoint = delivery.kind === 'link'
      ? graph?.links[delivery.linkId]?.to
      : delivery.to
    if (!graph || !endpoint || !isPortEndpoint(endpoint)) return undefined
    const node = graph.nodes[endpoint.node]
    return node?.dynamic !== undefined ? { graphId: graph.id, nodeId: node.id } : undefined
  }
  const source = link.to.source
  if (source.kind === 'occurrence' && source.endpoint.kind === 'boundary') {
    const endpoint = source.endpoint
    let graph = document.graphs[document.root]
    for (const hop of endpoint.occurrence.instancePath) {
      const occurrence = graph?.nodes[hop]
      const bodyGraph = occurrence && subgraphDefIdOf(occurrence.type)
      graph = bodyGraph === undefined ? undefined : document.graphs[bodyGraph]
    }
    const node = graph?.nodes[endpoint.occurrence.node]
    return graph && node?.dynamic !== undefined
      ? { graphId: graph.id, nodeId: node.id }
      : undefined
  }
  const endpoint = source.endpoint
  if (!('node' in endpoint)) return undefined
  const graphId = source.kind === 'occurrence'
    ? link.to.graphId
    : 'graphId' in link.identity
      ? link.identity.graphId
      : link.to.graphId
  const node = document.graphs[graphId]?.nodes[endpoint.node]
  return node?.dynamic !== undefined ? { graphId, nodeId: node.id } : undefined
}

function occurrenceMutationInvocation(args: {
  readonly document: WorkflowDocument
  readonly resolver: Parameters<OccurrenceMutationPlanner['planOccurrenceLinkMutation']>[1]
  readonly intention: OccurrenceLinkIntention
  readonly invocation: CommandInvocation
}): CommandInvocation {
  if (args.intention.kind !== 'disconnect' && args.intention.kind !== 'rewire') return args.invocation
  const effective = effectiveOccurrenceTopology(args.document, args.resolver, args.intention.owner)
  if (effective.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return args.invocation
  const identity = canonicalJson(args.intention.link)
  const link = [...effective.links, ...effective.projectedParentLinks]
    .find((candidate) => canonicalJson(candidate.identity) === identity)
  const target = link && occurrenceCompactionTarget(args.document, link)
  if (target === undefined) return args.invocation
  return {
    command: 'batch',
    params: {
      invocations: [
        args.invocation,
        { command: 'dynamic.compact', params: target },
      ],
    },
  } as CommandInvocation
}

export function dispatchOccurrenceIntention(args: {
  readonly document: WorkflowDocument
  readonly resolver: Parameters<OccurrenceMutationPlanner['planOccurrenceLinkMutation']>[1]
  readonly intention: OccurrenceLinkIntention
  readonly planner: OccurrenceMutationPlanner | undefined
  readonly dispatch: (invocation: CommandInvocation) => CommandOutcome
  readonly report: (diagnostics: readonly Diagnostic[]) => void
}): CommandOutcome {
  if (args.planner === undefined) {
    const diagnostics = [diag(
      'error',
      'command',
      'occurrence.link.plannerUnavailable',
      'Occurrence-local link editing is unavailable until its mutation planner is installed.',
    )]
    args.report(diagnostics)
    return { ok: false, diagnostics }
  }
  const planned = args.planner.planOccurrenceLinkMutation(args.document, args.resolver, args.intention)
  if (!planned.ok) {
    args.report(planned.diagnostics)
    return { ok: false, diagnostics: planned.diagnostics }
  }
  return args.dispatch(occurrenceMutationInvocation({
    document: args.document,
    resolver: args.resolver,
    intention: args.intention,
    invocation: planned.invocation,
  }))
}

interface CanvasFileDropSurface {
  readonly state: 'drag' | 'disabled' | 'inspecting' | 'uploading' | 'success' | 'error'
  readonly title: string
  readonly detail: string
  readonly facts?: readonly { readonly label: string; readonly value: string }[]
  readonly cancelable?: boolean
}

export function CanvasHost(props: { app: AppState; host?: EditorHostContext; tooltips?: TooltipController; occurrencePlanner?: OccurrenceMutationPlanner; federatedAssets?: AssetDtoV1WireContract }) {
  const tooltipOwner = Symbol('canvas-host')
  const [occurrencePlanner, setOccurrencePlanner] = createSolidSignal(props.occurrencePlanner)
  const [gestureRefusal, setGestureRefusal] = createSolidSignal<{
    readonly id: number
    readonly diagnostic: Diagnostic
    readonly x: number
    readonly y: number
    readonly maxHeight: number
    readonly contentMaxHeight: number
  }>()
  const [fileDropSurface, setFileDropSurface] = createSolidSignal<CanvasFileDropSurface>()
  let gestureRefusalId = 0
  let gestureRefusalTimer: ReturnType<typeof setTimeout> | undefined
  let cancelCanvasFileDrop: (() => void) | undefined
  let lastCanvasPointer: { readonly x: number; readonly y: number } | undefined
  let canvasEl!: HTMLCanvasElement
  let minimapEl!: HTMLCanvasElement
  const tabs = useSignal(props.app.tabs)
  const globalActiveTabId = useSignal(props.app.activeTabId)
  // When hosted inside a split group, this editor shows the group's active
  // tab, which may differ from the app-global active tab.
  const activeTabId = (): string => props.host?.tabId() ?? globalActiveTabId()
  const hostFocused = (): boolean => props.host?.focused() ?? true
  const executions = useSignal(props.app.store.executions)
  const overlayPins = useSignal(props.app.overlayPins)
  const lenses = useSignal(props.app.lenses)
  const backendsTick = useSignal(props.app.backendsTick)
  const tabTargets = useSignal(props.app.tabTargets)
  const settingsTick = useSignal(props.app.settings.changed)
  const collabTabs = useSignal(props.app.collabTabs)
  const modalPanel = useSignal(props.app.modalPanel)
  const diagnosticFocus = useSignal(props.app.diagnosticFocus)
  const problems = useSignal(props.app.problems)
  // Scene/widget diagnostics for THIS editor instance. The app-level
  // solveDiagnostics signal mirrors the focused instance only, so an
  // unfocused split sibling keeps its own rail without clobbering the
  // Problems panel.
  const [instanceDiagnostics, setInstanceDiagnostics] = createSolidSignal<readonly Diagnostic[]>([])

  const activeTab = (): Tab | undefined => tabs().find((t) => t.id === activeTabId())

  const showGestureRefusal = (diagnostics: readonly Diagnostic[]): void => {
    const diagnostic = diagnostics[0]
    if (diagnostic === undefined) return
    const canvas = canvasEl?.getBoundingClientRect()
    const point = lastCanvasPointer ?? {
      x: canvas === undefined ? window.innerWidth / 2 : canvas.left + canvas.width / 2,
      y: canvas === undefined ? window.innerHeight / 2 : canvas.top + canvas.height / 2,
    }
    const x = Math.max(12, Math.min(point.x + 12, window.innerWidth - 360))
    const y = Math.max(12, Math.min(point.y + 12, window.innerHeight - 120))
    setGestureRefusal({
      id: ++gestureRefusalId,
      diagnostic,
      x,
      y,
      maxHeight: Math.max(0, window.innerHeight - y - 12),
      contentMaxHeight: Math.max(0, window.innerHeight - y - 34),
    })
    if (gestureRefusalTimer !== undefined) clearTimeout(gestureRefusalTimer)
    gestureRefusalTimer = setTimeout(() => setGestureRefusal(undefined), 4_000)
  }

  const reportGestureRefusal = (owner: string, diagnostics: readonly Diagnostic[]): void => {
    props.app.reportProblems(owner, diagnostics)
    showGestureRefusal(diagnostics)
  }

  const dispatchGesture = (tab: Tab, invocation: CommandInvocation): CommandOutcome => {
    const outcome = props.app.dispatchTo(tab, invocation)
    if (!outcome.ok) showGestureRefusal(outcome.diagnostics)
    return outcome
  }

  const presentFileDropResult = (surface: CanvasFileDropSurface | undefined): void => {
    setFileDropSurface(surface)
  }

  onCleanup(() => {
    if (gestureRefusalTimer !== undefined) clearTimeout(gestureRefusalTimer)
  })

  // The ACTIVE tab's backend schema registry (backends are never merged; a
  // tab targeting backend B must render with B's schemas). A MEMO, not a
  // plain function: backendsTick bumps on every connection status change
  // (ws flaps, reconnects), but downstream effects - above all the scene
  // effect, which closes menus/editors on rerun - must only react when the
  // registry REFERENCE actually changes.
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
  const widgetPainter = createMemo(() => createRegistryPainter(widgetRegistry()))

  // Bumped whenever the active tab's document or graph stack changes; the
  // scene effect depends on it. Subscriptions rebind on tab switch.
  const [docTick, setDocTick] = createSolidSignal(0)
  const [widgetA11yTargets, setWidgetA11yTargets] = createSolidSignal<readonly {
    id: string
    label: string
    target?: unknown
    pressed?: boolean
    disabled?: boolean
    activate?: () => void
  }[]>([])
  const [previewA11yTargets, setPreviewA11yTargets] = createSolidSignal<readonly CanvasPreviewA11yTarget[]>([])
  const [semanticScene, setSemanticScene] = createSolidSignal<{
    readonly owner: string
    readonly items: readonly CanvasSemanticItem[]
  }>({ owner: 'empty', items: [] })
  const [semanticSource, setSemanticSource] = createSolidSignal<{
    readonly owner: string
    readonly source: CanvasSemanticSource
  }>()
  const [semanticFocused, setSemanticFocused] = createSolidSignal(false)
  createEffect(() => {
    const current = semanticSource()
    const focused = semanticFocused()
    if (focused && current !== undefined && window.__dinksterTest !== undefined) {
      window.__dinksterTest.semanticDerivations += 1
    }
    setSemanticScene({
      owner: current?.owner ?? 'empty',
      items: focused && current !== undefined ? buildCanvasSemanticItems(current.source) : [],
    })
  })
  let semanticTargetSelected: (target: CanvasSemanticTarget) => boolean = () => false
  let activateSemanticItem: (item: CanvasSemanticItem) => void = () => {}
  let focusSemanticPin: (item: CanvasSemanticItem | undefined) => void = () => {}
  let focusCanvas = (): void => {}
  const [editorViewport, setEditorViewport] = createSolidSignal({ x: 0, y: 0, scale: 1 })
  const [canvasClientRect, setCanvasClientRect] = createSolidSignal({ left: 0, top: 0, width: 0, height: 0 })
  const [mediaPreviews, setMediaPreviews] = createSolidSignal<readonly {
    readonly id: string
    readonly node: EditorWorldRect
    readonly preview: EditorWorldRect
    readonly media: NodePreview & { readonly kind: 'video' | 'audio' | 'model3d'; readonly src: string }
    readonly onMediaError?: () => void
  }[]>([])
  const [activeCanvasMedia, setActiveCanvasMedia] = createSolidSignal<ReadonlySet<string>>(new Set())
  const [selectedNodeIds, setSelectedNodeIds] = createSolidSignal<ReadonlySet<string>>(new Set())
  const setCanvasMediaActive = (id: string, active: boolean): void => {
    setActiveCanvasMedia((current) => {
      if (current.has(id) === active) return current
      const next = new Set(current)
      if (active) next.add(id)
      else next.delete(id)
      return next
    })
  }
  createEffect(() => {
    activeTabId()
    setActiveCanvasMedia(new Set<string>())
  })
  const mediaPreviewById = createMemo(() => new Map(mediaPreviews().map((item) => [item.id, item])))
  const [outputPages, setOutputPages] = createSolidSignal<ReadonlyMap<string, number>>(new Map())
  const [outputImagePreviews, setOutputImagePreviews] = createSolidSignal<readonly {
    readonly id: string
    readonly title: string
    readonly node: EditorWorldRect
    readonly preview: EditorWorldRect
    readonly output: ExecutedImagePreview
    readonly download?: NodePreview['download']
    readonly width?: number
    readonly height?: number
  }[]>([])
  createEffect(() => {
    const live = new Set([
      ...mediaPreviews().map((item) => `media:${item.id}`),
      ...outputImagePreviews().map((item) => `pager:${item.output.key}`),
    ])
    setActiveCanvasMedia((current) => retainActiveOverlayKeys(current, live))
  })
  const outputImagePreviewByKey = createMemo(() => new Map(outputImagePreviews().map((item) => [item.output.key, item])))
  const outputImagePreviewFor = (key: string) => outputImagePreviewByKey().get(key)
  const [outputViewerKey, setOutputViewerKey] = createSolidSignal<string>()
  const visibleMediaPreviewIds = (): readonly string[] => {
    const viewport = editorViewport()
    if (viewport.scale < CANVAS_DETAIL_MIN_SCALE) return []
    const canvas = canvasClientRect()
    const active = activeCanvasMedia()
    const selected = selectedNodeIds()
    return boundedVisibleOverlayKeys(
      mediaPreviews(),
      (item) => item.id,
      (item) => mediaScreenRect(item.node, item.preview, viewport, canvas) !== undefined,
      (item) => active.has(`media:${item.id}`) || selected.has(item.id),
    )
  }
  const visibleOutputPreviewKeys = (): readonly string[] => {
    const viewport = editorViewport()
    if (viewport.scale < CANVAS_DETAIL_MIN_SCALE) return []
    const canvas = canvasClientRect()
    const active = activeCanvasMedia()
    const selected = selectedNodeIds()
    const viewer = outputViewerKey()
    return boundedVisibleOverlayKeys(
      outputImagePreviews().filter((item) => item.output.count > 1 || item.download !== undefined || item.output.batch !== undefined || item.output.refusal !== undefined),
      (item) => item.output.key,
      (item) => {
        if (item.output.batch === undefined && viewport.scale < defaultTokens.mediaControlMinScale) return false
        const rect = mediaScreenRect(item.node, item.preview, viewport, canvas)
        return rect !== undefined && visibleOutputPagerRect(rect, canvas) !== undefined
      },
      (item) => active.has(`pager:${item.output.key}`) || selected.has(item.id) || viewer === item.output.key,
    )
  }
  const outputViewerPreview = createMemo(() => {
    const key = outputViewerKey()
    return key === undefined ? undefined : outputImagePreviewFor(key)
  })
  const outputViewerProvenance = (): ExecutionOutputProvenance | undefined => {
    executions()
    overlayPins()
    backendsTick()
    const tab = activeTab()
    const execution = tab === undefined ? undefined : props.app.executionForTab(tab)
    if (execution === undefined) return undefined
    return executionOutputProvenance(execution, props.app.backendFor(execution.ref.connection))
  }
  const outputViewer = createMemo(() => {
    const preview = outputViewerPreview()
    const provenance = outputViewerProvenance()
    return preview === undefined || provenance === undefined ? undefined : { preview, provenance }
  })
  const closeOutputViewer = (): void => {
    const key = outputViewerKey()
    setOutputViewerKey(undefined)
    if (key === undefined) return
    queueMicrotask(() => {
      const pager = [...document.querySelectorAll<HTMLElement>('[data-testid="node-output-pager"]')]
        .find((element) => element.dataset['outputKey'] === key)
      pager?.querySelector<HTMLButtonElement>('.node-output-position')?.focus()
    })
  }
  createEffect(() => {
    if (outputViewerKey() !== undefined && outputViewerPreview() === undefined) setOutputViewerKey(undefined)
  })
  createEffect(() => {
    const tab = activeTab()
    if (!tab) return
    const bump = () => setDocTick((n) => n + 1)
    const unsubDoc = tab.store.document.subscribe(bump)
    const unsubStack = tab.graphStack.subscribe(bump)
    // The drilled scene derives occurrence topology from viewInstancePath,
    // so an instancePath write must rebuild even when the graph stack is
    // untouched (occurrence switch, or a write landing after the stack's).
    const unsubPath = tab.instancePath.subscribe(bump)
    // Extension gate flips add/remove widget kinds and menu contributions;
    // the scene must rebuild so gated widgets fall back (and return).
    const unsubExtensions = props.app.extensions.changed.subscribe(bump)
    onCleanup(() => {
      unsubDoc()
      unsubStack()
      unsubPath()
      unsubExtensions()
    })
  })

  const [editor, setEditor] = createSolidSignal<WidgetEditorState | undefined>(undefined)
  let editorDocumentRevision: number | undefined
  let editorExtensionsGeneration: number | undefined
  // Reduce the open widget editor to app-level focus facts for the Context
  // panel; value-source editors carry no node identity and publish nothing.
  // Only the focused instance publishes, and it retracts only the exact
  // facts it published, so an unfocused split sibling never clears or
  // overwrites the focused instance's publication.
  let publishedWidgetFocus: { nodeId: string; valueKey: string; label: string } | undefined
  const retractWidgetFocus = (): void => {
    if (publishedWidgetFocus !== undefined && props.app.widgetFocus.get() === publishedWidgetFocus) {
      props.app.widgetFocus.set(undefined)
    }
    publishedWidgetFocus = undefined
  }
  createEffect(() => {
    const state = editor()
    const facts = hostFocused() && state !== undefined && state.target.kind === 'input'
      ? { nodeId: state.target.nodeId, valueKey: state.target.valueKey, label: state.label }
      : undefined
    untrack(() => {
      if (facts !== undefined) {
        publishedWidgetFocus = facts
        props.app.widgetFocus.set(facts)
      } else retractWidgetFocus()
    })
  })
  onCleanup(retractWidgetFocus)
  let editorClickAway: (() => void) | undefined
  let openAssetWidgetAt = (_clientX: number, _clientY: number): void => {}
  interface ControllerMenuState {
    readonly x: number
    readonly y: number
    /** The tab the menu opened over - dispatch targets it, never whoever is active at click time. */
    readonly tab: Tab
    readonly graphId: string
    readonly nodeId: string
    readonly inputId: string
    readonly mode: ControllerMode
    readonly trigger: 'after_generate' | 'after_refresh'
  }
  const [controllerMenu, setControllerMenu] = createSolidSignal<ControllerMenuState | undefined>(undefined)
  let controllerMenuEl!: HTMLDivElement
  createEffect(() => {
    const menu = controllerMenu()
    if (menu === undefined) return
    let resizeObserver: ResizeObserver | undefined
    const place = (): void => {
      if (controllerMenu() !== menu || controllerMenuEl === undefined) return
      const canvas = canvasEl.getBoundingClientRect()
      const placement = placeFloatingSurface({
        surface: { width: controllerMenuEl.offsetWidth, height: controllerMenuEl.scrollHeight },
        anchor: { left: menu.x, top: menu.y, right: menu.x, bottom: menu.y },
        bounds: { left: 0, top: 0, right: canvas.width, bottom: canvas.height },
        direction: 'point',
        margin: 4,
        gap: 0,
      })
      controllerMenuEl.style.left = `${placement.left}px`
      controllerMenuEl.style.top = `${placement.top}px`
      controllerMenuEl.style.maxHeight = `${placement.maxHeight}px`
    }
    const onResize = (): void => place()
    onCleanup(() => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', onResize)
    })
    queueMicrotask(() => {
      if (controllerMenu() !== menu || controllerMenuEl === undefined) return
      place()
      window.addEventListener('resize', onResize)
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(onResize)
        resizeObserver.observe(canvasEl)
      }
    })
  })
  const commitControllerMode = (
    controller: Pick<ControllerMenuState, 'tab' | 'graphId' | 'nodeId' | 'inputId'>,
    mode: ControllerMode,
  ): boolean => {
    // The compact canvas-row menu is the sole controller surface. Refuse
    // when the tab object that opened it is gone.
    if (!props.app.tabs.get().includes(controller.tab)) return false
    const outcome = props.app.dispatchTo(controller.tab, { command: 'node.setController', params: {
      graphId: controller.graphId,
      nodeId: controller.nodeId,
      inputId: controller.inputId,
      mode,
    } })
    return outcome.ok
  }
  const [selectionSize, setSelectionSize] = createSolidSignal(0)
  const [linkSelectionSize, setLinkSelectionSize] = createSolidSignal(0)
  const [rerouteSelectionSize, setRerouteSelectionSize] = createSolidSignal(0)
  const [valueSourceSelectionSize, setValueSourceSelectionSize] = createSolidSignal(0)
  const [selectorSelectionSize, setSelectorSelectionSize] = createSolidSignal(0)
  const [groupSelectionSize, setGroupSelectionSize] = createSolidSignal(0)
  // Bumped on EVERY selection change (size alone misses same-size swaps);
  // the partial-scope preview effect keys off it.
  const [selVersion, setSelVersion] = createSolidSignal(0)
  const [stack, setStack] = createSolidSignal<readonly string[]>([])
  const [minimapMenu, setMinimapMenu] = createSolidSignal(false)
  const [minimapMenuPose, setMinimapMenuPose] = createSolidSignal<MinimapMenuPlacement>({ above: false })
  let minimapSettingsEl!: HTMLButtonElement
  let cornerControlsEl!: HTMLDivElement
  const measureMinimapMenu = (): void => {
    const stageEl = cornerControlsEl.offsetParent
    const stage = stageEl?.getBoundingClientRect()
    // The popover may reach up to the stage top, but not into the floating
    // top toolbar row when one is present.
    const toolbar = stageEl?.querySelector('.canvas-stage-toolbar')?.getBoundingClientRect()
    const top = Math.max(stage?.top ?? 0, toolbar?.bottom ?? 0)
    setMinimapMenuPose(minimapMenuPlacement(cornerControlsEl.getBoundingClientRect(), { left: stage?.left ?? 0, top }))
  }
  const openMinimapMenu = (): void => {
    measureMinimapMenu()
    setMinimapMenu(true)
    queueMicrotask(() => document.querySelector<HTMLElement>('.minimap-menu .minimap-setting-row')?.focus())
  }
  createEffect(() => {
    if (!minimapMenu()) return
    window.addEventListener('resize', measureMinimapMenu)
    onCleanup(() => window.removeEventListener('resize', measureMinimapMenu))
  })
  const closeMinimapMenu = (): void => {
    setMinimapMenu(false)
    queueMicrotask(() => minimapSettingsEl?.focus())
  }
  const minimapVisible = (): boolean => (settingsTick(), props.app.settings.get<boolean>('canvas.minimap.visible'))
  const toggleMinimap = (): void => {
    const next = !props.app.settings.get<boolean>('canvas.minimap.visible')
    props.app.settings.set('canvas.minimap.visible', next)
    if (next) repaintMinimap?.()
    else setMinimapMenu(false)
  }
  const [embeddedDropChoice, setEmbeddedDropChoice] = createSolidSignal<{
    readonly loadImage: () => void
    readonly openWorkflow: () => void
    readonly cancel: () => void
    readonly valid: () => boolean
  } | undefined>()
  /** Set in onMount; canvas chrome delegates to the mounted renderer. */
  let repaintMinimap: (() => void) | undefined
  let zoomCanvas: ((factor: number) => void) | undefined
  let resetCanvasZoom: (() => void) | undefined
  let fitCanvas: (() => void) | undefined

  const frozen = (): boolean => activeTab()?.execution !== undefined

  createEffect(() => {
    tabs(); activeTabId(); docTick(); backendsTick(); tabTargets()
    const choice = embeddedDropChoice()
    if (choice !== undefined && !choice.valid()) choice.cancel()
  })

  createEffect(() => {
    if (!controllerMenu()) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setControllerMenu(undefined) }
    window.addEventListener('keydown', close)
    onCleanup(() => window.removeEventListener('keydown', close))
  })
  const activeLens = () => {
    lenses()
    const tab = activeTab()
    return props.app.lensRegistry.resolve(tab ? props.app.lensFor(tab.id) : undefined)
  }

  // -- badge popover ----------------------------------------------------------
  // Opened by clicking a node header badge (error chip, subgraph marker).
  // Anchored in canvas-pane CSS px; content resolves lazily at render.
  const [badgePopover, setBadgePopover] = createSolidSignal<BadgeAnchor | undefined>(undefined)

  // Replacement scan items for the CURRENT graph, keyed by node id. Rebuilt
  // by the badges effect; read lazily by the deprecation badge popover.
  let replaceItems = new Map<string, ReplacementScanItem>()
  /** Current graph's document problem content, keyed independently of runtime errors. */
  let nodeProblems: NodeProblemMap = {}

  // -- value source popover ---------------------------------------------------
  // Opened by clicking a value source's spec badge. Shows the effective
  // spec's provenance (declared/derived/raw), conflicts, and pin/unpin.
  interface ValueSourcePopoverState {
    readonly x: number
    readonly y: number
    readonly valueSourceId: string
  }
  const [vsPopover, setVsPopover] = createSolidSignal<ValueSourcePopoverState | undefined>(undefined)

  interface SelectorExecPopoverState {
    readonly x: number
    readonly y: number
    readonly selectorId: string
  }
  /** Frozen-view selector badge popover: the branch this execution ACTUALLY ran. */
  const [selExecPopover, setSelExecPopover] = createSolidSignal<SelectorExecPopoverState | undefined>(undefined)

  /**
   * Execution-recorded resolution of one selector on a frozen tab, resolved
   * lazily at render from the artifact (authoritative) plus the snapshot
   * document (titles/ordinals) - never stored.
   */
  const selectorExecInfoFor = (id: string) => {
    executions()
    const tab = activeTab()
    if (!tab?.execution) return undefined
    const gid = currentGraphId(tab)
    const sel = tab.store.doc.graphs[gid]?.selectors?.[id]
    if (!sel) return undefined
    const exec = props.app.executionForTab(tab)
    const choice = exec?.artifact?.choices?.find((c) => c.graph === gid && c.selector === id)
    const index = choice ? sel.candidates.findIndex((c) => c.id === choice.candidate) : -1
    return { sel, choice, index, candidate: index >= 0 ? sel.candidates[index] : undefined }
  }

  /**
   * Value source popover content, resolved lazily at render from the live
   * document (the popover survives value edits; the spec is derived fresh -
   * never stored - exactly like the scene build does).
   */
  const valueSourceInfoFor = (id: string) => {
    docTick()
    const tab = activeTab()
    const reg = registry()
    if (!tab) return undefined
    const graphId = currentGraphId(tab)
    const def = tab.store.doc.graphs[graphId]
    const vs = def?.valueSources?.[id]
    if (!def || !vs) return undefined
    const resolve = reg ? documentResolver(tab.store.doc, reg.resolve) : () => undefined
    const effective = effectiveValueSourceSpec(def, vs, resolve)
    const specState: 'declared' | 'derived' | 'raw' = vs.spec ? 'declared' : effective.spec ? 'derived' : 'raw'
    return { graphId, vs, effective, specState }
  }

  /** Pin the CURRENT effective spec as declared (derivation stops moving). */
  const pinValueSourceSpec = (id: string): void => {
    const tab = activeTab()
    const info = valueSourceInfoFor(id)
    if (!tab || tab.execution || !info) return
    const spec = pinnedSpecOf(info.effective)
    if (!spec) return
    props.app.dispatchTo(tab, {
      command: 'valueSource.setSpec',
      params: { graphId: info.graphId, valueSourceId: id, spec },
    })
  }

  /** Clear the declared spec back to fully derived. Never touches the value. */
  const unpinValueSourceSpec = (id: string): void => {
    const tab = activeTab()
    const info = valueSourceInfoFor(id)
    if (!tab || tab.execution || !info) return
    props.app.dispatchTo(tab, {
      command: 'valueSource.setSpec',
      params: { graphId: info.graphId, valueSourceId: id, spec: null },
    })
  }

  // -- net name prompt --------------------------------------------------------
  // App-owned text popover for the two net actions that need a name (create,
  // rename). Everything else about nets is plain commands.
  interface NetPromptState {
    readonly x: number
    readonly y: number
    readonly mode: 'create' | 'rename'
    /** create: the output being promoted (structural: port + member path). */
    readonly source?: { readonly node: string; readonly port: string; readonly members?: readonly string[] }
    /** rename: the net being renamed. */
    readonly netId?: string
    readonly initial: string
  }
  const [netPrompt, setNetPrompt] = createSolidSignal<NetPromptState | undefined>(undefined)

  const netPromptCommit = (name: string): void => {
    const p = netPrompt()
    setNetPrompt(undefined)
    const tab = activeTab()
    if (!p || !tab || tab.execution) return
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    const graphId = currentGraphId(tab)
    if (p.mode === 'create' && p.source) {
      props.app.dispatchTo(tab, {
        command: 'net.create',
        params: {
          graphId,
          name: trimmed,
          source: {
            node: p.source.node,
            port: p.source.port,
            ...(p.source.members !== undefined ? { members: [...p.source.members] } : {}),
          },
        },
      })
    } else if (p.mode === 'rename' && p.netId !== undefined) {
      props.app.dispatchTo(tab, { command: 'net.rename', params: { graphId, netId: p.netId, name: trimmed } })
    }
  }

  // -- group rename prompt ----------------------------------------------------
  // Same shape as the net prompt: a text popover anchored at the menu point.
  interface GroupPromptState {
    readonly x: number
    readonly y: number
    readonly groupId: string
    readonly initial: string
  }
  const [groupPrompt, setGroupPrompt] = createSolidSignal<GroupPromptState | undefined>(undefined)

  const groupPromptCommit = (title: string): void => {
    const p = groupPrompt()
    setGroupPrompt(undefined)
    const tab = activeTab()
    if (!p || !tab || tab.execution) return
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    props.app.dispatchTo(tab, {
      command: 'view.setGroupTitle',
      params: { graphId: currentGraphId(tab), groupId: p.groupId, title: trimmed },
    })
  }

  // -- node rename prompt -----------------------------------------------------
  // Reuses the same anchored one-line prompt as group rename.
  interface NodePromptState {
    readonly x: number
    readonly y: number
    readonly nodeId: string
    readonly initial: string
    readonly originalTitle: string
    readonly tab: Tab
    readonly graphId: string
  }
  const [nodePrompt, setNodePrompt] = createSolidSignal<NodePromptState | undefined>(undefined)

  const nodePromptCommit = (title: string): void => {
    const p = nodePrompt()
    setNodePrompt(undefined)
    if (!p || activeTab() !== p.tab || p.tab.execution || currentGraphId(p.tab) !== p.graphId) return
    const invocation = nodeTitleInvocation(p.graphId, p.nodeId, title, p.originalTitle)
    if (invocation) props.app.dispatchTo(p.tab, invocation)
  }

  // -- selector rename prompt -------------------------------------------------
  // Same shape as the group prompt: a text popover anchored at the menu point.
  interface SelectorPromptState {
    readonly x: number
    readonly y: number
    readonly selectorId: string
    readonly initial: string
  }
  const [selectorPrompt, setSelectorPrompt] = createSolidSignal<SelectorPromptState | undefined>(undefined)

  const selectorPromptCommit = (title: string): void => {
    const p = selectorPrompt()
    setSelectorPrompt(undefined)
    const tab = activeTab()
    if (!p || !tab || tab.execution) return
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    props.app.dispatchTo(tab, {
      command: 'selector.setTitle',
      params: { graphId: currentGraphId(tab), selectorId: p.selectorId, title: trimmed },
    })
  }

  // -- boundary slot rename prompt --------------------------------------------
  // Same shape as the selector prompt. Committing an empty string CLEARS the
  // display name (the slot falls back to its stable item id).
  interface BoundaryPromptState {
    readonly x: number
    readonly y: number
    readonly side: 'inputs' | 'outputs'
    readonly itemId: string
    readonly initial: string
  }
  const [boundaryPrompt, setBoundaryPrompt] = createSolidSignal<BoundaryPromptState | undefined>(undefined)
  let lifecycleSelectNodes: ((ids: readonly string[]) => void) | undefined

  const boundaryPromptCommit = (name: string): void => {
    const p = boundaryPrompt()
    setBoundaryPrompt(undefined)
    const tab = activeTab()
    if (!p || !tab || tab.execution) return
    props.app.dispatchTo(tab, {
      command: 'boundary.renameItem',
      params: { graphId: currentGraphId(tab), side: p.side, itemId: p.itemId, displayName: name.trim() },
    })
  }

  // Tab or graph navigation dismisses any pending name editors: the prompts
  // are anchored to a menu position that no longer means anything.
  createEffect(() => {
    activeTabId()
    stack()
    setNetPrompt(undefined)
    setGroupPrompt(undefined)
    setNodePrompt(undefined)
    setSelectorPrompt(undefined)
    setBoundaryPrompt(undefined)
  })

  /** Per-node run log slices from the latest overlay derivation (view-attributed). */
  const [runLogsByNode, setRunLogsByNode] = createSolidSignal<
    ReadonlyMap<string, readonly ExecutionLogEntry[]>
  >(new Map())
  /**
   * Per-node run error slices from the same derivation: the one per-view
   * projection of the job error report that also drives the bottom error
   * badge, so badge, tooltip, and popover can never disagree.
   */
  const [runErrorsByNode, setRunErrorsByNode] = createSolidSignal<
    ReadonlyMap<string, readonly Diagnostic[]>
  >(new Map())
  /** Node error badges the user dismissed, keyed by execution key (V9). */
  const [dismissedErrorNodes, setDismissedErrorNodes] = createSolidSignal<
    ReadonlyMap<string, ReadonlySet<string>>
  >(new Map())
  /** Log records of one node at one level, for the bottom-badge popover. */
  const nodeRunLogs = (nodeId: string, level: 'info' | 'warning'): readonly ExecutionLogEntry[] =>
    (runLogsByNode().get(nodeId) ?? []).filter((entry) => entry.level === level)
  /** Hide this run's error badge on the node; the error report is untouched. */
  const dismissNodeError = (nodeId: string): void => {
    const tab = activeTab()
    const exec = tab ? props.app.executionForTab(tab) : undefined
    setBadgePopover(undefined)
    if (!exec) return
    setDismissedErrorNodes((current) => {
      const next = new Map(current)
      next.set(exec.key, new Set([...(next.get(exec.key) ?? []), nodeId]))
      return next
    })
  }
  /**
   * Open the Execution log panel filtered to this node's rows. A scene node
   * can hold several runtime occurrences (nested subgraph nodes roll up to
   * their instance node), so the request carries every runtime id its badges
   * aggregate.
   */
  const openExecutionLogForNode = (nodeId: string): void => {
    setBadgePopover(undefined)
    const ids = new Set<string>()
    for (const entry of runLogsByNode().get(nodeId) ?? []) {
      if (entry.runtimeNodeId !== undefined) ids.add(entry.runtimeNodeId)
    }
    for (const d of nodeErrors(nodeId)) {
      const value = d.data?.['runtimeId']
      if (typeof value === 'string') ids.add(value)
    }
    props.app.requestExecutionLogFocus(ids.size > 0 ? [...ids] : [nodeId])
  }

  /** Run error report entries anchored to a node of the CURRENT view. */
  const nodeErrors = (nodeId: string): readonly Diagnostic[] =>
    runErrorsByNode().get(nodeId) ?? []

  // -- in-node previews -------------------------------------------------------
  // Execution imagery and selected image assets drawn inside node bodies.
  // Source picking, async decoding, the decode-once cache, and
  // the peek negative cache live in createPreviewLoader (framework-free);
  // the host re-assembles the preview map when a decode lands (previewTick).
  // Outputs win for finished nodes; live frames win while a node runs.
  // Native peeks (GET /api/values) render imagery the event stream never
  // carried: a node's own recorded outputs, or - for a node that never ran
  // (added/rewired after the run) - its producers' outputs; candidates come
  // from peekCandidatesFor (host state: companion sources + occurrences).
  const [previewTick, setPreviewTick] = createSolidSignal(0)
  const previewLoader = createPreviewLoader({
    viewUrlForExecution: (ref, file) => props.app.viewUrlForExecution(ref, file),
    assetUrlForExecution: (ref, digest) => props.app.assetUrlForExecution(ref, digest),
    assetUrlForInput: (digest) => {
      const tab = activeTab()
      if (tab === undefined) return undefined
      const backend = props.app.backendForTab(tab)
      return backend.protocol === 'dinkster' ? backend.connection.assetUrl(digest) : undefined
    },
    onDecoded: () => setPreviewTick((v) => v + 1),
    validateMediaRendition: validateBrowserMediaRendition,
  })

  // GPU image estimates for schema-declared glsl mirrors: one lazy WebGL2
  // context per host, one bounded bitmap cache; a finished compute
  // re-assembles the preview map exactly like a finished decode.
  const mirrorGlslRunner = createGlslMirrorRunner()
  const imageEstimator = createMirrorImageEstimator({
    render: (draw) => mirrorGlslRunner.renderDisplay(draw),
    onComputed: () => setPreviewTick((v) => v + 1),
  })

  // -- pack blueprint bodies (GET /api/packs/{packId}/blueprints/{id}) --------
  // Digest-keyed validate-once cache; descriptors are searchable without a
  // body fetch, so this loads only on insertion.
  const blueprintBodies = new BlueprintBodyCache()

  // -- add-node palette -------------------------------------------------------
  // Opened by double-click on empty canvas, or by dropping a fresh noodle
  // there (linkDrop set: the corpus narrows to compatible entries and the
  // pick also connects the dangling end). Anchored in canvas-pane CSS px;
  // the pick lands the node at the recorded world position. The host owns
  // only the anchor (open/close) and the corpus; every per-open ephemeral
  // (query, highlight, filters, clamping) lives in NodePalette and dies
  // with it when the anchor clears.
  const [palette, setPalette] = createSolidSignal<PaletteAnchor | undefined>(undefined)
  const [linkDoubleClickMenu, setLinkDoubleClickMenu] = createSolidSignal<{ x: number; y: number; context: LinkDoubleClickContext } | undefined>(undefined)
  /**
   * When the link menu opened. A midpoint single click opens it on release,
   * so the second press of a habitual double-click lands on the backdrop
   * milliseconds later; the backdrop ignores presses inside this window so
   * a double-click leaves the menu open instead of flashing it closed.
   */
  let linkMenuOpenedAt = 0
  const LINK_MENU_DISMISS_GRACE_MS = 350
  const [recentNodeTypes, setRecentNodeTypes] = createSolidSignal<readonly string[]>([])
  /** Set in onMount; the palette pick needs controller selection access. */
  let paletteCommit: (entry: PaletteEntry, placement?: PaletteAnchor) => void = () => {}
  interface ArmedPlacement {
    readonly entry: PaletteEntry
    readonly displayName: string
    readonly tab: Tab
    readonly graphId: string
    readonly backendId: string
    readonly frozenState: Tab['execution']
    readonly geometry: PlacementGeometry
    readonly schemaKey: string
    readonly graphRetired: () => boolean
    readonly unsubscribe: () => void
  }
  let armedPlacement: ArmedPlacement | undefined
  let armPaletteEntry: (entry: PaletteEntry) => boolean = () => false
  let commitArmedPlacement: (event: PointerEvent) => void = () => {}
  let openSplicePalette: (context: LinkDoubleClickContext) => void = () => {}
  /** Set in onMount; closing the palette clears its pending noodle ghost. */
  let clearPaletteGhost: () => void = () => {}

  // -- context menu -----------------------------------------------------------
  // Opened by right-click; items come from the app's MenuRegistry (core +
  // extensions through one API), resolved here at open time. Presentation
  // and keyboard nav live in ContextMenu (keyed mount below); invocation
  // stays here because host actions need controller/renderer closures.
  type OwnedMenuAnchor = MenuAnchor & {
    tab: Tab
    readonly graphId: string
    /** Drilled-occurrence identity: items resolved for one occurrence must not outlive a switch to another. */
    readonly pathKey: string
    documentRevision: number
    readonly schemaRegistry: ReturnType<AppState['registryForTab']>
    readonly workerCatalog: WorkerCatalogState
    readonly extensionsGeneration: number
  }
  const [menu, setMenu] = createSolidSignal<OwnedMenuAnchor | undefined>(undefined)
  const workerCatalog = (): WorkerCatalogState | undefined => {
    backendsTick()
    tabTargets()
    const tab = activeTab()
    return tab === undefined ? undefined : props.app.backendForTab(tab).workerCatalog.get()
  }
  createEffect(() => {
    const current = workerCatalog()
    const open = untrack(menu)
    if (open !== undefined && open.workerCatalog !== current) setMenu(undefined)
  })
  /** Set in onMount; invoking needs the controller + renderer closures. */
  let menuInvoke: (item: MenuActionItem) => void = () => {}

  // Backend schemas + this document's subgraph definitions, one flat list.
  // Extensions add entries by registering schemas, not by patching the UI.
  const paletteEntries = (): PaletteEntry[] => {
    props.app.extensionRevision.get()
    const entries: PaletteEntry[] = [
      {
        type: '__dinkster.reroute',
        name: 'Reroute',
        category: 'utility',
        kind: 'utility',
        fields: [{ text: 'Reroute', weight: 3 }, { text: 'utility junction dot', weight: 1 }],
      },
      ...(['map', 'fold', 'while'] as const).map((kind): PaletteEntry => ({
        type: `__dinkster.region.${kind}`,
        name: `${kind[0]!.toUpperCase()}${kind.slice(1)} region`,
        category: 'Regions',
        kind: 'utility',
        fields: [
          { text: `${kind} region`, weight: 3 },
          { text: 'loop repetition subgraph', weight: 1 },
        ],
      })),
    ]
    for (const kind of props.app.virtualNodeKinds.values()) {
      entries.push({
        type: kind.id,
        name: kind.title,
        category: 'Notes',
        ...(kind.description !== undefined ? { description: kind.description } : {}),
        kind: 'node',
        schema: kind.schema,
        fields: nodeSearchFields(kind.schema),
      })
    }
    const reg = registry()
    if (reg) {
      for (const s of reg.schemas.values()) {
        // Deprecated (structured, legacy, or explicit demotion) and hidden
        // schemas stay OUT of ordinary search; both remain valid on canvas.
        if (searchVisibilityOf(s) !== 'normal') continue
        entries.push({
          type: s.type,
          name: s.displayName,
          category: s.category,
          ...(s.description !== undefined ? { description: s.description } : {}),
          ...(s.pack !== undefined ? { pack: reg.packs?.get(s.pack)?.displayName ?? s.pack } : {}),
          kind: 'node',
          schema: s,
          fields: nodeSearchFields(s),
        })
      }
    }
    const tab = activeTab()
    if (tab) {
      const here = currentGraphId(tab)
      // Boundary-derived schemas make subgraphs port-filterable exactly
      // like backend nodes - "anything that works on a node works on a
      // subgraph" extends to in:/out: search.
      const resolve = reg ? documentResolver(tab.store.doc, reg.resolve) : () => undefined
      for (const def of Object.values(tab.store.doc.graphs)) {
        if (!def.boundary || def.id === here) continue
        const derived = resolve(`#${def.id}`)
        entries.push({
          type: `#${def.id}`,
          name: def.name,
          category: 'subgraph',
          kind: 'subgraph',
          ...(derived !== undefined ? { schema: derived } : {}),
          fields: [
            { text: def.name, weight: 3 },
            { text: `#${def.id}`, weight: 2 },
            { text: 'subgraph', weight: 1 },
          ],
        })
      }
    }
    // Pack-shipped blueprints: descriptors are inline on the packs table,
    // so search costs zero fetches - the body rides only on insertion.
    if (reg?.packs) {
      for (const [packId, info] of reg.packs) {
        for (const bp of info.blueprints ?? []) {
          entries.push({
            type: `blueprint:${packId}/${bp.id}`,
            name: bp.name,
            category: info.displayName,
            ...(bp.description !== undefined ? { description: bp.description } : {}),
            pack: info.displayName,
            kind: 'blueprint',
            blueprint: { packId, descriptor: bp },
            fields: [
              { text: bp.name, weight: 3 },
              { text: bp.id, weight: 2 },
              ...(bp.tags ?? []).map((t) => ({ text: t, weight: 2 })),
              ...(bp.description !== undefined ? [{ text: bp.description, weight: 1 }] : []),
              { text: info.displayName, weight: 1 },
            ],
          })
        }
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  const closePalette = (): void => {
    const restoreCanvasFocus = palette() !== undefined
    setPalette(undefined) // NodePalette unmounts; its ephemerals die with it
    clearPaletteGhost() // any pending noodle dies with its palette
    if (restoreCanvasFocus) queueMicrotask(() => canvasEl.focus())
  }

  // Canvas overlays cannot rely on focus-scoped handlers: focus may move to
  // a rail control (or elsewhere). One capture-phase pair supplies dismissal
  // to every overlay; ordinary widget popovers close without consuming the
  // same pointerdown, while modal/locked surfaces retain interception.
  createEffect(() => {
    const paletteOpen = palette() !== undefined
    const editorOpen = editor() !== undefined
    const minimapOpen = minimapMenu()
    if (!paletteOpen && !editorOpen && !minimapOpen) return

    const isInside = (event: Event, selector: string): boolean =>
      event.composedPath().some((item) => item instanceof Element && item.matches(selector))
    const EDITOR_SURFACES = '.widget-editor, .combo-dropdown, .color-editor, .asset-editor, .save-target-editor, .product-select-listbox, .suggestion-surface, .modal-surface[data-modal^="widget-"]'
    const AUDIO_SLIDER = '.node-media-overlay .product-slider'
    // An editor can refuse host dismissal while an effect is in flight (an
    // asset upload batch must not keep uploading into a closed overlay).
    // These handlers run window-capture, BEFORE any editor-local guard, so
    // the block must be consulted here - the editor advertises it via a
    // data attribute on its dialog body.
    const dismissBlocked = (): boolean =>
      document.querySelector('.widget-editor[data-dismiss-blocked]') !== null
    const dismiss = (event: Event, close: () => void): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    }
    const onWindowPointerDown = (event: PointerEvent): void => {
      if (paletteOpen) {
        if (!isInside(event, '.node-palette')) dismiss(event, closePalette)
        return
      }
      if (editorOpen) {
        const insideEditor = isInside(event, EDITOR_SURFACES)
        // A dismiss-blocked editor is modal: an outside press must neither
        // dismiss it NOR activate anything underneath (a second widget
        // would replace the editor mid-upload; a lens switch would rebuild
        // the scene and close it). Editor-internal presses stay usable.
        if (!insideEditor && dismissBlocked()) {
          event.preventDefault()
          event.stopImmediatePropagation()
          return
        }
        if (!insideEditor && isInside(event, AUDIO_SLIDER)) return
        if (!insideEditor) {
          if (isInNodeTextEditor(editor()!)) {
            // Canvas itself is not a sequential focus target, so an outside
            // press does not reliably move focus. Blur explicitly: the in-node
            // textarea commits, then this same press continues to
            // pan/select/activate its target.
            const field = document.querySelector<HTMLTextAreaElement>('[data-editor-surface="in-node"] textarea')
            if (field !== null && field === document.activeElement) field.blur()
            return
          }
          // Non-modal popovers are pointer-transparent outside their card.
          // Commit a valid changed field and tear down synchronously in
          // capture, then let this exact pointerdown continue to its canvas
          // or control target: click, pan, and selection are not a two-gesture
          // interaction.
          if (editorClickAway !== undefined) editorClickAway()
          else setEditor(undefined)
        }
        return
      }
      if (minimapOpen) {
        if (!isInside(event, '.minimap-menu')) dismiss(event, closeMinimapMenu)
      }
    }
    // Consuming pointerdown does not stop the browser's synthesized click,
    // so DOM controls (lens switcher, toolbar buttons) would still activate
    // through the lock - suppress those too while an editor is blocked.
    const onWindowActivation = (event: MouseEvent): void => {
      if (!editorOpen || !dismissBlocked()) return
      if (isInside(event, EDITOR_SURFACES)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      // Modal-lock keyboard firewall: while an editor refuses dismissal,
      // keys whose event path is OUTSIDE it must never reach application
      // shortcuts - an outside-focused Delete/undo/lens toggle changes the
      // document or scene and closes the blocked mount from behind. Keys
      // inside the editor stay usable (its own fields and controls).
      if (editorOpen && dismissBlocked() && !isInside(event, EDITOR_SURFACES)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        // Consuming Tab alone would strand a keyboard-only user: disabling
        // the file input when a batch starts can drop focus to the body,
        // and the recovery control (Cancel) lives inside the dialog. Pull
        // focus back into the blocked editor instead of eating the key.
        if (event.key === 'Tab') {
          document.querySelector('.widget-editor[data-dismiss-blocked]')
            ?.querySelector<HTMLElement>(
              'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
            )?.focus()
        }
        return
      }
      if (event.key !== 'Escape' || event.isComposing) return
      // An expanded product listbox owns the first Escape. Its trigger keeps
      // DOM focus, so the capture-phase host must defer to the target handler.
      if (editorOpen && isInside(event, '.product-select[aria-expanded="true"]')) return
      // An expanded palette type filter owns the first Escape and restores its trigger focus.
      if (paletteOpen && isInside(event, '.palette-type-filter[data-expanded="true"]')) return
      // A suggestion surface is part of the live text editor, not a
      // request to close that editor. Let its target handler close only the
      // surface; the ordinary host-owned editor Escape path resumes once the
      // surface is gone.
      if (editorOpen && document.querySelector('.suggestion-surface') &&
        isInside(event, '.widget-editor')) return
      if (paletteOpen) dismiss(event, closePalette)
      else if (editorOpen) {
        // Let an unblocked native widget dialog own Escape so the browser
        // runs its cancel/close lifecycle and restores the real opener.
        // Uploading remains in the blocked branch below.
        if (document.querySelector('.modal-surface[data-modal^="widget-"]') && !dismissBlocked()) return
        // Consume Escape but refuse the close while the editor is blocked:
        // the overlay owns the key either way (nothing behind it should see
        // an Escape aimed at a visibly open editor).
        if (dismissBlocked()) {
          event.preventDefault()
          event.stopImmediatePropagation()
        } else dismiss(event, () => {
          setEditor(undefined)
          queueMicrotask(() => canvasEl.focus())
        })
      }
      else if (minimapOpen) dismiss(event, closeMinimapMenu)
    }
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    // auxclick covers middle-click activation (tab close), dblclick covers
    // double-click-only surfaces - both synthesize independently of the
    // consumed pointerdown, so each needs its own capture guard.
    window.addEventListener('click', onWindowActivation, true)
    window.addEventListener('auxclick', onWindowActivation, true)
    window.addEventListener('dblclick', onWindowActivation, true)
    window.addEventListener('contextmenu', onWindowActivation, true)
    window.addEventListener('keydown', onWindowKeyDown, true)
    onCleanup(() => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      window.removeEventListener('click', onWindowActivation, true)
      window.removeEventListener('auxclick', onWindowActivation, true)
      window.removeEventListener('dblclick', onWindowActivation, true)
      window.removeEventListener('contextmenu', onWindowActivation, true)
      window.removeEventListener('keydown', onWindowKeyDown, true)
    })
  })

  onMount(() => {
    const removeGestureGuards = installCanvasGestureGuards(canvasEl)
    const renderer = new CanvasRenderer(
      canvasEl,
      defaultTokens,
      (args) => widgetPainter()(args),
    )
    const reducedMotionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : undefined
    const onReducedMotionChange = (event: MediaQueryListEvent) => renderer.setReducedMotion(event.matches)
    renderer.setReducedMotion(reducedMotionQuery?.matches ?? false)
    reducedMotionQuery?.addEventListener('change', onReducedMotionChange)
    const zoomTo = (target: number) => {
      const vp = renderer.getViewport()
      const cx = canvasEl.clientWidth / 2
      const cy = canvasEl.clientHeight / 2
      const scale = Math.min(4, Math.max(0.05, target))
      renderer.setViewport({ x: cx - ((cx - vp.x) / vp.scale) * scale, y: cy - ((cy - vp.y) / vp.scale) * scale, scale })
    }
    const zoomBy = (factor: number) => zoomTo(renderer.getViewport().scale * factor)
    zoomCanvas = zoomBy
    // Setting the scale directly keeps the reset exact; scale * (1 / scale)
    // does not round-trip to 1 in floating point.
    resetCanvasZoom = () => zoomTo(1)
    const fitView = () => renderer.fitToScene()
    fitCanvas = fitView
    const endpointPin = (end: unknown, direction: 'in' | 'out') => {
      if (typeof end !== 'object' || end === null || Array.isArray(end)) return undefined
      const e = end as JsonObject
      if (typeof e['node'] !== 'string' || typeof e['port'] !== 'string') return undefined
      return renderer.getScene().nodes.find((node) => node.id === e['node'])?.layout.pins.find((pin) =>
        pin.direction === direction && pin.address.port === e['port'] &&
        JSON.stringify(pin.address.members ?? []) === JSON.stringify(e['members'] ?? []),
      )
    }
    const specializeFreshConnect = (invocation: CommandInvocation): CommandInvocation => {
      const params = invocation.params as JsonObject
      const invocations = invocation.command === 'batch' && Array.isArray(params['invocations'])
        ? params['invocations'] as JsonObject[]
        : [invocation as unknown as JsonObject]
      const connectIndex = invocations.findIndex((entry) => entry['command'] === 'link.connect')
      if (connectIndex < 0) return invocation
      const connect = invocations[connectIndex]!
      const connectParams = connect['params'] as JsonObject
      const producer = endpointPin(connectParams['from'], 'out')
      const target = endpointPin(connectParams['to'], 'in')
      const slot = target?.dynamicSlot
      if (!producer || !slot) return invocation
      const variant = autoSpecialization(producer.type, slot.variants, slot.selected)
      if (variant === undefined) return invocation
      const to = connectParams['to'] as JsonObject
      const specialization = {
        command: 'dynamic.specializeSlot',
        params: {
          graphId: slot.owner?.graphId ?? connectParams['graphId'],
          nodeId: slot.owner?.nodeId ?? to['node'],
          construct: slot.owner?.construct ?? slot.construct,
          variant,
          ...((slot.owner?.ancestors ?? slot.ancestors).length > 0 ? { ancestors: slot.owner?.ancestors ?? slot.ancestors } : {}),
        },
      }
      // Rewires intentionally never enter this seam: removing their old edge
      // can invalidate the displayed solved type, so the advisory stays stale.
      return {
        command: 'batch',
        params: { invocations: [...invocations.slice(0, connectIndex + 1), specialization, ...invocations.slice(connectIndex + 1)] },
      } as CommandInvocation
    }
    createEffect(() => {
      settingsTick()
      renderer.setGridVisible(props.app.settings.get('canvas.grid.visible'))
      repaintMinimap?.()
    })

    // -- presence egress (shared sessions) ---------------------------------
    // Declared BEFORE the controller: its onSelectionChange callback can
    // fire during setup, and publishPresence reads both of these. The
    // channel owns throttling; this only assembles the local snapshot.
    let pointerWorld: { x: number; y: number } | undefined
    let lastSelection: ReadonlySet<string> = new Set()
    // This instance's latest selection snapshot; mirrored into the
    // app-level canvasSelection signal only while this editor is focused.
    let instanceSelection: CanvasSelectionSnapshot = EMPTY_CANVAS_SELECTION
    let lastRerouteSelection: ReadonlySet<string> = new Set()
    let hoverNode: string | undefined
    let dragOffsets: ReadonlyMap<string, { readonly dx: number; readonly dy: number }> | undefined
    let linkOrigin: PresenceLinkDrag['origin'] | undefined
    let refreshPresenceProjection = (): void => {}
    const linkPresence = (): PresenceLinkDrag | undefined => {
      const cursor = pointerWorld
      return cursor !== undefined && linkOrigin !== undefined ? { origin: linkOrigin, cursor } : undefined
    }
    const publishPresence = (): void => {
      const tab = activeTab()
      if (!tab) return
      const channel = collabTabs().get(tab.id)?.presence
      if (channel === undefined) return
      // Visible world rect from the live camera: omitted while the canvas
      // has no layout yet (zero CSS size would broadcast a degenerate rect).
      const vp = renderer.getViewport()
      const cw = canvasEl.clientWidth
      const ch = canvasEl.clientHeight
      const view = cw > 0 && ch > 0 && vp.scale > 0
        ? { x: -vp.x / vp.scale, y: -vp.y / vp.scale, w: cw / vp.scale, h: ch / vp.scale }
        : undefined
      const link = linkPresence()
      channel.setLocal({
        graph: currentGraphId(tab),
        cursor: pointerWorld,
        identity: { kind: 'human' },
        // Sorted so the channel's change detection sees set identity, not
        // whatever iteration order the controller's Set happens to hold.
        selection: [...lastSelection].sort(),
        ...(lastRerouteSelection.size > 0 ? { reroutes: [...lastRerouteSelection].sort() } : {}),
        ...(view !== undefined ? { view } : {}),
        ...(hoverNode !== undefined ? { hover: hoverNode } : {}),
        ...(dragOffsets !== undefined && dragOffsets.size > 0 ? { drag: dragOffsets } : {}),
        ...(link !== undefined ? { link } : {}),
      })
    }

    let controller!: InteractionController
    const lifecycleSelection = (): LifecycleSelectionSnapshot => ({
      nodeIds: [...controller.getSelection()].filter((id) => scene.nodes.some((node) => node.id === id)),
      rerouteIds: [...controller.getRerouteSelection()],
      valueSourceIds: [...controller.getValueSourceSelection()],
      selectorIds: [...controller.getSelectorSelection()],
      groupIds: [...controller.getGroupSelection()],
      geometry: geometryOfLifecycleScene(scene),
    })
    const canExtractSubgraph = (): boolean => hasExtractSelection(lifecycleSelection())
    const canFlattenSubgraph = (): boolean => {
      const tab = activeTab()
      return tab !== undefined && isFlattenSelection(tab.store.doc, currentGraphId(tab), [...controller.getSelection()], lifecycleOtherSelectionCount(controller))
    }
    const createRegionAt = (tab: Tab, graphId: string, position: { x: number; y: number }, kind: RegionKind): boolean => {
      return commitRegionCreation(props.app, tab, graphId, position, kind, (occurrenceNodeId) => {
        if (activeTab() === tab && currentGraphId(tab) === graphId) controller.setSelection([occurrenceNodeId])
      }).ok
    }
    const beginExtractSubgraph = (): boolean => {
      const tab = activeTab()
      const reg = tab ? props.app.registryForTab(tab) : undefined
      if (!tab || tab.execution || !reg || !canExtractSubgraph()) return false
      const graphId = currentGraphId(tab)
      const invocation = extractSubgraphInvocationThroughBridge({
        document: tab.store.doc,
        graphId,
        instancePath: viewInstancePath(tab) ?? [],
        selection: lifecycleSelection(),
        resolveSchema: reg.resolve,
        report: (diagnostic) => reportGestureRefusal(tab.id, [diagnostic]),
      })
      if (invocation === undefined) return false
      const result = commitExtract({
        invocation,
        beforeNodeIds: new Set(Object.keys(tab.store.doc.graphs[graphId]?.nodes ?? {})),
        graphId,
        dispatch: (command) => dispatchGesture(tab, command),
      })
      if (result.status === 'committed') lifecycleSelectNodes?.(result.selectedNodeIds)
      return true
    }
    const flattenSelectedSubgraph = (): boolean => {
      const tab = activeTab()
      const reg = tab ? props.app.registryForTab(tab) : undefined
      const graphId = tab ? currentGraphId(tab) : ''
      const nodeId = [...controller.getSelection()][0]
      if (!tab || tab.execution || !reg || !nodeId || !canFlattenSubgraph()) return false
      const occurrenceNode = scene.nodes.find((node) => node.id === nodeId)
      return flattenSubgraphThroughBridge({
        document: tab.store.doc,
        graphId,
        instancePath: viewInstancePath(tab) ?? [],
        nodeId,
        occurrence: occurrenceNode === undefined
          ? undefined
          : { id: nodeId, kind: 'node', x: occurrenceNode.x, y: occurrenceNode.y, width: occurrenceNode.layout.width, height: occurrenceNode.layout.height },
        resolveSchema: reg.resolve,
        seedControllerEnabled: props.app.settings.get<boolean>('features.seedController.enabled'),
        measure,
        widgetMeasure,
        report: (diagnostic) => reportGestureRefusal(tab.id, [diagnostic]),
        dispatch: (invocation) => tab.store.dispatch(invocation),
        selectNodes: (nodeIds) => controller.setSelection(nodeIds),
      })
    }
    const widgetExposureItem = (
      tab: Tab,
      node: SceneNode,
      row: Extract<LayoutRow, { kind: 'widget' }>,
    ): MenuActionItem | undefined => {
      const target = widgetMenuTarget(node.id, row)
      const ctx = canvasMenuContext({
        doc: tab.store.doc,
        namedNets: props.app.settings.get<boolean>('features.namedNets.enabled'),
        graphId: currentGraphId(tab),
        target,
        selection: {
          nodes: [...controller.getSelection()],
          links: [...controller.getLinkSelection()],
          reroutes: [...controller.getRerouteSelection()],
          valueSources: [...controller.getValueSourceSelection()],
          selectors: [...controller.getSelectorSelection()],
        },
        worldX: node.x + row.inset,
        worldY: node.y + row.y,
      })
      const item = props.app.menuRegistry.resolve(ctx)
        .flatMap((group) => group.items)
        .find((candidate) => candidate.id === 'core.widget.expose.toggle')
      return item?.action !== undefined ? item as MenuActionItem : undefined
    }
    const previewExposureItem = (tab: Tab, node: SceneNode): MenuActionItem | undefined => {
      const ctx = canvasMenuContext({
        doc: tab.store.doc,
        namedNets: props.app.settings.get<boolean>('features.namedNets.enabled'),
        graphId: currentGraphId(tab),
        target: { kind: 'node', nodeId: node.id, previewSurface: true },
        selection: {
          nodes: [...controller.getSelection()],
          links: [...controller.getLinkSelection()],
          reroutes: [...controller.getRerouteSelection()],
          valueSources: [...controller.getValueSourceSelection()],
          selectors: [...controller.getSelectorSelection()],
        },
        worldX: node.x + node.layout.width / 2,
        worldY: node.y + node.layout.height / 2,
      })
      const item = props.app.menuRegistry.resolve(ctx)
        .flatMap((group) => group.items)
        .find((candidate) => candidate.id === 'core.node.preview.expose.toggle')
      return item?.action !== undefined ? item as MenuActionItem : undefined
    }
    lifecycleSelectNodes = (ids) => controller.setSelection(ids)
    const openCanvasMenu = (
      target: MenuTarget,
      worldX: number,
      worldY: number,
      additionalGroups: readonly ResolvedMenuGroup[] = [],
      submenuId?: string,
    ): void => {
      const tab = activeTab()
      if (!tab) return
      if (target.kind === 'node') {
        const nodeId = target.nodeId
        const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
        const region = node?.layout.preview ?? node?.layout.textOutput
        if (node !== undefined && region !== undefined &&
            worldX >= node.x + region.x && worldX <= node.x + region.x + region.width &&
            worldY >= node.y + region.y && worldY <= node.y + region.y + region.height) {
          target = { ...target, previewSurface: true }
        }
      }
      closePalette()
      setEditor(undefined)
      // Schema display name of a node target: menu items (Reset Name) need it
      // to distinguish a real rename from an equal-to-original title.
      const targetNode = target.kind === 'node'
        ? tab.store.doc.graphs[currentGraphId(tab)]?.nodes[target.nodeId]
        : undefined
      const menuRegistry = registry()
      const menuResolve = menuRegistry ? documentResolver(tab.store.doc, menuRegistry.resolve) : undefined
      const targetSchema = targetNode ? menuResolve?.(targetNode.type) : undefined
      const previewCapable = previewCapabilityOf(menuRegistry, menuResolve)
      const mirrorCapable = mirrorCapabilityOf(menuResolve)
      const ctx = canvasMenuContext({
        doc: tab.store.doc,
        namedNets: props.app.settings.get<boolean>('features.namedNets.enabled'),
        ...(targetNode ? { nodeDisplayName: targetSchema?.displayName ?? targetNode.type } : {}),
        ...(targetSchema?.hasDocs === true ? { nodeHasDocs: true } : {}),
        ...(previewCapable !== undefined ? { previewCapable } : {}),
        ...(mirrorCapable !== undefined ? { mirrorCapable } : {}),
        shortcuts: Object.fromEntries([
          'edit.delete',
          'node.mute',
          'node.bypass',
          'node.minimize',
          'node.help',
        ].flatMap((command) => {
          const combo = props.app.keybindings.combo(command)
          return combo === undefined ? [] : [[command, combo]]
        })),
        graphId: currentGraphId(tab),
        target,
        selection: {
          nodes: [...controller.getSelection()],
          links: [...controller.getLinkSelection()],
          reroutes: [...controller.getRerouteSelection()],
          valueSources: [...controller.getValueSourceSelection()],
          selectors: [...controller.getSelectorSelection()],
        },
        worldX,
        worldY,
      })
      const menuNodeIds = target.kind === 'node'
        ? (ctx.selection.nodes.includes(target.nodeId) ? ctx.selection.nodes : [target.nodeId])
        : []
      const menuWorkerCatalog = props.app.backendForTab(tab).workerCatalog.get()
      const placementGroup = runOnMachineMenuGroup({
        document: tab.store.doc,
        graphId: currentGraphId(tab),
        nodeIds: menuNodeIds,
        catalog: menuWorkerCatalog,
        frozen: tab.execution !== undefined,
      })
      const scopes = menuNodeIds.length > 0
        ? props.app.selectionExecutionScopes(tab, menuNodeIds)
        : undefined
      const hasExplicitImageEntry = additionalGroups.some((group) => group.items.some((item) => item.id === 'core.image.edit'))
      const selectionImageTarget = hasExplicitImageEntry
        ? undefined
        : props.app.imageTargetForSelection(tab, currentGraphId(tab), ctx.selection.nodes)
      const resolvedGroups = [
        ...resolveNodeMenuGroups(
          props.app.menuRegistry,
          ctx,
          scopes?.upTo !== undefined,
          tab.execution === undefined,
        ),
        ...selectionLifecycleMenuGroups(target, {
          group: '15-subgraph-lifecycle',
          items: [
            {
              id: 'core.subgraph.extract',
              label: 'Extract as Subgraph',
              icon: 'group',
              ...(props.app.keybindings.combo('subgraph.extract') ? { shortcut: props.app.keybindings.combo('subgraph.extract')! } : {}),
              action: { kind: 'host' as const, action: 'extractSubgraph' },
              disabled: tab.execution !== undefined || !canExtractSubgraph(),
            },
            {
              id: 'core.subgraph.flatten',
              label: 'Flatten Subgraph One Level',
              icon: 'ungroup',
              ...(props.app.keybindings.combo('subgraph.flatten') ? { shortcut: props.app.keybindings.combo('subgraph.flatten')! } : {}),
              action: { kind: 'host' as const, action: 'flattenSubgraph' },
              disabled: tab.execution !== undefined || !canFlattenSubgraph(),
            },
          ],
        }),
        ...(placementGroup === undefined ? [] : [placementGroup]),
        ...(selectionImageTarget ? [{
          group: '46-image-editor',
          items: [{
            id: 'core.image.edit',
            label: 'Edit image',
            action: { kind: 'host' as const, action: 'openImageEditor', params: {
              nodeId: selectionImageTarget.nodeId,
              inputId: selectionImageTarget.inputId,
            } },
          }],
        }] : []),
        ...additionalGroups,
      ]
      const submenu = submenuId === undefined
        ? undefined
        : resolvedGroups.flatMap((group) => group.items).find((item) => item.id === submenuId)
      const groups = submenuId === undefined
        ? resolvedGroups
        : submenu?.children !== undefined
          ? [{ group: `toolbox-${submenuId}`, items: submenu.children }]
          : []
      if (groups.length === 0) {
        setMenu(undefined)
        return
      }
      const vp = renderer.getViewport()
      setMenu({
        x: worldX * vp.scale + vp.x, y: worldY * vp.scale + vp.y, worldX, worldY, groups,
        tab, graphId: currentGraphId(tab), pathKey: (viewInstancePath(tab) ?? []).join('/'),
        documentRevision: tab.store.revision, schemaRegistry: menuRegistry,
        workerCatalog: menuWorkerCatalog,
        extensionsGeneration: props.app.extensions.changed.get(),
      })
    }

    controller = new InteractionController(canvasEl, renderer, {
      dispatch: (invocation) => {
        const tab = activeTab()
        if (!tab) return { ok: false }
        return dispatchGesture(tab, specializeFreshConnect(invocation))
      },
      wheelNavigationMode: () => props.app.settings.get<WheelNavigationMode>('canvas.scrollBehavior'),
      dispatchOccurrenceMutation: (intention) => {
        const tab = activeTab()
        const reg = tab ? props.app.registryForTab(tab) : undefined
        if (!tab || !reg) return { ok: false }
        return dispatchOccurrenceIntention({
          document: tab.store.doc,
          resolver: documentResolver(tab.store.doc, reg.resolve),
          intention,
          planner: occurrencePlanner(),
          dispatch: (invocation) => dispatchGesture(tab, invocation),
          report: (diagnostics) => reportGestureRefusal(tab.id, diagnostics),
        })
      },
      onOccurrenceMutationRefused: (code, message) => {
        const tab = activeTab()
        if (tab) reportGestureRefusal(tab.id, [diag('warning', 'command', code, message)])
      },
      resolveWidgetDefault: effectiveWidgetDefault,
      onBoundaryExposureRefused: (_code, source, side) => {
        const tab = activeTab()
        reportBoundaryExposureRefusal({
          tabId: tab?.id,
          reportProblems: (tabId, diagnostics) => reportGestureRefusal(tabId, diagnostics),
          source,
          side,
        })
      },
      onSelectionChange: (nodes, links, reroutes, valueSources, selectors, groups) => {
        setSelectedNodeIds(new Set(nodes))
        setSelectionSize(nodes.size)
        setLinkSelectionSize(links.size)
        setRerouteSelectionSize(reroutes.size)
        setValueSourceSelectionSize(valueSources.size)
        setSelectorSelectionSize(selectors.size)
        setGroupSelectionSize(groups.size)
        setSelVersion((v) => v + 1)
        instanceSelection = { nodes: [...nodes], links: [...links], groups: [...groups] }
        if (hostFocused()) {
          props.app.canvasSelection.set(instanceSelection)
          props.app.selectionTick.update((v) => v + 1)
        }
        lastSelection = nodes
        lastRerouteSelection = reroutes
        publishPresence()
      },
      onNodeHover: (nodeId) => {
        hoverNode = nodeId
        publishPresence()
      },
      onDragOffsets: (offsets) => {
        dragOffsets = offsets
        publishPresence()
      },
      onLinkDragPresence: (origin) => {
        linkOrigin = origin
        publishPresence()
      },
      onWidgetActivate: (hit, _screenX, _screenY) => openWidgetEditor(hit),
      onWidgetRowAffordanceActivate: (hit) => {
        const tab = activeTab()
        if (!tab || tab.execution) return
        const item = widgetExposureItem(tab, hit.node, hit.row)
        if (item?.action.kind === 'command') props.app.dispatchTo(tab, item.action.invocation)
      },
      onPreviewSurfaceAffordanceActivate: (node) => {
        const tab = activeTab()
        if (!tab || tab.execution) return
        const item = previewExposureItem(tab, node)
        if (item?.action.kind === 'command') props.app.dispatchTo(tab, item.action.invocation)
      },
      onControllerActivate: (hit, screenX, screenY) => {
        const tab = activeTab()
        if (!tab || tab.execution || hit.row.controllerMode === undefined) return
        if (companionInputs.get(hit.node.id)?.has(hit.row.inputId)) return
        const rect = canvasEl.getBoundingClientRect()
        props.tooltips?.hide()
        setControllerMenu({
          x: screenX - rect.left,
          y: screenY - rect.top + 8,
          tab,
          graphId: hit.row.familyOwner?.graphId ?? currentGraphId(tab),
          nodeId: hit.row.familyOwner?.nodeId ?? hit.node.id,
          inputId: hit.row.familyOwner?.valueKey ?? hit.row.valueKey,
          mode: hit.row.controllerMode,
          trigger: hit.row.spec.controller ?? 'after_generate',
        })
      },
      onBadgeClick: (node, badge, rect) => {
        closePalette()
        setEditor(undefined)
        setMenu(undefined)
        const vp = renderer.getViewport()
        setBadgePopover({
          x: rect.x * vp.scale + vp.x,
          y: (rect.y + rect.height) * vp.scale + vp.y + 6,
          nodeId: node.id,
          badge,
        })
      },
      onValueSourceActivate: (vs) => openValueSourceEditor(vs),
      onValueSourceBadgeClick: (vs, rect) => {
        closePalette()
        setEditor(undefined)
        setMenu(undefined)
        setBadgePopover(undefined)
        const vp = renderer.getViewport()
        setVsPopover({
          x: rect.x * vp.scale + vp.x,
          y: (rect.y + rect.height) * vp.scale + vp.y + 6,
          valueSourceId: vs.id,
        })
      },
      onSelectorBadgeClick: (sel, rect) => {
        const tab = activeTab()
        if (!tab) return
        closePalette()
        setEditor(undefined)
        setBadgePopover(undefined)
        // Frozen views are read-only: the badge answers "which branch did THIS
        // execution take?" from the artifact, never the (uneditable) policy menu.
        if (tab.execution) {
          setMenu(undefined)
          setVsPopover(undefined)
          const vp = renderer.getViewport()
          setSelExecPopover({
            x: rect.x * vp.scale + vp.x,
            y: (rect.y + rect.height) * vp.scale + vp.y + 6,
            selectorId: sel.id,
          })
          return
        }
        // Editable tabs: the policy badge opens the selector's resolved menu
        // (policy items live there) anchored under the badge: details +
        // actions, one surface.
        const worldX = rect.x + rect.width / 2
        const worldY = rect.y + rect.height
        const ctx: MenuContext = {
          doc: tab.store.doc,
          features: { namedNets: props.app.settings.get<boolean>('features.namedNets.enabled') },
          graphId: currentGraphId(tab),
          target: { kind: 'selector', selectorId: sel.id },
          selection: {
            nodes: [...controller.getSelection()],
            links: [...controller.getLinkSelection()],
            reroutes: [...controller.getRerouteSelection()],
            valueSources: [...controller.getValueSourceSelection()],
            selectors: [...controller.getSelectorSelection()],
          },
          worldX,
          worldY,
        }
        const groups = props.app.menuRegistry.resolve(ctx)
        if (groups.length === 0) {
          setMenu(undefined)
          return
        }
        const vp = renderer.getViewport()
        setMenu({
          x: worldX * vp.scale + vp.x, y: worldY * vp.scale + vp.y + 6, worldX, worldY, groups,
          tab, graphId: currentGraphId(tab), pathKey: (viewInstancePath(tab) ?? []).join('/'),
          documentRevision: tab.store.revision, schemaRegistry: registry(),
          workerCatalog: props.app.backendForTab(tab).workerCatalog.get(),
          extensionsGeneration: props.app.extensions.changed.get(),
        })
      },
      onOpenSubgraph: (node) => {
        const tab = activeTab()
        const defId = subgraphDefIdOf(node.node.type)
        if (tab && defId && tab.store.doc.graphs[defId]) {
          pushGraph(tab, defId, node.node.id)
        }
      },
      onToolboxAction: (hit) => {
        const tab = activeTab()
        if (!tab || frozen() || hit.button.disabled === true) return
        const b = hit.button
        if (b.id === 'core.delete') return deleteSelection()
        if (b.id === 'core.extractSubgraph') return void beginExtractSubgraph()
        if (b.id === 'core.flattenSubgraph') return void flattenSelectedSubgraph()
        const graphId = currentGraphId(tab)
        const def = tab.store.doc.graphs[graphId]
        const nodeIds = [...controller.getSelection()].filter((id) => def?.nodes[id])
        if (nodeIds.length === 0) return
        const menuRequest = toolboxMenuRequest(hit, nodeIds)
        if (menuRequest) {
          openCanvasMenu(menuRequest.target, menuRequest.worldX, menuRequest.worldY, [], menuRequest.submenuId)
          return
        }
        if (b.id === 'core.openSubgraph') {
          const defId = subgraphDefIdOf(def!.nodes[nodeIds[0]!]!.type)
          if (defId && tab.store.doc.graphs[defId]) pushGraph(tab, defId, nodeIds[0]!)
          return
        }
        if (b.id === 'core.queueUpToHere') {
          void props.app.queueSelection(tab, nodeIds)
          return
        }
        if (b.id === 'core.queueBetween') {
          void props.app.queueSelectionBetween(tab, nodeIds)
          return
        }
        if (b.id === 'core.queueFromHere') {
          void props.app.queueSelectionOnwards(tab, nodeIds)
          return
        }
        if (b.id === 'core.minimize') toggleSelectedNodes(tab, nodeIds)
      },
      onToolboxHover: (hit) => {
        if (hit?.button.disabled === true) {
          renderer.setScopeHighlight(undefined)
          return
        }
        const tab = activeTab()
        const def = tab?.store.doc.graphs[tab.store.doc.root]
        const selected = def ? [...controller.getSelection()].filter((id) => def.nodes[id]) : []
        const scopes = tab ? props.app.selectionExecutionScopes(tab, selected) : undefined
        const scope = hit?.button.id === 'core.queueUpToHere'
          ? scopes?.upTo
          : hit?.button.id === 'core.queueBetween'
            ? scopes?.between
            : hit?.button.id === 'core.queueFromHere'
              ? scopes?.fromOnwards
              : undefined
        if (!scope) {
          renderer.setScopeHighlight(undefined)
          return
        }
        renderer.setScopeHighlight(selectionScopeHighlight(scope))
      },
      onHoverTarget: (target) => {
        if (!target) { props.tooltips?.hideMatching((candidate) => (candidate as { kind?: string } | null | undefined)?.kind !== 'dom', tooltipOwner); return }
        if (target.kind !== 'badge') {
          let tooltipTarget: unknown = target
          if (target.kind === 'widget' || target.kind === 'controller') {
            const companion = companionDisplays[target.hit.node.id]?.[target.hit.row.valueKey]
            const linked = companionInputs.get(target.hit.node.id)?.has(target.hit.row.inputId) || scene.links.some((link) =>
              link.to.kind === 'port' && link.to.node === target.hit.node.id &&
              link.to.port === target.hit.row.inputId &&
              (target.hit.row.selector === undefined || link.boundary !== true))
            tooltipTarget = {
              ...target,
              ...(target.kind === 'widget' && companion ? { companion } : {}),
              connected: companion !== undefined || linked,
            }
          }
          if (target.kind === 'pin' && target.hit.pin.warn === true) {
            const tab = activeTab()
            const path = tab ? viewInstancePath(tab) : undefined
            const ref = {
              node: asNodeId(target.hit.node.id),
              port: asPortId(target.hit.pin.address.port),
              ...(target.hit.pin.address.members !== undefined ? { members: target.hit.pin.address.members } : {}),
            }
            const diagnostics = scene.diagnostics.filter((diagnostic) => {
              if (!diagnostic.anchor?.port || !samePortRef(diagnostic.anchor.port, ref)) return false
              const occurrence = diagnostic.anchor.occurrence
              return occurrence === undefined || (
                path !== undefined &&
                occurrence.node === target.hit.node.id &&
                occurrence.instancePath.length === path.length &&
                occurrence.instancePath.every((id, index) => id === path[index])
              )
            })
            if (diagnostics.length > 0) tooltipTarget = { ...target, diagnostics }
          }
          const tooltipTab = activeTab()
          const tooltipRegistry = registry()
          const tooltipResolve = tooltipTab && tooltipRegistry
            ? documentResolver(tooltipTab.store.doc, tooltipRegistry.resolve)
            : undefined
          const immediateHeader = nodeHeaderTooltipImmediate(
            target,
            tooltipResolve ? { resolveSchema: tooltipResolve } : {},
          )
          props.tooltips?.show(
            tooltipTarget,
            { x: target.x + 12, y: target.y + 14 },
            activeLens().detailedPinTooltips === true && target.kind === 'pin',
            immediateHeader,
            tooltipOwner,
          )
          return
        }
        const nodeId = target.hit.node.id
        const badgeId = target.hit.badge.id
        let tooltip: { summary: string; detail: readonly string[] } | undefined
        if (badgeId === 'core.error') {
          const errors = nodeErrors(nodeId)
          tooltip = {
            summary: `${errors.length} execution error${errors.length === 1 ? '' : 's'}`,
            detail: errors.map((d) => `${d.runtime ? `${d.runtime.exceptionType}: ` : `${d.code}: `}${d.message}`),
          }
        } else if (badgeId === 'core.subgraph') {
          const info = subgraphInfoFor(nodeId)
          if (info) tooltip = { summary: `Subgraph: ${info.name}`, detail: [`definition ${info.defId}`, `${info.nodeCount} nodes (shared)`] }
        } else if (badgeId === 'core.deprecated') {
          const info = replacementInfoFor(nodeId)
          if (info) tooltip = {
            summary: info.deprecation?.message ?? `Deprecated: ${info.type}`,
            detail: [
              ...(info.deprecation?.since ? [`since ${info.deprecation.since}`] : []),
              ...(info.item?.terminalType ? [`Replace with '${info.item.terminalType}'`] : info.pointer ? [`Successor: '${info.pointer.terminal}'`] : []),
            ],
          }
        } else if (badgeId.startsWith('core.problem.')) {
          const kind = badgeId.slice('core.problem.'.length) as NodeProblemKind
          const details = problemMessages(nodeId, kind)
          tooltip = {
            summary: kind === 'error'
              ? `${details.length} document error${details.length === 1 ? '' : 's'}`
              : kind === 'blocking-warning'
                ? `${details.length} execution-blocking warning${details.length === 1 ? '' : 's'}`
                : `${details.length} document warning${details.length === 1 ? '' : 's'}`,
            detail: details,
          }
        }
        props.tooltips?.show(
          { ...target, ...(tooltip ? { tooltip } : {}) },
          { x: target.x + 12, y: target.y + 14 },
          undefined,
          false,
          tooltipOwner,
        )
      },
      onBoundaryRenameRequest: (side, itemId, screenX, screenY) => {
        const tab = activeTab()
        if (!tab || frozen()) return
        const item = tab.store.doc.graphs[currentGraphId(tab)]?.boundary?.[side]?.find((i) => i.id === itemId)
        if (!item) return
        closePalette()
        setEditor(undefined)
        setMenu(undefined)
        const rect = canvasEl.getBoundingClientRect()
        setBoundaryPrompt({
          x: screenX - rect.left,
          y: screenY - rect.top,
          side,
          itemId,
          initial: item.displayName ?? '',
        })
      },
      onOpenPalette: (worldX, worldY) => {
        if (frozen()) return // read-only view: no node adds
        openPaletteAt(worldX, worldY)
      },
      onLinkDoubleClick: (context, screenX, screenY) => {
        if (frozen()) return
        closePalette()
        setMenu(undefined)
        linkMenuOpenedAt = performance.now()
        setLinkDoubleClickMenu({ x: screenX, y: screenY, context })
      },
      onLinkDropOnEmpty: (context, worldX, worldY) => {
        if (frozen()) return // read-only view: no node adds
        openPaletteAt(worldX, worldY, context)
        // Keep the dropped noodle visible while the palette is browsed:
        // fixed anchor to drop point, oriented by what the drag was seeking.
        controller.setPaletteGhost(linkDropPaletteGhost(context, worldX, worldY))
      },
      onContextMenu: (hit, worldX, worldY) => {
        const tab = activeTab()
        if (!tab) return
        const additionalGroups: ResolvedMenuGroup[] = []
        if (hit.kind === 'pin' && hit.direction === 'in' && hit.pin.dynamicSlot !== undefined) {
          const slot = hit.pin.dynamicSlot
          const specialize = (variant: string | null): CommandInvocation => ({
            command: 'dynamic.specializeSlot',
            params: {
              graphId: slot.owner?.graphId ?? currentGraphId(tab),
              nodeId: slot.owner?.nodeId ?? hit.node.id,
              construct: slot.owner?.construct ?? slot.construct,
              variant,
              ...((slot.owner?.ancestors ?? slot.ancestors).length > 0 ? { ancestors: slot.owner?.ancestors ?? slot.ancestors } : {}),
            },
          })
          additionalGroups.push({
            group: '45-dynamic-slot',
            items: [
              ...slot.variants.map((variant) => ({
                id: `core.slot.specialize.${variant.key}`,
                label: `Specialize slot: ${variant.key}`,
                checked: slot.selected === variant.key,
                action: { kind: 'command' as const, invocation: specialize(variant.key) },
              })),
              {
                id: 'core.slot.specialize.clear',
                label: 'Clear specialization',
                disabled: slot.selected === undefined,
                action: { kind: 'command' as const, invocation: specialize(null) },
              },
            ],
          })
        }
        if (hit.kind === 'widget') {
          const address = widgetRepresentationAddress(hit, currentGraphId(tab))
          const representationGroup = widgetRepresentationMenuGroup({
            ...address,
            spec: hit.row.spec,
            ...(hit.row.representationId === undefined ? {} : { selected: hit.row.representationId }),
            disabled: tab.execution !== undefined || hit.row.ghost === true || hit.row.materialize !== undefined,
          })
          if (representationGroup !== undefined) additionalGroups.push(representationGroup)
          const imageTarget = props.app.imageTargetForInput(tab, address.graphId, address.nodeId, address.inputId)
          if (imageTarget) additionalGroups.push({
            group: '46-image-editor',
            items: [{
              id: 'core.image.edit',
              label: 'Edit image',
              action: { kind: 'host', action: 'openImageEditor', params: { graphId: address.graphId, nodeId: address.nodeId, inputId: address.inputId } },
            }],
          })
        }
        openCanvasMenu(menuTargetOf(hit), worldX, worldY, additionalGroups)
      },
    })
    if (globalThis.localStorage?.getItem('dinkster.pointerTrace') === '1')
      controller.enablePointerTrace()
    const pointerTraceConsole = {
      enable: () => controller.enablePointerTrace(),
      disable: () => controller.disablePointerTrace(),
      dump: () => controller.dumpPointerTrace(),
      clear: () => controller.clearPointerTrace(),
    }
    const traceWindow = window as Window & {
      __dinksterPointerTrace?: typeof pointerTraceConsole
    }
    traceWindow.__dinksterPointerTrace = pointerTraceConsole

    // Minimap: painting, transform state, and pointer/wheel wiring live in
    // setupMinimap (framework-free). The host supplies the one reactive
    // piece it cannot know: bookmark markers - slot digits at each saved
    // camera's world center, filtered to bookmarks whose full navigation
    // context (definition stack + instance path) IS the current view; a
    // bookmark inside a different occurrence of this def stays hidden
    // rather than lying.
    const minimapMarkers = (): MinimapMarker[] => {
      const markers: MinimapMarker[] = []
      const tab = activeTab()
      // untrack: paint runs inside effects that must not subscribe to the
      // presentation toggle (the toggle repaints explicitly).
      if (tab && untrack(() => props.app.settings.get<boolean>('canvas.minimap.bookmarks'))) {
        const stackNow = tab.graphStack.get()
        const pathNow = viewInstancePath(tab)
        for (const [slot, bm] of Object.entries(tab.store.doc.view.bookmarks ?? {})) {
          if (bm.graphStack.length !== stackNow.length || bm.graphStack.some((g, i) => g !== stackNow[i])) continue
          if (pathNow === undefined || bm.instancePath.some((n, i) => n !== pathNow[i])) continue
          const point = bookmarkMarkerWorldPoint(bm, { width: canvasEl.clientWidth, height: canvasEl.clientHeight })
          markers.push({
            ...point,
            label: slot === '10' ? '0' : slot,
          })
        }
      }
      return markers
    }
    const minimap = setupMinimap({
      canvas: minimapEl,
      mainCanvas: canvasEl,
      renderer,
      settings: props.app.settings,
      markers: minimapMarkers,
    })
    repaintMinimap = minimap.paint
    setEditorViewport({ ...renderer.getViewport() })
    setCanvasClientRect(canvasEl.getBoundingClientRect())
    const unsubscribeEditorViewport = renderer.onViewportChange(() => setEditorViewport({ ...renderer.getViewport() }))
    // Camera moves change the broadcast world-rect; the channel's throttle
    // coalesces the pan/zoom stream, so this can ride every change.
    const unsubscribePresenceViewport = renderer.onViewportChange(publishPresence)
    // Scene rebuilds and camera moves invalidate canvas-anchored tooltips
    // only; DOM chrome tooltips share the controller and must survive both
    // (a background docTick must never eat a pending toolbar tooltip).
    const hideCanvasTooltips = () =>
      props.tooltips?.hideMatching(
        (target) => (target as { kind?: string } | null | undefined)?.kind !== 'dom',
        tooltipOwner,
      )
    const unsubscribeTooltipViewport = renderer.onViewportChange(hideCanvasTooltips)
    const camera = createCameraAnimator({
      getViewport: () => renderer.getViewport(),
      setViewport: (vp) => renderer.setViewport(vp),
      onViewportChange: (cb) => renderer.onViewportChange(cb),
      viewSize: () => ({ width: canvasEl.clientWidth, height: canvasEl.clientHeight }),
    })
    focusCanvas = () => canvasEl.focus()
    focusSemanticPin = (item): void => controller.setFocusedPin(
      item?.target.kind === 'port'
        ? {
          nodeId: item.target.nodeId,
          portId: item.target.id,
          direction: item.target.direction,
          ...(item.target.widgetTap === true ? { widgetTap: true as const } : {}),
        }
        : undefined,
    )
    semanticTargetSelected = (target): boolean => {
      if (target.kind === 'node' || target.kind === 'boundary') return controller.getSelection().has(target.id)
      if (target.kind === 'port') return controller.getSelection().has(target.nodeId)
      if (target.kind === 'link') return controller.getLinkSelection().has(target.id)
      if (target.kind === 'reroute') return controller.getRerouteSelection().has(target.id)
      if (target.kind === 'valueSource') return controller.getValueSourceSelection().has(target.id)
      if (target.kind === 'selector') return controller.getSelectorSelection().has(target.id)
      if (target.kind === 'net') return controller.getNetViewSelection().has(target.id)
      return controller.getGroupSelection().has(target.id)
    }
    activateSemanticItem = (item): void => {
      const source = renderer.getScene()
      const target = item.target
      let rect: EditorWorldRect | undefined
      if (target.kind === 'node' || target.kind === 'port') {
        const nodeId = target.kind === 'node' ? target.id : target.nodeId
        const node = source.nodes.find((candidate) => candidate.id === nodeId)
        const boundary = source.boundaryNodes.find((candidate) => boundarySceneId(candidate.side) === nodeId)
        const citizen = node ?? boundary
        if (citizen === undefined) return
        controller.setSelection([nodeId])
        rect = { x: citizen.x, y: citizen.y, width: citizen.layout.width, height: citizen.layout.height }
      } else if (target.kind === 'boundary') {
        const boundary = source.boundaryNodes.find((candidate) => boundarySceneId(candidate.side) === target.id)
        if (boundary === undefined) return
        controller.setSelection([target.id])
        rect = { x: boundary.x, y: boundary.y, width: boundary.layout.width, height: boundary.layout.height }
      } else if (target.kind === 'link') {
        const link = source.links.find((candidate) => candidate.id === target.id)
        if (link === undefined) return
        controller.setSelection([], [target.id])
        rect = {
          x: Math.min(link.x1, link.x2),
          y: Math.min(link.y1, link.y2),
          width: Math.max(1, Math.abs(link.x2 - link.x1)),
          height: Math.max(1, Math.abs(link.y2 - link.y1)),
        }
      } else if (target.kind === 'reroute') {
        const reroute = source.reroutes.find((candidate) => candidate.id === target.id)
        if (reroute === undefined) return
        controller.setSelection([], [], [target.id])
        rect = { x: reroute.x - 1, y: reroute.y - 1, width: 2, height: 2 }
      } else if (target.kind === 'valueSource') {
        const valueSource = source.valueSources.find((candidate) => candidate.id === target.id)
        if (valueSource === undefined) return
        controller.setSelection([], [], [], [target.id])
        rect = { x: valueSource.x, y: valueSource.y, width: valueSource.width, height: valueSource.height }
      } else if (target.kind === 'selector') {
        const selector = source.selectors.find((candidate) => candidate.id === target.id)
        if (selector === undefined) return
        controller.setSelection([], [], [], [], [target.id])
        rect = { x: selector.x, y: selector.y, width: selector.width, height: selector.height }
      } else if (target.kind === 'group') {
        const group = source.groups.find((candidate) => candidate.id === target.id)
        if (group === undefined) return
        controller.setSelection([], [], [], [], [], [target.id])
        rect = { x: group.x, y: group.y, width: group.width, height: group.height }
      } else {
        const stub = source.netStubs.find((candidate) => candidate.id === target.id)
        if (stub === undefined) return
        controller.setSelection([], [], [], [], [], [], [target.id])
        rect = { x: stub.x, y: stub.y, width: stub.width, height: stub.height }
      }
      camera.animateTo(viewportCenteredOnNode(
        renderer.getViewport(),
        rect,
        { width: canvasEl.clientWidth, height: canvasEl.clientHeight },
      ))
    }
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            setCanvasClientRect(canvasEl.getBoundingClientRect())
            // Synchronous: the callback runs before this frame paints, so a
            // same-frame backing-store resize + redraw never flashes the
            // stretched stale bitmap (rail/panel toggles resize the canvas).
            renderer.renderNow()
            minimap.paint()
            publishPresence() // CSS size feeds the broadcast view rect
          })
        : undefined
    resizeObserver?.observe(canvasEl)

    function openPaletteAt(worldX: number, worldY: number, linkDrop?: LinkDropContext): void {
      const vp = renderer.getViewport()
      // A fresh anchor object every open: NodePalette resets its per-open
      // state (query, highlight, filters) on anchor identity change.
      setPalette({
        x: worldX * vp.scale + vp.x,
        y: worldY * vp.scale + vp.y,
        worldX,
        worldY,
        ...(linkDrop !== undefined ? { linkDrop } : {}),
      })
    }
    openSplicePalette = (context): void => {
      const vp = renderer.getViewport()
      const inputType = canonicalTypeIdOf(context.fromType)
      const outputType = canonicalTypeIdOf(context.toType)
      setPalette({
        x: context.position.x * vp.scale + vp.x,
        y: context.position.y * vp.scale + vp.y,
        worldX: context.position.x,
        worldY: context.position.y,
        splice: context,
        ...(inputType !== undefined ? { initialInputTypes: [inputType] } : {}),
        ...(outputType !== undefined ? { initialOutputTypes: [outputType] } : {}),
      })
    }

    /** Delete the current selection; net noodles delete as SINK removals. */
    function deleteSelection(): void {
      const tab = activeTab()
      if (!tab) return
      const selectedItems = [...controller.getSelection()]
      const boundaryIds = new Set(scene.boundaryNodes.map((node) => boundarySceneId(node.side)))
      const nodeIds = selectedItems.filter((id) => !boundaryIds.has(id))
      const preservedBoundarySelection = selectedItems.filter((id) => boundaryIds.has(id))
      const selectedLinks = [...controller.getLinkSelection()]
      const rerouteIds = [...controller.getRerouteSelection()]
      const valueSourceIds = [...controller.getValueSourceSelection()]
      const selectorIds = [...controller.getSelectorSelection()]
      const groupIds = [...controller.getGroupSelection()]
      const selectedNetViews = [...controller.getNetViewSelection()]
        .flatMap((id) => scene.netStubs.find((stub) => stub.id === id) ?? [])
      if (
        nodeIds.length === 0 &&
        selectedLinks.length === 0 &&
        rerouteIds.length === 0 &&
        valueSourceIds.length === 0 &&
        selectorIds.length === 0 &&
        groupIds.length === 0 &&
        selectedNetViews.length === 0
      )
        return
      const effectiveLinks = selectedLinks.map((id) => {
        const link = scene.links.find((candidate) => candidate.id === id)
        return link?.effectiveIdentities ?? (link?.effectiveIdentity === undefined ? undefined : [link.effectiveIdentity])
      })
      if (effectiveLinks.some((identities) => identities !== undefined)) {
        const decision = occurrenceDeleteDecision({
          effectiveLinks,
          boundaryCount: preservedBoundarySelection.length,
          nodeCount: nodeIds.length,
          rerouteCount: rerouteIds.length,
          valueSourceCount: valueSourceIds.length,
          selectorCount: selectorIds.length,
          groupCount: groupIds.length,
          netViewCount: selectedNetViews.length,
          drilled: scene.occurrence !== undefined,
        })
        if (decision.kind === 'mixed' || scene.occurrence === undefined) {
          reportGestureRefusal(tab.id, [diag(
            'warning', 'command', 'occurrence.link.mixedSelectionUnsupported',
            'Delete effective occurrence links separately from definition items.',
          )])
          return
        }
        if (decision.kind === 'multi') {
          reportGestureRefusal(tab.id, [diag(
            'warning', 'command', 'occurrence.link.multiSelectionUnsupported',
            'Delete one effective occurrence delivery at a time.',
          )])
          return
        }
        const outcome = dispatchOccurrenceIntention({
          document: tab.store.doc,
          resolver: documentResolver(tab.store.doc, props.app.registryForTab(tab)!.resolve),
          intention: {
            kind: 'disconnect', owner: scene.occurrence.owner,
            bodyGraph: scene.occurrence.bodyGraph, link: decision.identity,
          },
          planner: occurrencePlanner(),
          dispatch: (invocation) => dispatchGesture(tab, invocation),
          report: (diagnostics) => reportGestureRefusal(tab.id, diagnostics),
        })
        if (outcome.ok) controller.setSelection(preservedBoundarySelection)
        return
      }
      const invocation = selectionDeleteInvocation({
        graphId: currentGraphId(tab), def: tab.store.doc.graphs[currentGraphId(tab)]!,
        scene, nodeIds, selectedLinks,
        rerouteIds, valueSourceIds, selectorIds, groupIds, selectedNetViews,
      })
      if (invocation === undefined) return
      props.app.dispatchTo(tab, invocation)
      controller.setSelection(preservedBoundarySelection)
    }

    function toggleSelectedNodes(tab: Tab, selectedIds: readonly string[]): void {
      const graphId = currentGraphId(tab)
      const def = tab.store.doc.graphs[graphId]
      const nodeIds = selectedIds.filter((id) => def?.nodes[id] !== undefined)
      if (nodeIds.length === 0) return
      const view = tab.store.doc.view.graphs[graphId]?.nodes
      props.app.dispatchTo(tab, {
        command: 'view.setNodeCollapsed',
        params: {
          graphId,
          nodeIds,
          collapsed: toggledSelectionCollapsed(nodeIds.map((id) => view?.[id]?.collapsed === true)),
        },
      })
    }

    // Shell-implemented menu actions (see the MenuRegistry contract for the
    // well-known names). Extensions add document behavior via commands; host
    // actions cover navigation/UI concerns only.
    const hostActions: Record<string, (params: Json | undefined, m: OwnedMenuAnchor) => void> = {
      openSubgraph: (params) => {
        const tab = activeTab()
        const nodeId =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as JsonObject)['nodeId']
            : undefined
        if (!tab || typeof nodeId !== 'string') return
        const node = tab.store.doc.graphs[currentGraphId(tab)]?.nodes[nodeId]
        const defId = node ? subgraphDefIdOf(node.type) : undefined
        if (defId && tab.store.doc.graphs[defId]) {
          pushGraph(tab, defId, nodeId)
        }
      },
      openNodeHelp: (params, m) => {
        const nodeId = params && typeof params === 'object' && !Array.isArray(params)
          ? (params as JsonObject)['nodeId']
          : undefined
        if (typeof nodeId !== 'string') return
        const node = m.tab.store.doc.graphs[m.graphId]?.nodes[nodeId]
        if (node) props.app.openNodeHelp(m.tab, node.type)
      },
      createSubgraph: (_params, m) => {
        if (frozen()) return
        props.app.createEmptySubgraph(m.tab, m.graphId, {
          x: Math.round(m.worldX),
          y: Math.round(m.worldY),
        })
      },
      createRegion: (params, m) => {
        if (frozen() || !params || typeof params !== 'object' || Array.isArray(params)) return
        const kind = (params as JsonObject)['kind']
        if (kind !== 'map' && kind !== 'fold' && kind !== 'while') return
        createRegionAt(m.tab, m.graphId, { x: Math.round(m.worldX), y: Math.round(m.worldY) }, kind)
      },
      extractSubgraph: () => { beginExtractSubgraph() },
      flattenSubgraph: () => { flattenSelectedSubgraph() },
      runOnMachine: (params, m) => {
        if (!params || typeof params !== 'object' || Array.isArray(params)) return
        const worker = (params as JsonObject)['worker']
        const nodeIds = (params as JsonObject)['nodeIds']
        if (typeof worker !== 'string' || !Array.isArray(nodeIds) || !nodeIds.every((id) => typeof id === 'string')) return
        void props.app.queueOnWorker(m.tab, nodeIds, worker)
      },
      openPalette: (_params, m) => openPaletteAt(m.worldX, m.worldY),
      deleteSelection: () => deleteSelection(),
      queueSelection: (params) => {
        const tab = activeTab()
        const nodeIds =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as JsonObject)['nodeIds']
            : undefined
        if (!tab || !Array.isArray(nodeIds)) return
        void props.app.queueSelection(tab, nodeIds.filter((id): id is string => typeof id === 'string'))
      },
      promoteToNet: (params, m) => {
        if (frozen() || !props.app.settings.get<boolean>('features.namedNets.enabled')) return
        const source =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as JsonObject)['source']
            : undefined
        if (!source || typeof source !== 'object' || Array.isArray(source)) return
        const node = (source as JsonObject)['node']
        const port = (source as JsonObject)['port']
        const members = (source as JsonObject)['members']
        if (typeof node !== 'string' || typeof port !== 'string') return
        const memberPath =
          Array.isArray(members) && members.every((x): x is string => typeof x === 'string')
            ? members
            : undefined
        setNetPrompt({
          x: m.x,
          y: m.y,
          mode: 'create',
          source: { node, port, ...(memberPath !== undefined ? { members: memberPath } : {}) },
          initial: '',
        })
      },
      renameNet: (params, m) => {
        if (frozen() || !props.app.settings.get<boolean>('features.namedNets.enabled')) return
        const tab = activeTab()
        const netId =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as JsonObject)['netId']
            : undefined
        if (!tab || typeof netId !== 'string') return
        const net = tab.store.doc.graphs[currentGraphId(tab)]?.nets[netId]
        if (!net) return
        setNetPrompt({ x: m.x, y: m.y, mode: 'rename', netId, initial: net.name })
      },
      groupSelection: () => {
        // Create a group around the selected nodes' bounding box. Needs the
        // scene (layout sizes), so it lives here rather than in a command.
        if (frozen()) return
        const tab = activeTab()
        if (!tab) return
        const selected = scene.nodes.filter((n) => controller.getSelection().has(n.id))
        if (selected.length === 0) return
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of selected) {
          minX = Math.min(minX, n.x)
          minY = Math.min(minY, n.y)
          maxX = Math.max(maxX, n.x + n.layout.width)
          maxY = Math.max(maxY, n.y + n.layout.height)
        }
        const pad = 20
        const headroom = 30 // title band clearance above the topmost node
        props.app.dispatchTo(tab, {
          command: 'view.createGroup',
          params: {
            graphId: currentGraphId(tab),
            title: 'Group',
            bounds: {
              x: Math.round(minX - pad),
              y: Math.round(minY - pad - headroom),
              width: Math.round(maxX - minX + pad * 2),
              height: Math.round(maxY - minY + pad * 2 + headroom),
            },
          },
        })
      },
      renameGroup: (params, m) => {
        if (frozen()) return
        const tab = activeTab()
        const groupId =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as JsonObject)['groupId']
            : undefined
        if (!tab || typeof groupId !== 'string') return
        const group = tab.store.doc.view.graphs[currentGraphId(tab)]?.groups?.[groupId]
        if (!group) return
        setGroupPrompt({ x: m.x, y: m.y, groupId, initial: group.title })
      },
      renameNode: (params, m) => {
        if (frozen()) return
        const nodeId =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as JsonObject)['nodeId']
            : undefined
        if (typeof nodeId !== 'string') return
        const node = m.tab.store.doc.graphs[m.graphId]?.nodes[nodeId]
        if (!node) return
        const renameRegistry = props.app.registryForTab(m.tab)
        const renameResolve = renameRegistry ? documentResolver(m.tab.store.doc, renameRegistry.resolve) : undefined
        const originalTitle = renameResolve?.(node.type)?.displayName ?? node.type
        setNodePrompt({
          x: m.x, y: m.y, nodeId, initial: node.title ?? originalTitle, originalTitle,
          tab: m.tab, graphId: m.graphId,
        })
      },
      renameSelector: (params, m) => {
        if (frozen()) return
        const tab = activeTab()
        const selectorId =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as JsonObject)['selectorId']
            : undefined
        if (!tab || typeof selectorId !== 'string') return
        const sel = tab.store.doc.graphs[currentGraphId(tab)]?.selectors?.[selectorId]
        if (!sel) return
        setSelectorPrompt({ x: m.x, y: m.y, selectorId, initial: sel.title ?? 'Select' })
      },
      openImageEditor: (params, m) => {
        if (!params || typeof params !== 'object' || Array.isArray(params)) return
        const nodeId = (params as JsonObject)['nodeId']
        const inputId = (params as JsonObject)['inputId']
        const graphId = (params as JsonObject)['graphId']
        if (typeof nodeId !== 'string' || typeof inputId !== 'string') return
        const target = props.app.imageTargetForInput(m.tab, typeof graphId === 'string' ? graphId : m.graphId, nodeId, inputId)
        if (target) props.app.openImageEditor(target)
      },
      copySelection: () => { void copySelection() },
      pasteSelection: (_params, m) => { void pasteFromClipboard({ x: m.worldX, y: m.worldY }) },
    }

    menuInvoke = (item: MenuActionItem): void => {
      const m = menu()
      setMenu(undefined)
      if (!m || item.disabled) return
      if (activeTab() !== m.tab || currentGraphId(m.tab) !== m.graphId) return
      if (item.action.kind === 'command') {
        props.app.dispatchTo(m.tab, item.action.invocation)
      } else {
        hostActions[item.action.action]?.(item.action.params, m)
      }
    }

    /**
     * The invocations that finish a link-drop insertion: connect the
     * dangling end to the new node's first compatible ELABORATED port
     * (dynamic surfaces included - an autogrow member target carries its
     * own dynamic.materialize, batched like the fixed end's per hazard
     * N3). Empty when nothing auto-connectable: descriptor hints are
     * unverified - the pick still inserts, it just lands unconnected.
     */
    /**
     * Blueprint insertion: fetch the body (digest-cached), materialize
     * fresh definitions against the CURRENT document, then commit import +
     * instance as ONE batch (one undo step, atomic reject). COPY semantics:
     * the inserted subgraph has no link back to the blueprint. A link-drop
     * pick appends the connect to the SAME batch, resolved against the
     * boundary-derived schema (real interface, never descriptor hints;
     * boundary item ids survive the re-key).
     *
     * The exact invoking Tab and the gesture's graph are captured before the
     * fetch; every probe after
     * it is scoped to that owner (registryForTab, dispatchTo), never to
     * whatever tab or graph is active when the body arrives. Selection is
     * scene-level, so it only fires when the owner is still the active tab.
     */
    const insertBlueprint = async (
      tab: NonNullable<ReturnType<typeof activeTab>>,
      bp: { readonly packId: string; readonly descriptor: PackBlueprintDescriptor },
      p: { worldX: number; worldY: number; linkDrop?: LinkDropContext },
      graphId = currentGraphId(tab),
    ): Promise<void> => {
      const backend = props.app.backendForTab(tab)
      const ownerRegistry = props.app.registryForTab(tab)
      const frozenState = tab.execution
      const baseUrl = backend.baseUrl
      // Graph INCARNATION latch: graph ids are reusable (an undo of an
      // import frees 'g<n>' for the next import to re-key onto), so the id
      // string matching again after the fetch does not prove the gesture's
      // graph survived. Watch the owner document while the fetch is in
      // flight: once the captured graph is absent, the incarnation is dead
      // for good - a later same-id recreation must not inherit the gesture.
      let graphRetired = false
      const unsubscribe = tab.store.document.subscribe((document) => {
        if (document.graphs[graphId] === undefined) graphRetired = true
      })
      try {
        const outcome = await insertBlueprintIntoTab({
          loadBody: () => blueprintBodies.load(baseUrl, bp.packId, bp.descriptor.id, bp.descriptor.digest),
          graphId,
          position: { x: Math.round(p.worldX), y: Math.round(p.worldY) },
          tabStillOpen: () => props.app.tabs.get().includes(tab),
          currentGraphId: () => currentGraphId(tab),
          graphStillOwned: () => !graphRetired,
          ownerStillCurrent: () =>
            props.app.backendForTab(tab) === backend &&
            props.app.registryForTab(tab) === ownerRegistry &&
            tab.execution === frozenState,
          doc: () => tab.store.doc,
          predictedNodeId: () => tab.store.predictedNodeId(graphId),
          resolveType: () => ownerRegistry?.resolve,
          connect: (nodeId, schema) =>
            p.linkDrop !== undefined ? linkDropInvocations(p.linkDrop, graphId, nodeId, schema) : [],
          dispatch: (invocation) => props.app.dispatchTo(tab, invocation).ok,
          onInserted: (nodeId) => {
            if (activeTab() === tab) controller.setSelection([nodeId])
          },
        })
        // A live gesture that failed on payload is surfaced; stale-* refusals
        // (tab closed / navigated away during the fetch) stay silent.
        const failure = blueprintFailureDiagnostic(outcome, bp.descriptor.name, bp.packId)
        if (failure) props.app.reportProblems(tab.id, [failure])
      } finally {
        unsubscribe()
      }
    }

    clearPaletteGhost = () => controller.setPaletteGhost(undefined)

    const commitPaletteEntry = (
      entry: PaletteEntry,
      p: PaletteAnchor,
      owner?: { readonly tab: Tab; readonly graphId: string },
    ): void => {
      const tab = owner?.tab ?? activeTab()
      if (!tab) return
      const graphId = owner?.graphId ?? currentGraphId(tab)
      if (entry.type === '__dinkster.reroute') {
        if (p.splice) {
          props.app.dispatchTo(tab, { command: 'reroute.insert', params: { graphId, linkId: p.splice.linkId, position: p.splice.position } })
        } else if (p.linkDrop) {
          const expectedId = tab.store.predictedRerouteId(graphId)
          if (!expectedId) return
          const invocations = rerouteDropInvocations(graphId, expectedId, { x: Math.round(p.worldX), y: Math.round(p.worldY) }, p.linkDrop)
          if (invocations.length > 0) props.app.dispatchTo(tab, { command: 'batch', params: { invocations } as unknown as Json })
        } else {
          props.app.dispatchTo(tab, { command: 'reroute.add', params: { graphId, position: { x: Math.round(p.worldX), y: Math.round(p.worldY) } } })
        }
        return
      }
      if (entry?.blueprint !== undefined) {
        void insertBlueprint(tab, entry.blueprint, p, graphId)
        return
      }
      const reg = registry()
      // Predict through the session so solo and actor-scoped allocation use
      // the same cursor and formatting rules as node.add.
      const expectedId = tab.store.predictedNodeId(graphId)
      if (expectedId === undefined) return
      const resolve = reg ? documentResolver(tab.store.doc, reg.resolve) : () => undefined
      const schema: NodeSchema | undefined = entry.schema ?? resolve(entry.type)
      const virtualKind = props.app.virtualNodeKinds.get(entry.type)
      // Registry state can change after the palette opens. Preserve the old
      // unresolved-node fallback rather than turning that narrow race into a
      // silent no-op; only known schemas can contribute defaults or state.
      const values = virtualKind?.defaultValues ?? (schema ? (defaultValuesOf(schema) as Record<string, Json>) : {})
      const dynamic = schema ? initialDynamicStateOf(schema) : {}
      const addInvocation = {
        command: 'node.add',
        params: {
          graphId,
          type: entry.type,
          ...(virtualKind !== undefined ? { virtual: true } : {}),
          position: { x: Math.round(p.worldX), y: Math.round(p.worldY) },
          values,
          ...(Object.keys(dynamic).length > 0 ? { dynamic } : {}),
        },
      }
      // Link-drop pick: insert + connect as ONE batch (one undo step; a
      // rejected connect rolls back the insert, never leaving half).
      const connect = p.splice !== undefined && schema !== undefined
        ? linkSpliceInvocations(graphId, expectedId, schema, p.splice)
        : p.linkDrop !== undefined ? linkDropInvocations(p.linkDrop, graphId, expectedId, schema) : []
      const outcome = props.app.dispatchTo(
        tab,
        connect.length === 0
          ? addInvocation
          : { command: 'batch', params: { invocations: [addInvocation, ...connect] } as unknown as Json },
      )
      if (outcome.ok) controller.setSelection([expectedId])
    }

    paletteCommit = (entry: PaletteEntry, placement?: PaletteAnchor): void => {
      const p = placement ?? palette()
      if (!p) {
        closePalette()
        return
      }
      const type = entry.type
      setRecentNodeTypes((items) => [type, ...items.filter((item) => item !== type)].slice(0, 10))
      closePalette()
      if (type.startsWith('__dinkster.region.')) {
        const kind = type.slice('__dinkster.region.'.length)
        const tab = activeTab()
        if (tab && !frozen() && (kind === 'map' || kind === 'fold' || kind === 'while')) {
          createRegionAt(tab, currentGraphId(tab), {
            x: Math.round(p.worldX), y: Math.round(p.worldY),
          }, kind)
        }
        return
      }
      // Dropped noodles and link splices own an exact release point and must
      // remain one immediate atomic insertion. Ordinary picks instead enter
      // the same pointer-attached lifecycle as Search Dinkster.
      if (!palettePickCommitsImmediately(type, p)) {
        armPaletteEntry(entry)
        return
      }
      commitPaletteEntry(entry, p)
    }

    // Test bridge: perf/interaction specs drive the focused pane directly.
    if (window.__dinksterTest) bindFocusedCanvasTestBridge(
      window.__dinksterTest,
      { renderer, controller, setOccurrencePlanner },
      hostFocused,
    )

    const measureCtx = document.createElement('canvas').getContext('2d')!
    const measure: TextMeasurer = (text, role) => {
      measureCtx.font =
        role === 'title' || role === 'renamedTitle'
          ? `${role === 'renamedTitle' ? 'italic ' : ''}600 ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`
          : `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`
      return measureCtx.measureText(text).width
    }
    const widgetMeasure: WidgetMeasure = (spec) => {
      const kind = widgetRegistry().kind(spec.widgetType)
      if (!kind) return undefined
      const viewId = kind.defaultView(spec)
      const view = widgetRegistry().viewsFor(spec.widgetType).find((v) => v.id === viewId)
      if (!view) return undefined
      return { viewId, rows: view.measure(spec).rows }
    }
    const placementGeometryForEntry = (entry: PaletteEntry): PlacementGeometry => {
      if (entry.schema === undefined) {
        return { width: 180, height: 88, headerHeight: defaultTokens.headerHeight }
      }
      const { layout } = palettePreviewLayout(entry.schema, defaultTokens, measure, widgetMeasure)
      return { width: layout.width, height: layout.height, headerHeight: layout.headerHeight }
    }

    let scene: Scene = { graphId: '', nodes: [], links: [], reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [] }
    let sceneKey = ''
    let sceneBuildContext: {
      readonly document: WorkflowDocument
      readonly graphNodes: ReadonlyMap<string, NonNullable<WorkflowDocument['graphs'][string]>['nodes'][string]>
      readonly key: string
      readonly pathKey: string
      readonly registry: ReturnType<AppState['registryForTab']>
      readonly extensionsGeneration: number
      readonly seedControllerEnabled: boolean
      readonly plannerAvailable: boolean
    } | undefined
    let sceneViewportOwner: { readonly tabId: string; readonly graphId: string } | undefined
    const unsubscribeTabViewport = renderer.onViewportChange((viewport) => {
      if (sceneViewportOwner) props.app.setGraphViewport(sceneViewportOwner.tabId, sceneViewportOwner.graphId, viewport)
    })

    // Scene: rebuilt when the tab, graph stack, document, or schemas change.
    createEffect(() => {
      docTick() // track document + graph-stack changes
      const focusRequest = diagnosticFocus()
      const reg = registry()
      const tab = activeTab()
      if (!tab) return
      const doc = tab.store.doc
      const focusPlan = focusRequest?.tab === tab
        ? diagnosticFocusPlan(doc, focusRequest.anchor, focusRequest.portInstancePath)
        : undefined
      if (focusRequest?.tab === tab && !focusPlan) props.app.diagnosticFocus.set(undefined)
      if (focusPlan && (
        tab.graphStack.get().length !== focusPlan.graphStack.length ||
        tab.graphStack.get().some((id, index) => id !== focusPlan.graphStack[index]) ||
        tab.instancePath.get().length !== focusPlan.instancePath.length ||
        tab.instancePath.get().some((id, index) => id !== focusPlan.instancePath[index])
      )) restoreNavigation(tab, focusPlan.graphStack, focusPlan.instancePath)
      const graphId = currentGraphId(tab)
      setStack(tab.graphStack.get())
      const path = viewInstancePath(tab) ?? []
      const key = `${tab.id}:${graphId}`
      const pathKey = path.join('/')
      const extensionsGeneration = props.app.extensions.changed.get()
      const seedControllerEnabled = props.app.settings.get<boolean>('features.seedController.enabled')
      const occurrenceOwner = path.length === 0 ? undefined : {
        instancePath: path.slice(0, -1).map(asNodeId),
        node: asNodeId(path[path.length - 1]!),
      }
      const plannerAvailable = occurrenceOwner !== undefined && occurrencePlanner() !== undefined
      const previousBuild = sceneBuildContext
      const graphNodes = new Map(Object.entries(doc.graphs[graphId]?.nodes ?? {}))
      const canReusePositions = previousBuild !== undefined &&
        previousBuild.key === key &&
        previousBuild.pathKey === pathKey &&
        previousBuild.registry === reg &&
        previousBuild.extensionsGeneration === extensionsGeneration &&
        previousBuild.seedControllerEnabled === seedControllerEnabled &&
        previousBuild.plannerAvailable === plannerAvailable &&
        previousBuild.graphNodes.size === graphNodes.size &&
        [...previousBuild.graphNodes].every(([id, node]) => graphNodes.get(id) === node)
      const repositioned = canReusePositions
        ? updateSceneNodePositions(scene, previousBuild.document, doc, graphId)
        : undefined
      const built = repositioned ?? (() => {
        props.app.extensionRevision.get()
        const resolve = documentResolver(doc, (type) => props.app.virtualNodeKinds.get(type)?.schema ?? reg?.resolve(type))
        const occurrenceView = occurrenceDynamicView(doc, resolve, path, path.length === 0 ? graphId : doc.root)
        return buildScene({
          document: doc,
          seedControllerEnabled,
          graphId,
          resolve,
          renderVirtualNode: (node) => props.app.virtualNodeKinds.get(node.type)?.render(node),
          tokens: defaultTokens,
          measure,
          widgetMeasure,
          ...(path.length > 0 || occurrenceView.values.size > 0 ? { occurrenceView } : {}),
          ...(occurrenceOwner !== undefined ? {
            occurrence: { owner: occurrenceOwner, plannerAvailable },
          } : {}),
        })
      })()
      const graphView = doc.view.graphs[graphId]
      sceneBuildContext = {
        document: {
          ...doc,
          view: {
            ...doc.view,
            graphs: {
              ...doc.view.graphs,
              ...(graphView === undefined ? {} : {
                [graphId]: {
                  ...graphView,
                  nodes: Object.fromEntries(Object.entries(graphView.nodes).map(([id, node]) => [id, { ...node }])),
                },
              }),
            },
          },
        },
        graphNodes,
        key,
        pathKey,
        registry: reg,
        extensionsGeneration,
        seedControllerEnabled,
        plannerAvailable,
      }
      // A rebuild can produce a scene identical to the installed one: a
      // workspace-session swap re-reads an equal document, and an edit in
      // another graph leaves this one's content untouched. Installing it
      // anyway would fire scene-replacement listeners - cancelling an
      // in-flight link drag and hiding tooltips for no observable change -
      // so the identical scene stays installed. Everything downstream that
      // rebinds to the live Tab wrapper still runs.
      const replaced = key !== sceneKey || (repositioned !== undefined ? scene !== built : !scenesEqual(scene, built))
      if (replaced) {
        scene = built
        renderer.setScene(scene)
        controller.setSelectionOwner(key)
        // A document op replaces the scene but not remote gesture state.
        // Re-project the current actors directly, without an empty teardown.
        untrack(refreshPresenceProjection)
        hideCanvasTooltips()
        // A background rebuild (an execution tick, a collaboration patch)
        // produces no pointer event, so re-resolve hover at the stationary
        // pointer: whatever it still rests on gets its hover state and
        // tooltip back instead of waiting for the next real move.
        // Untracked: hover announcement reads reactive app state.
        untrack(() => controller.refreshHover())
      }
      // Overlays anchor to scene nodes, so they must be reassembled against
      // the scene that was JUST installed. Sibling-effect ordering is not
      // something Solid guarantees, so the rebuild calls the helper directly
      // (untracked: the scene effect must not subscribe to overlay signals).
      untrack(() => refreshSceneOverlays(tab))
      // Solver + widget-value diagnostics are derived per-build; replace
      // (never append) so the Problems panel reflects the CURRENT graph
      // state and clears when the condition (a stale DynamicSlot
      // specialization, an out-of-range stored value) goes away. Widget
      // validation runs AFTER refreshSceneOverlays so companion-driven rows
      // are excluded against this build's sources, not the previous one's.
      const widgetDiags = widgetValueDiagnostics()
      const sceneDiags = [...scene.diagnostics, ...widgetDiags.diagnostics]
      setInstanceDiagnostics(sceneDiags)
      if (untrack(hostFocused)) props.app.solveDiagnostics.set(sceneDiags)
      renderer.setRowMarks(widgetDiags.marks)
      // Undo/redo/delete may have removed selected items - but only a scene
      // replacement can. An unchanged scene invalidates nothing, and pruning
      // republishes the whole interaction overlay, which would drop an
      // in-flight drag's ghost noodle.
      if (replaced) controller.pruneSelection()
      // Keep an editor through a non-document rebuild or equivalent workspace
      // session swap while its input row still has the same write contract.
      // ASSET staging may also survive document changes. Untracked: the scene
      // effect must not subscribe to the editor signal.
      const ed = untrack(editor)
      // An extension gate flip can remove or reshape the editor's widget kind
      // without touching the document, so a non-ASSET draft must not outlive
      // one; ASSET is a built-in kind whose anchor check compares the row
      // contract directly, so registry churn cannot invalidate it.
      const documentUnchanged = ed !== undefined && tabDocumentUnchanged(ed.tab, editorDocumentRevision, tab) &&
        editorExtensionsGeneration === extensionsGeneration
      if (widgetEditorAnchorAlive(ed, scene.nodes, tab.id, graphId, reg?.mergeableTypes, documentUnchanged, scene.valueSources)) {
        // A workspace promotion replaces the Tab wrapper. Rebind in place so
        // the keyed editor keeps its draft and commits to the live store.
        ed!.tab = tab
        editorDocumentRevision = tab.store.revision
        editorExtensionsGeneration = extensionsGeneration
      } else setEditor(undefined)
      const openMenu = untrack(menu)
      // Menu items are a semantic snapshot: they also go stale when the
      // drilled occurrence, an extension gate, or a diagnostic focus plan
      // changes the scene without touching the document.
      if (openMenu !== undefined && focusPlan === undefined && openMenu.graphId === graphId &&
          openMenu.pathKey === path.join('/') && openMenu.schemaRegistry === reg &&
          openMenu.extensionsGeneration === extensionsGeneration &&
          tabDocumentUnchanged(openMenu.tab, openMenu.documentRevision, tab)) {
        if (openMenu.tab !== tab) {
          // The keyed menu must not remount: its retiring focusout would close
          // the equivalent replacement before the user can invoke it.
          openMenu.tab = tab
          openMenu.documentRevision = tab.store.revision
        }
      } else setMenu(undefined)
      setLinkDoubleClickMenu(undefined) // its link id/endpoints are scene-owned too
      const openController = untrack(controllerMenu)
      if (openController !== undefined) {
        const anchorAlive = openController.tab.id === tab.id && scene.nodes.some((node) =>
          node.layout.rows.some((row) => row.kind === 'widget' && row.controllerMode !== undefined &&
            (row.familyOwner?.graphId ?? graphId) === openController.graphId &&
            (row.familyOwner?.nodeId ?? node.id) === openController.nodeId &&
            (row.familyOwner?.valueKey ?? row.valueKey) === openController.inputId))
        if (!anchorAlive) setControllerMenu(undefined)
        else if (openController.tab !== tab) setControllerMenu({ ...openController, tab })
      }
      // vsPopover stays: it anchors to a stable id and re-resolves its content
      // (pin/unpin mutates the doc; closing here would eat the interaction).

      if (key !== sceneKey) {
        setVsPopover(undefined) // different graph: the anchor means nothing
        setSelExecPopover(undefined)
        sceneKey = key
        sceneViewportOwner = { tabId: tab.id, graphId }
        const saved = props.app.graphViewport(tab.id, graphId)
        if (saved) renderer.setViewport(saved)
        else renderer.fitToScene()
      }
      if (focusPlan && graphId === focusPlan.graphStack[focusPlan.graphStack.length - 1]) {
        const node = scene.nodes.find((candidate) => candidate.id === focusPlan.nodeId)
        if (node) {
          controller.setSelection([node.id])
          camera.animateTo(viewportCenteredOnNode(
            renderer.getViewport(),
            { x: node.x, y: node.y, width: node.layout.width, height: node.layout.height },
            { width: canvasEl.clientWidth, height: canvasEl.clientHeight },
          ))
        }
        if (props.app.diagnosticFocus.get() === focusRequest) props.app.diagnosticFocus.set(undefined)
      }
    })

    // Link/net-driven static inputs of the CURRENT graph (source of the
    // renderer's companion display). Also consulted by openWidgetEditor:
    // a driven input's widget is read-only - the wire decides its value,
    // and the dormant stored value must survive untouched underneath.
    let companionInputs: CompanionSourceMap = new Map()
    let companionDisplays: CompanionMap = {}

    /**
     * Widget-value diagnostics: stored values validated through the SAME
     * WidgetKind contract the editors use, so a document that arrives with
     * an out-of-range INT, an unknown COMBO option, or an invalid save
     * target surfaces in Problems without anyone opening an editor. Scope
     * rules: only STORED values are checked (schema defaults are the schema
     * author's contract, not the document's), selector rows carry dynamic
     * state instead of node.values, and link/net-driven rows display a
     * derived value that never executes from the stored one.
     */
    const widgetValueDiagnostics = (): { diagnostics: Diagnostic[]; marks: RowMarkMap } => {
      const out: Diagnostic[] = []
      // Row marks mirror each diagnostic at its widget row (red outline in
      // the renderer) so the Problems entry is actionable on the canvas.
      const marks: Record<string, Set<string>> = {}
      const mark = (nodeId: string, valueKey: string): void => {
        (marks[nodeId] ??= new Set()).add(valueKey)
      }
      for (const node of scene.nodes) {
        for (const row of node.layout.rows) {
          if (row.kind !== 'widget' || row.selector !== undefined) continue
          if (companionInputs.get(node.id)?.has(row.valueKey)) continue
          const kind = widgetRegistry().kind(row.spec.widgetType)
          if (!kind) {
            out.push(diag('warning', 'schema', 'widget.kindUnavailable', `${node.id}.${row.valueKey}: widget kind '${row.spec.widgetType}' is not available; using the raw-value editor`, {
              refs: [{ graphId: scene.graphId, nodeId: node.id, portId: row.inputId, valueKey: row.valueKey, direction: 'input' }],
            }))
            mark(node.id, row.valueKey)
            continue
          }
          // JSON cannot store undefined, so undefined means "not stored":
          // the schema default applies and is the schema author's problem,
          // not the document's. An explicit null IS stored (ASSET and
          // SAVE_TARGET use it as "no value") and must reach the validator.
          const value = node.node.values[row.valueKey]
          if (value === undefined) continue
          const where = `${node.id}.${row.valueKey}`
          if (row.spec.widgetType === 'ASSET' && typeof value === 'string') {
            out.push(unresolvedAssetImportDiagnostic({
              graphId: scene.graphId,
              nodeId: node.id,
              inputId: row.inputId,
              valueKey: row.valueKey,
              requested: value,
              ...(row.spec.kind !== undefined ? { expectedKind: row.spec.kind } : {}),
            }))
            mark(node.id, row.valueKey)
            continue
          }
          if (!kind.valueSchema.validate(value)) {
            out.push(diag('warning', 'schema', `widget.${row.spec.widgetType}.badValue`, `${where}: stored value does not fit this widget's value shape`, {
              refs: [{ graphId: scene.graphId, nodeId: node.id, portId: row.inputId, valueKey: row.valueKey, direction: 'input' }],
            }))
            mark(node.id, row.valueKey)
            continue
          }
          const found = kind.validate(value as Json, row.spec)
          if (found.length > 0) mark(node.id, row.valueKey)
          for (const d of found) {
            out.push({
              ...d,
              message: `${where}: ${d.message}`,
              refs: [{ graphId: scene.graphId, nodeId: node.id, portId: row.inputId, valueKey: row.valueKey, direction: 'input' }],
            })
          }
        }
      }
      return { diagnostics: out, marks }
    }

    // Execution state + badges: frozen tabs pin their execution, live tabs
    // track the lineage's latest. Derivation lives in scene-overlays.ts
    // (framework-free); this helper gathers the inputs, derives one model,
    // and installs it. A plain (non-reactive) function so it can be invoked
    // from two places: the reactive effect below (execution/preview/backend
    // changes) and directly after a scene rebuild - the model anchors
    // states/badges/previews to scene nodes, so it must always see the scene
    // that is actually installed in the renderer.
    function refreshSceneOverlays(tab: Tab | undefined): void {
      if (!tab) {
        renderer.setSelectorResolutions(undefined)
        renderer.setInactiveNodes(undefined)
        companionInputs = new Map()
        companionDisplays = {}
        setWidgetA11yTargets([])
        setPreviewA11yTargets([])
        setSemanticSource(undefined)
        setMediaPreviews([])
        setOutputImagePreviews([])
        setOutputPages(new Map())
        setOutputViewerKey(undefined)
        renderer.setCompanions({})
        minimap.setStates({})
        minimap.paint()
        return
      }
      const boundExec = props.app.executionForTab(tab)
      const gid = currentGraphId(tab)

      // On live tabs, a producer value sheds its stale mark only when a
      // cached comparison compile of the CURRENT document proves the
      // producer's upstream recipe unchanged since the run (liveExactnessFor
      // gates + prompt-space comparison).
      const frozen = tab.execution !== undefined
      const viewedPath = viewInstancePath(tab)
      const wouldRun = frozen ? undefined : props.app.scopeClosureCached(tab)
      renderer.setInactiveNodes(lazyInactiveSceneNodes({ frozen, closure: wouldRun, instancePath: viewedPath }))
      let exactProducer: ((rid: string) => boolean) | undefined
      const reg = props.app.registryForTab(tab)
      const live = frozen || boundExec?.artifact === undefined ? undefined : props.app.compileTabCached(tab)
      const liveArtifact = live?.ok ? live.artifact : undefined
      const retained = !frozen && boundExec && props.app.overlayModeForTab(tab) === 'latest'
        ? retainProvenExecution(boundExec, props.app.executionList(), liveArtifact, viewedPath, reg?.resolve)
        : undefined
      const exec = retained?.execution ?? boundExec
      if (!frozen && exec?.artifact && liveArtifact?.connection === exec.ref.connection &&
          exec.artifact.connection === exec.ref.connection) exactProducer = liveExactnessFor(liveArtifact, exec.artifact)
      // Terminal NATIVE runs can peek recorded values via GET /api/values.
      const execBackend = exec ? props.app.backendFor(exec.ref.connection) : undefined
      const values =
        exec && execBackend?.protocol === 'dinkster' && exec.status !== 'queued' && exec.status !== 'running'
          ? execBackend.connection.values()
          : undefined
      const currentDiagnostics = composeCanvasProblemDiagnostics({
        owned: problems().filter((diagnostic) =>
          diagnostic.owner === tab.id && (diagnostic.origin === 'compile' || diagnostic.origin === 'validation')),
        scene: instanceDiagnostics(),
        ...(tab.execution && exec?.artifact !== undefined ? { artifact: exec.artifact.diagnostics } : {}),
        ...(exec === undefined ? {} : { execution: exec.errors }),
      })
      const projectedProblems = deriveProblemProjection({
        diagnostics: currentDiagnostics,
        document: tab.store.doc,
        graphId: gid,
        instancePath: viewInstancePath(tab),
      })
      nodeProblems = projectedProblems.nodes

      const model = deriveSceneOverlays({
        scene,
        exec,
        graphId: gid,
        doc: tab.store.doc,
        def: tab.store.doc.graphs[gid],
        instancePath: viewInstancePath(tab),
        frozen,
        exactProducer,
        retainedRuntimeIds: retained?.retainedRuntimeIds,
        // Deprecation/replacement: live tabs only (frozen snapshots are
        // read-only history - upgrading them would falsify the record).
        replacements: frozen ? [] : props.app.scanTabReplacements(tab),
        nodeProblems,
        ...(() => {
          const dismissed = exec === undefined ? undefined : dismissedErrorNodes().get(exec.key)
          return dismissed === undefined ? {} : { dismissedErrorNodes: dismissed }
        })(),
        portProblems: projectedProblems.ports,
        resolveSchema: reg?.resolve,
        mirrorPreviews: props.app.settings.get<boolean>('execution.mirrorPreviews'),
        imageEstimator,
        previewRendererFor: (channel) => widgetRegistry().previewRendererFor(channel),
        loader: previewLoader,
        // Navigation identity survives promotion from a local to a shared session.
        outputPreviewKeyPrefix: `${tab.id}\u0000${outputPreviewDocumentToken(tab.graphStack)}`,
        outputPreviewIndex: (key) => outputPages().get(key) ?? 0,
        values,
      })

      renderer.setNodeStates(model.states)
      setRunLogsByNode(model.runLogsByNode)
      setRunErrorsByNode(model.runErrorsByNode)
      minimap.setStates(model.states)
      companionInputs = model.companionSources
      companionDisplays = model.companions
      renderer.setCompanions(model.companions)
      const linkedWidgetInputs = new Map<string, Map<string, boolean>>()
      for (const link of scene.links) {
        if (link.to.kind !== 'port') continue
        let ports = linkedWidgetInputs.get(link.to.node)
        if (!ports) linkedWidgetInputs.set(link.to.node, (ports = new Map()))
        ports.set(link.to.port, ports.get(link.to.port) === true || link.boundary !== true)
      }
      const widgetValueA11yTargets = scene.nodes.flatMap((node) => node.layout.rows.flatMap((row) => {
        if (row.kind !== 'widget') return []
        const companion = model.companions[node.id]?.[row.valueKey]
        const connection = linkedWidgetInputs.get(node.id)?.get(row.inputId)
        const linked = model.companionSources.get(node.id)?.has(row.inputId) ||
          (row.selector === undefined ? connection !== undefined : connection === true)
        if (!companion && !linked) return []
        return [{
          id: `${node.id}:${row.valueKey}`,
          label: `${node.layout.title}, ${row.label}`,
          target: { kind: 'widget', hit: { node, row }, ...(companion ? { companion } : {}), connected: true },
        }]
      }))

      // Resolve capabilities once; the renderer receives functions, never a
      // lens id. Runtime data is bound here without making the renderer know
      // about executions or the data lens.
      const lens = props.app.lensRegistry.resolve(props.app.lensFor(tab.id))
      const context = {
        execNodes: exec?.nodes,
        activities: exec?.activities,
        runtimeIdsOf: model.ownRuntimeIds,
        frozen,
        exactProducer,
      }
      const exposureAffordances = lens.widgetRowAffordance
        ? new Map(scene.nodes.flatMap((node) => {
            const rows = new Map(node.layout.rows.flatMap((row) => {
              if (row.kind !== 'widget') return []
              const item = widgetExposureItem(tab, node, row)
              return item === undefined
                ? []
                : [[row.inputId, { active: item.checked === true, label: item.label, disabled: frozen || item.disabled === true }] as const]
            }))
            return rows.size === 0 ? [] : [[node.id, rows] as const]
          }))
        : undefined
      const exposureA11yTargets = lens.widgetRowAffordance
        ? scene.nodes.flatMap((node) => node.layout.rows.flatMap((row) => {
            if (row.kind !== 'widget') return []
            const item = widgetExposureItem(tab, node, row)
            return item === undefined
              ? []
              : [{
                  id: `exposure:${node.id}:${row.inputId}`,
                  label: `${node.layout.title}, ${row.label}: ${item.label}`,
                  pressed: item.checked === true,
                  disabled: frozen || item.disabled === true,
                  activate: () => {
                    const current = activeTab()
                    if (!current || current.execution) return
                    const fresh = widgetExposureItem(current, node, row)
                    if (fresh?.disabled !== true && fresh?.action.kind === 'command') props.app.dispatchTo(current, fresh.action.invocation)
                  },
                }]
          }))
        : []
      const previewExposureAffordances = lens.previewSurfaceAffordance
        ? new Map(scene.nodes.flatMap((node) => {
            if (node.previewCapable !== true && model.previews[node.id] === undefined && model.outputTexts[node.id] === undefined) return []
            const item = previewExposureItem(tab, node)
            return item === undefined
              ? []
              : [[node.id, { active: item.checked === true, label: item.label, disabled: frozen || item.disabled === true }] as const]
          }))
        : undefined
      const previewExposureA11yTargets = lens.previewSurfaceAffordance
        ? scene.nodes.flatMap((node) => {
            if (node.previewCapable !== true && model.previews[node.id] === undefined && model.outputTexts[node.id] === undefined) return []
            const item = previewExposureItem(tab, node)
            return item === undefined
              ? []
              : [{
                  id: `preview-exposure:${node.id}`,
                  label: `${node.layout.title}, preview: ${item.label}`,
                  pressed: item.checked === true,
                  disabled: frozen || item.disabled === true,
                  activate: () => {
                    const current = activeTab()
                    if (!current || current.execution) return
                    const fresh = previewExposureItem(current, node)
                    if (fresh?.disabled !== true && fresh?.action.kind === 'command') props.app.dispatchTo(current, fresh.action.invocation)
                  },
                }]
          })
        : []
      setWidgetA11yTargets([
        ...widgetValueA11yTargets,
        ...exposureA11yTargets,
        ...previewExposureA11yTargets,
      ])
      renderer.setLensCapabilities({
        ...(lens.typeAdornments ? { typeAdornments: true } : {}),
        ...(lens.nodeBodyContent
          ? { nodeBodyContent: (node) => lens.nodeBodyContent!(node, context) }
          : {}),
        ...(lens.widgetRowAffordance
          ? {
              widgetRowAffordance: (node, row) => exposureAffordances?.get(node.id)?.get(row.inputId),
            }
          : {}),
        ...(lens.previewSurfaceAffordance
          ? { previewSurfaceAffordance: (node) => previewExposureAffordances?.get(node.id) }
          : {}),
      })

      renderer.setSelectorResolutions(model.selectorResolutions)
      replaceItems = model.replaceItems
      renderer.setBadges(model.badges)
      renderer.setPortProblems(model.portProblems)
      setBadgePopover(undefined) // anchor may have moved/vanished
      const nodeOutputTexts = lens.id === 'standard' ? model.outputTexts : {}
      renderer.setNodeOutputTexts(nodeOutputTexts)
      renderer.setNodePreviews(model.previews)
      setSemanticSource({
        owner: `${tab.id}:${gid}`,
        source: {
          scene,
          states: model.states,
          badges: model.badges,
          portProblems: model.portProblems,
          outputTexts: nodeOutputTexts,
        },
      })
      setPreviewA11yTargets(selectedInputPreviewA11yTargets(scene, model.selectedInputPreviews))
      setMediaPreviews(renderer.getScene().nodes.flatMap((node) => {
        if (node.layout.minimized) return []
        const media = model.previews[node.id]
        const source = model.previewSources[node.id]
        const preview = node.layout.preview
        const mediaRect = preview === undefined
          ? undefined
          : splitPreviewRect(preview, defaultTokens.previewCaptionHeight).media
        return media?.src !== undefined &&
          (media.kind === 'video' || media.kind === 'audio' || media.kind === 'model3d') &&
          mediaRect !== undefined
          ? [{
              id: node.id,
              node: { x: node.x, y: node.y, width: node.layout.width, height: node.layout.height },
              preview: mediaRect,
              media: media as NodePreview & { readonly kind: 'video' | 'audio' | 'model3d'; readonly src: string },
              ...(source === undefined ? {} : { onMediaError: () => previewLoader.markUnavailable?.(source) }),
            }]
          : []
      }))
      const outputItems = renderer.getScene().nodes.flatMap((node) => {
        if (node.layout.minimized) return []
        const output = model.executedImages[node.id]
        const content = model.previews[node.id]
        const preview = node.layout.preview
        const mediaRect = preview === undefined
          ? undefined
          : splitPreviewRect(preview, defaultTokens.previewCaptionHeight).media
        return output !== undefined && mediaRect !== undefined
          ? [{
              id: node.id,
              title: node.layout.title,
              node: { x: node.x, y: node.y, width: node.layout.width, height: node.layout.height },
              preview: mediaRect,
              output,
              ...(content?.download === undefined || (output.mediaKind !== undefined && output.mediaKind !== 'image')
                ? {}
                : { download: content.download }),
              ...(content?.width === undefined ? {} : { width: content.width }),
              ...(content?.height === undefined ? {} : { height: content.height }),
            }]
          : []
      })
      setOutputImagePreviews(outputItems)
      // Overlays (or the scene they anchor to) changed: refresh the overview.
      minimap.paint()
    }

    // Reactive driver for the overlay helper: execution progress, overlay
    // pinning, finished preview decodes, and registry (rule) arrival. Scene
    // rebuilds are NOT a dependency - the scene effect invokes the helper
    // directly, untracked, right after renderer.setScene.
    createEffect(() => {
      executions() // track execution state changes
      overlayPins() // pin switches which execution overlays this tab
      lenses() // switching the canvas lens re-derives node body overlays
      previewTick() // a finished async decode re-assembles the preview map
      outputPages()
      registry() // registry arrival/refresh changes rule availability
      problems() // each compile/submit sweep replaces the active tab's diagnostics
      instanceDiagnostics() // scene/widget diagnostics replace and clear per build
      dismissedErrorNodes() // dismissing a node's error badge removes it now
      settingsTick() // overlay-affecting settings (execution.mirrorPreviews)
      const tab = activeTab()
      untrack(() => refreshSceneOverlays(tab))
    })

    /** Build the exact partial-queue preview for one derived execution scope. */
    function selectionScopeHighlight(scope: ExecutionScope): ScopeHighlight | undefined {
      const reg = registry()
      const tab = activeTab()
      if (!tab || tab.execution || !reg) return undefined
      const graphId = currentGraphId(tab)
      if (graphId !== tab.store.doc.root) return undefined
      const def = tab.store.doc.graphs[graphId]
      // The SHARED input builder compileTab uses: target-backend identity,
      // registry, and capability-negotiated graph features (e.g. $typed)
      // all come from one place, so the preview closure can never disagree
      // with the real queue compile on capabilities.
      const input = props.app.compileInputForTab(tab, scope)
      const closure = input && scopeClosure(input)
      if (!closure) return undefined
      // Occurrence keys -> root-graph node ids (a subgraph instance is "in
      // scope" when ANY of its inner occurrences is).
      const rootIds = new Set<string>()
      for (const k of closure.included) {
        const occ = parseOccurrenceKey(k)
        rootIds.add(occ.instancePath[0] ?? occ.node)
      }
      // Structural traversal of the displayed (root) graph: reroutes,
      // selector branches, and value sources on in-closure wires. Random
      // selectors contribute EVERY candidate ("may run" superset) - their
      // '?' badge already tells the user the branch is rolled at queue time.
      const structural = closure.structural.get(graphId)
      const candidateKeys = new Set<string>()
      for (const [sid, cands] of structural?.selectors ?? []) {
        for (const c of cands) candidateKeys.add(selectorCandidateKey(sid, c))
      }
      return {
        nodes: rootIds,
        reroutes: structural?.reroutes ?? new Set(),
        selectors: new Set(structural?.selectors.keys() ?? []),
        selectorCandidates: candidateKeys,
        valueSources: structural?.valueSources ?? new Set(),
      }
    }

    // Selection toolbox: mode toggles + actions floating above the selected
    // nodes (the Nodes 2.0 above-node control strip). Host-derived like
    // badges: recomputed on selection/document changes, placed by the canvas.
    // Frozen execution views are read-only, so they grow no toolbox.
    createEffect(() => {
      selVersion()
      docTick()
      // A preview is valid only while the pointer remains over the button
      // for this exact selection/document snapshot.
      renderer.setScopeHighlight(undefined)
      const tab = activeTab()
      const def = tab ? tab.store.doc.graphs[currentGraphId(tab)] : undefined
      const sel = def ? [...controller.getSelection()].filter((id) => def.nodes[id]) : []
      if (!tab || tab.execution || !def || sel.length === 0) {
        renderer.setToolbox([])
        return
      }
      const viewNodes = tab.store.doc.view.graphs[currentGraphId(tab)]?.nodes
      const allMinimized = sel.every((id) => viewNodes?.[id]?.collapsed === true)
      const selectedColors = sel.map((id) => tab.store.doc.view.graphs[currentGraphId(tab)]?.nodes[id]?.color ?? null)
      const sharedColor = selectedColors.every((color) => color === selectedColors[0]) ? selectedColors[0] : undefined
      const modifications = [
        toolboxButton({
          id: 'core.mode',
          icon: 'sliders-horizontal',
          label: 'Choose mode',
        }),
        toolboxButton({
          id: 'core.minimize',
          icon: allMinimized ? 'panel-top-open' : 'panel-top-close',
          label: allMinimized ? 'Restore' : 'Minimize',
          active: allMinimized,
        }),
      ]
      const rows: ToolboxRow[] = []
      if (currentGraphId(tab) === tab.store.doc.root && registry()) {
        const scopes = props.app.selectionExecutionScopes(tab, sel)
        rows.push(partialExecutionButtons({
          ...(scopes?.upToReason ? { upTo: scopes.upToReason } : {}),
          ...(scopes?.betweenReason ? { between: scopes.betweenReason } : {}),
          ...(scopes?.fromOnwardsReason ? { fromOnwards: scopes.fromOnwardsReason } : {}),
        }).map(toolboxButton))
      }
      if (sel.length === 1) {
        const defId = subgraphDefIdOf(def.nodes[sel[0]!]!.type)
        if (defId !== undefined && tab.store.doc.graphs[defId]) {
          modifications.push(toolboxButton({ id: 'core.openSubgraph', icon: 'folder-open', label: 'Open Subgraph' }))
        }
      }
      const flattenAvailable = canFlattenSubgraph()
      const flattenRefusal = flattenAvailable
        ? flattenShellRefusalDiagnostic(def.nodes[sel[0]!]!, currentGraphId(tab), viewInstancePath(tab) ?? [], sel[0]!)
        : undefined
      modifications.push(toolboxButton({
        id: 'core.extractSubgraph',
        icon: 'group',
        label: 'Extract as Subgraph',
        disabled: !canExtractSubgraph(),
      }))
      modifications.push(toolboxButton({
        id: 'core.flattenSubgraph',
        icon: 'ungroup',
        label: 'Flatten Subgraph One Level',
        disabled: !flattenAvailable || flattenRefusal !== undefined,
        ...(!flattenAvailable
          ? { reason: 'Select exactly one subgraph occurrence.' }
          : flattenRefusal !== undefined
            ? { reason: flattenRefusal.message }
            : {}),
      }))
      rows.push([
        toolboxButton({ id: 'core.delete', icon: 'trash-2', label: 'Delete' }),
        toolboxSeparator(),
        ...modifications,
        toolboxSeparator(),
        toolboxButton({
          id: 'core.color',
          icon: 'circle',
          label: 'Choose color',
          ...(typeof sharedColor === 'string' ? { iconColor: sharedColor } : {}),
        }),
        toolboxSeparator(),
        toolboxButton({ id: 'core.more', icon: 'ellipsis-vertical', label: 'More actions' }),
      ])
      renderer.setToolbox(rows)
    })

    // -- widget editor overlay ----------------------------------------------

    function openWidgetEditor(hit: Extract<Hit, { kind: 'widget' }>): void {
      const tab = activeTab()
      if (!tab || tab.execution) return // frozen views are read-only
      const graphId = currentGraphId(tab)
      const nodeId = hit.node.id
      const valueGraphId = hit.row.familyOwner?.graphId ?? graphId
      const valueNodeId = hit.row.familyOwner?.nodeId ?? nodeId
      const valueKey = hit.row.familyOwner?.valueKey ?? hit.row.valueKey
      const spec = hit.row.spec
      const curveTarget = spec.widgetType === 'CURVE'
        ? props.app.curveTargetForInput(
            tab, valueGraphId, valueNodeId, valueKey, viewInstancePath(tab) ?? [],
          )
        : undefined
      // A link/net-driven input is read-only: the wire decides its value
      // (companion display), and editing would silently mutate the dormant
      // stored value underneath. The exact envelope -> curve editor relation
      // instead opens a read-only view of the executed curve. Selector rows
      // keep their own value channel and are never driven.
      if (hit.row.selector === undefined && companionInputs.get(nodeId)?.has(hit.row.valueKey) && curveTarget?.follow === undefined) return
      const editorRole = (registry()?.resolve(hit.node.node.type) as { readonly editorRole?: string } | undefined)?.editorRole
      const valueType = canonicalTypeIdOf(hit.row.type)
      if (props.app.openEditorForBinding(tab.id, {
        ...(editorRole === undefined ? {} : { editorRole }),
        nodeId: hit.node.node.type,
        widgetType: spec.widgetType,
        ...(valueType === undefined ? {} : { valueType }),
      })) return
      const mergeableTypes = registry()?.mergeableTypes
      const widgetKind = widgetRegistry().kind(spec.widgetType)
      const widgetView = widgetKind === undefined
        ? undefined
        : widgetRegistry().viewsFor(spec.widgetType).find((view) => view.id === hit.row.viewId)
      const widgetEditorSize = widgetView?.editorUi === undefined ? undefined : widgetEditorSizing(widgetView, spec)
      // Selector rows (DynamicCombo) carry their value on the row; everything
      // else persists under the row's value key.
      const stored = tab.store.doc.graphs[valueGraphId]?.nodes[valueNodeId]?.values[valueKey]
      const value =
        hit.row.derivedValue !== undefined
          ? hit.row.derivedValue
          : stored !== undefined ? stored : effectiveWidgetDefault(spec)
      const inputInventory = textEditorInputInventory(
        hit.node.elaborated,
        spec.textCompletions?.inputFamilies ?? [],
      )
      const inputFamilyMembers = spec.textCompletions === undefined
        ? undefined
        : inputInventory.inputFamilyMembers
      const reg = registry()
      const resolve = reg ? documentResolver(tab.store.doc, reg.resolve) : () => undefined
      const schema = resolve(hit.node.node.type)
      const descriptors = schema?.items.flatMap((item) => item.kind !== 'section' && item.outputDescriptors?.input === hit.row.valueKey
        ? [item.outputDescriptors] : [])[0]
      const descriptorRevision = tab.store.revision
      const descriptorNode = tab.store.doc.graphs[graphId]?.nodes[nodeId]
      const occurrenceValues = descriptors === undefined ? undefined : occurrenceDynamicView(
        tab.store.doc, resolve, viewInstancePath(tab) ?? [], (viewInstancePath(tab)?.length ?? 0) === 0 ? graphId : tab.store.doc.root,
      ).values.get(nodeId)
      const descriptorValues = occurrenceValues ?? hit.node.node.values
      const staleDescriptorLinks = descriptors === undefined ? [] : (() => {
        const { probe: _probe, ...unprobed } = descriptors
        const parsed = parseOutputDescriptors(unprobed, outputDescriptorValueOf(descriptors, descriptorValues))
        if (!parsed.ok && !descriptors.fixedIds) return []
        const descriptorIds = new Set([
          ...(parsed.ok ? parsed.document.entries.map((entry) => entry.id) : []),
          ...(descriptors.fixedIds ? descriptors.choices.map((choice) => choice.id) : []),
        ])
        const activeIds = new Set(hit.node.elaborated === undefined
          ? []
          : elabOutputsOf(hit.node.elaborated).map((output) => output.address.port))
        return Object.values(tab.store.doc.graphs[graphId]?.links ?? {}).flatMap((link) =>
          isPortEndpoint(link.from) && link.from.node === nodeId && descriptorIds.has(link.from.port) && !activeIds.has(link.from.port)
            ? [{ linkId: link.id, outputId: link.from.port }]
            : [])
      })()

      if (spec.widgetType === 'CURVE') {
        if (curveTarget) props.app.openCurveEditor(curveTarget)
        return
      }
      if (spec.widgetType === 'COMPOSITOR') {
        const target = props.app.compositorTargetForInput(
          tab, valueGraphId, valueNodeId, valueKey, viewInstancePath(tab) ?? [],
        )
        if (target) props.app.openCompositorEditor(target)
        return
      }
      if (hit.node.node.type === BUILTIN_EDITOR_NODE_IDS.glsl && valueKey === 'fragment_shader') {
        const target = props.app.glslTargetForInput(
          tab, valueGraphId, valueNodeId, valueKey, viewInstancePath(tab) ?? [],
        )
        if (target) props.app.openGlslEditor(target)
        return
      }

      // The built-in Boolean view toggles in place. A registered declarative
      // editor takes the ordinary expanded path instead. A ghost widget's
      // first toggle materializes its member in the SAME batch (one undo step).
      if (spec.widgetType === 'BOOLEAN' && hit.row.selector === undefined && widgetView?.editorUi === undefined) {
        props.app.dispatchTo(
          tab,
          withMaterializeFrames(valueGraphId, valueNodeId, hit.row.materialize, {
            command: 'node.setValue',
            params: { graphId: valueGraphId, nodeId: valueNodeId, inputId: valueKey, value: value !== true },
          }),
        )
        return
      }

      // Keep the graph as the focus origin before an optional editor takes
      // focus. ASSET uses native modal restoration; other families open an
      // anchored, non-modal popover near this compact row.
      canvasEl.focus()
      editorDocumentRevision = tab.store.revision
      editorExtensionsGeneration = props.app.extensions.changed.get()
      setEditor({
        tab,
        graphId,
        label: hit.row.label,
        target: {
          kind: 'input',
          nodeId,
          valueKey: hit.row.valueKey,
          ...(hit.row.familyOwner !== undefined ? { familyOwner: hit.row.familyOwner } : {}),
          ...(hit.row.inputFamilyOwner !== undefined ? { inputFamilyOwner: hit.row.inputFamilyOwner } : {}),
          ...(hit.row.materialize !== undefined ? { materialize: hit.row.materialize } : {}),
          ...(hit.row.selector !== undefined ? { selector: hit.row.selector } : {}),
        },
        spec: widgetKind === undefined ? undefined : spec,
        declaredType: hit.row.type,
        ...(hit.row.sourceFilename !== undefined ? { sourceFilename: hit.row.sourceFilename } : {}),
        // Captured at open time like declaredType: the merge arm gates on
        // the OWNER backend's advertised batch-merge providers.
        ...(mergeableTypes !== undefined ? { mergeableTypes } : {}),
        ...(inputFamilyMembers === undefined ? {} : { inputFamilyMembers }),
        multiline: widgetKind === undefined || hit.row.viewId === 'core.text',
        rect: {
          x: hit.x,
          y: hit.y,
          width: hit.width,
          height: hit.height,
        },
        initial: widgetKind === undefined ? JSON.stringify(value, null, 2) : value,
        ...(descriptors !== undefined ? { outputDescriptors: {
          spec: descriptors,
          asset: outputDescriptorAssetOf(descriptors, descriptorValues),
          staleLinks: staleDescriptorLinks,
          isCurrent: () => tab.store.revision === descriptorRevision && tab.store.doc.graphs[graphId]?.nodes[nodeId] === descriptorNode,
          onDisconnect: (linkId: string) => {
            const current = props.app.activeTab()
            if (current?.id === tab.id) props.app.dispatchTo(current, { command: 'link.disconnect', params: { graphId, linkId } })
          },
        } } : {}),
        ...(viewInstancePath(tab) === undefined ? {} : { instancePath: viewInstancePath(tab)! }),
        ...(widgetView?.editorUi === undefined ? {} : {
          hostUi: {
            provider: widgetView.editorUi,
            data: {
              value: value ?? null,
              widget: { type: spec.widgetType, options: spec.options as Json },
              target: { kind: 'input', graphId: valueGraphId, nodeId: valueNodeId, inputId: valueKey },
            },
            ...(widgetEditorSize === undefined ? {} : { sizing: widgetEditorSize }),
          },
        }),
      })
    }

    // A native modal owns the trusted backdrop pointerdown. After it closes,
    // hit-test the scene directly instead of replaying an untrusted event.
    openAssetWidgetAt = (clientX, clientY) => {
      const rect = canvasEl.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return
      if (document.elementFromPoint(clientX, clientY) !== canvasEl) return
      const world = renderer.toWorld(clientX - rect.left, clientY - rect.top)
      const hit = hitTest(renderer.getScene(), world.x, world.y, {
        scale: renderer.getViewport().scale,
        detailLevel: renderer.getDetailLevel(),
      })
      if (hit.kind === 'widget' && hit.row.spec.widgetType === 'ASSET') openWidgetEditor(hit)
    }

    /**
     * Click on a value source pill: the pill IS the widget, so open its
     * editor. The effective spec decides the editor kind; without one the
     * raw JSON fallback renders (the value is always editable - P2).
     */
    function openValueSourceEditor(vs: SceneValueSource): void {
      const tab = activeTab()
      if (!tab || tab.execution) return // frozen views are read-only
      const graphId = currentGraphId(tab)
      const source = tab.store.doc.graphs[graphId]?.valueSources?.[vs.id]
      if (!source) return
      const spec = vs.effective.spec

      // Booleans toggle in place; no overlay needed.
      if (spec?.widgetType === 'BOOLEAN') {
        props.app.dispatchTo(tab, {
          command: 'valueSource.setValue',
          params: { graphId, valueSourceId: vs.id, value: source.value !== true },
        })
        return
      }

      // Editor kind mirrors what a node input with this spec would use.
      const viewId = spec ? widgetRegistry().kind(spec.widgetType)?.defaultView(spec) : undefined
      canvasEl.focus()
      editorDocumentRevision = tab.store.revision
      editorExtensionsGeneration = props.app.extensions.changed.get()
      setEditor({
        tab,
        graphId,
        label: vs.title,
        target: { kind: 'valueSource', valueSourceId: vs.id },
        spec,
        // Raw fallback edits JSON text, which wants a multiline field.
        multiline: spec ? viewId === 'core.text' : true,
        rect: {
          x: vs.x,
          y: vs.y,
          width: vs.width,
          height: vs.height,
        },
        initial: spec ? source.value : JSON.stringify(source.value, null, 2),
      })
    }

    // -- camera bookmarks ------------------------------------------------------
    // Animation (rAF loop, manual-input-wins cancellation) and jump-plan
    // validation live in bookmark-camera.ts (framework-free); the host keeps
    // press-gesture timing state and plan application below.

    // Press memory carries the owning Tab OBJECT (identity, not id - live
    // tab ids are document lineages, and opening another document with the
    // same lineage replaces the Tab while reusing its id): a double-press
    // gesture only exists within ONE tab session - a quick Shift+1 on tab A
    // then tab B (or A's replacement) must save two bookmarks, not delete
    // the second one's.
    let lastSavePress: { tab: Tab; slot: number; at: number } | undefined
    let savePressTimer: ReturnType<typeof setTimeout> | undefined
    let lastJumpPress: { tab: Tab; slot: number; at: number } | undefined

    /**
     * Apply a validated bookmark jump: seed the viewport memory, restore
     * navigation, move the camera. Same-canvas jumps may animate; cross-canvas
     * jumps set the viewport immediately so both a different definition and a
     * different occurrence of one definition land without animation.
     */
    function jumpToBookmark(tab: Tab, bm: ViewBookmark, plan: BookmarkJumpPlan, mode: 'animate' | 'instant'): void {
      props.app.setGraphViewport(tab.id, plan.target, plan.viewport)
      restoreNavigation(tab, bm.graphStack, bm.instancePath)
      if (plan.sameCanvas) {
        if (mode === 'animate') {
          camera.animateTo('view' in bm && bm.view !== undefined
            ? () => bookmarkViewportForView(bm.view, { width: canvasEl.clientWidth, height: canvasEl.clientHeight })
            : plan.viewport)
        }
        else {
          camera.cancel()
          renderer.setViewport(plan.viewport)
        }
      } else renderer.setViewport(plan.viewport)
    }

    // -- keyboard: undo/redo/delete/bookmarks/clipboard -------------------------

    // The canvas only hears pointermove while it is the hit target, so an
    // overlay (Search Dinkster, the palette) hides the cursor exactly when a
    // placement gets armed. The window listeners store coordinates only (no
    // DOM reads); armPaletteEntry converts them to world space on demand.
    let lastClientPointer: { x: number; y: number } | undefined
    const rememberWindowPointer = (e: PointerEvent): void => {
      lastClientPointer = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointermove', rememberWindowPointer, { capture: true, passive: true })
    window.addEventListener('pointerdown', rememberWindowPointer, { capture: true, passive: true })

    // pointerWorld is declared with the presence egress block above (the
    // controller's selection callback and these handlers share it).
    const rememberPointer = (e: PointerEvent): void => {
      const rect = canvasEl.getBoundingClientRect()
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        pointerWorld = undefined
      } else {
        pointerWorld = renderer.toWorld(e.clientX - rect.left, e.clientY - rect.top)
      }
      if (armedPlacement && pointerWorld) {
        controller.setPlacementGhost(armedPlacementGhost(armedPlacement.displayName, pointerWorld, armedPlacement.geometry))
        canvasEl.dataset.placementGhost = 'visible'
        props.app.placementStatus.set(undefined)
      }
      publishPresence()
    }
    const forgetPointer = (): void => {
      pointerWorld = undefined
      controller.setPlacementGhost(undefined)
      delete canvasEl.dataset.placementGhost
      if (armedPlacement) props.app.placementStatus.set(armedPlacementStatus(armedPlacement.displayName))
      publishPresence()
    }
    const clearArmedPlacement = (): void => {
      armedPlacement?.unsubscribe()
      armedPlacement = undefined
      pointerWorld = undefined
      controller.setPlacementGhost(undefined)
      delete canvasEl.dataset.placementGhost
      props.app.placementStatus.set(undefined)
      publishPresence()
    }
    // Group focus loss cancels the pointer-attached placement: committing
    // it later would insert into a pane the user has visibly left. Arming
    // only happens in the focused instance, so clearing the app-level
    // placement status here cannot clobber a sibling's.
    createEffect(() => {
      if (!hostFocused() && armedPlacement !== undefined) clearArmedPlacement()
    })
    const entrySchemaKey = (entry: PaletteEntry): string => JSON.stringify({
      schema: entry.schema === undefined ? undefined : placementSchemaKey(entry.schema),
      blueprint: entry.blueprint,
    })
    const armedPlacementIsCurrent = (placement: ArmedPlacement): boolean => {
      const tab = activeTab()
      if (
        tab !== placement.tab ||
        currentGraphId(tab) !== placement.graphId ||
        props.app.backendForTab(tab).id !== placement.backendId ||
        tab.execution !== placement.frozenState ||
        placement.graphRetired()
      ) return false
      return paletteEntries().some((entry) =>
        entry.type === placement.entry.type &&
        entry.kind === placement.entry.kind &&
        entrySchemaKey(entry) === placement.schemaKey)
    }
    armPaletteEntry = (entry): boolean => {
      const tab = activeTab()
      if (!tab || frozen() || entry.type === '__dinkster.reroute') {
        clearArmedPlacement()
        return false
      }
      armedPlacement?.unsubscribe()
      armedPlacement = undefined
      controller.setPlacementGhost(undefined)
      delete canvasEl.dataset.placementGhost
      props.app.placementStatus.set(undefined)
      const graphId = currentGraphId(tab)
      const [graphRetired, setGraphRetired] = createSolidSignal(tab.store.doc.graphs[graphId] === undefined)
      const unsubscribe = tab.store.document.subscribe((document) => {
        if (document.graphs[graphId] === undefined) setGraphRetired(true)
      })
      armedPlacement = {
        entry,
        displayName: entry.name,
        tab,
        graphId,
        backendId: props.app.backendForTab(tab).id,
        frozenState: tab.execution,
        geometry: placementGeometryForEntry(entry),
        schemaKey: entrySchemaKey(entry),
        graphRetired,
        unsubscribe,
      }
      // Zero mouse movement required: seed the ghost from the last
      // window-level pointer position when the canvas has not heard a
      // pointermove (the pointer sat on an overlay when arming happened).
      if (pointerWorld === undefined)
        pointerWorld = seededPointerWorld(lastClientPointer, canvasEl.getBoundingClientRect(), (x, y) => renderer.toWorld(x, y))
      if (pointerWorld) {
        controller.setPlacementGhost(armedPlacementGhost(entry.name, pointerWorld, armedPlacement.geometry))
        canvasEl.dataset.placementGhost = 'visible'
        props.app.placementStatus.set(undefined)
      } else props.app.placementStatus.set(armedPlacementStatus(entry.name))
      return true
    }
    canvasEl.addEventListener('pointermove', rememberPointer)
    canvasEl.addEventListener('pointerleave', forgetPointer)

    let fileDropRequest: { readonly cancel: () => void } | undefined
    let fileDragDepth = 0
    const acceptedFileTransfer = (transfer: DataTransfer | null): transfer is DataTransfer =>
      transfer !== null && transfer.types.includes('Files')

    const externallyModalLocked = (): boolean =>
      modalPanel() !== '' ||
      document.querySelector('[aria-modal="true"]:not([data-modal="embedded-file-drop"])') !== null ||
      document.querySelector('.widget-editor[data-dismiss-blocked]') !== null

    const fileDropDisabledReason = (): string | undefined => {
      if (externallyModalLocked()) return 'Close the active modal operation before dropping a file.'
      const tab = activeTab()
      if (tab === undefined) return 'Open an editable workflow before dropping a file.'
      if (tab.execution !== undefined) return 'Return to the editable workflow before dropping a file.'
      return undefined
    }

    const presentFileDrag = (): void => {
      if (fileDropRequest !== undefined) return
      const disabledReason = fileDropDisabledReason()
      presentFileDropResult(disabledReason === undefined
        ? {
            state: 'drag',
            title: 'Drop file on canvas',
            detail: 'Add a workflow, image, or latent at this position.',
          }
        : {
            state: 'disabled',
            title: 'File drop unavailable',
            detail: disabledReason,
          })
    }

    const onFileDragEnter = (event: DragEvent): void => {
      if (!acceptedFileTransfer(event.dataTransfer)) return
      event.preventDefault()
      fileDragDepth += 1
      presentFileDrag()
    }

    const onFileDragOver = (event: DragEvent): void => {
      if (!acceptedFileTransfer(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = fileDropDisabledReason() === undefined ? 'copy' : 'none'
      if (fileDropSurface() === undefined) presentFileDrag()
    }

    const onFileDragLeave = (event: DragEvent): void => {
      if (!acceptedFileTransfer(event.dataTransfer)) return
      fileDragDepth = Math.max(0, fileDragDepth - 1)
      if (fileDragDepth !== 0) return
      const surface = fileDropSurface()
      if (surface?.state === 'drag' || surface?.state === 'disabled') presentFileDropResult(undefined)
    }

    // Shared ingress for a single local file entering the canvas, whether
    // dropped or pasted: identical guards, classification, upload, and atomic
    // insertion; only the surface wording differs by origin.
    const ingestCanvasFile = (file: File, position: { x: number; y: number }, origin: 'drop' | 'paste'): void => {
      const gerund = origin === 'drop' ? 'dropping a file' : 'pasting an image'
      const unavailableTitle = origin === 'drop' ? 'File drop unavailable' : 'Paste unavailable'
      const tab = activeTab()
      if (fileDropRequest !== undefined) {
        if (tab) props.app.reportProblems(tab.id, [diag('warning', 'import', 'fileDrop.busy', origin === 'drop' ? 'Wait for the current file drop to finish' : 'Wait for the current file import to finish')])
        return
      }
      presentFileDropResult(undefined)
      if (!startCanvasFileDrop(externallyModalLocked(), () => {})) {
        if (tab) props.app.reportProblems(tab.id, [diag('warning', 'import', 'fileDrop.modalLocked', `Close the active modal operation before ${gerund}`)])
        presentFileDropResult({
          state: 'error',
          title: unavailableTitle,
          detail: `Close the active modal operation before ${gerund}.`,
        })
        return
      }
      if (!tab || tab.execution !== undefined) {
        presentFileDropResult({
          state: 'error',
          title: unavailableTitle,
          detail: tab === undefined
            ? `Open an editable workflow before ${gerund}.`
            : `Return to the editable workflow before ${gerund}.`,
        })
        return
      }
      presentFileDropResult({
        state: 'inspecting',
        title: origin === 'drop' ? 'Inspecting dropped file' : 'Inspecting pasted image',
        detail: 'Checking the file before any upload or workflow change.',
        cancelable: true,
      })
      const graphId = currentGraphId(tab)
      const backend = props.app.backendForTab(tab)
      let graphRetired = false
      let settled = false
      const abort = new AbortController()
      let stopOwnershipWatch = (): void => {}
      let modalObserver: MutationObserver | undefined
      let request: { readonly cancel: () => void } | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        abort.abort()
        stopOwnershipWatch()
        modalObserver?.disconnect()
        if (fileDropRequest === request) fileDropRequest = undefined
        if (cancelCanvasFileDrop === request?.cancel) cancelCanvasFileDrop = undefined
        const surface = fileDropSurface()
        if (surface?.state === 'inspecting' || surface?.state === 'uploading') setFileDropSurface(undefined)
        setEmbeddedDropChoice((choice) => choice?.valid === ownerLive ? undefined : choice)
      }
      const ownerLive = (): boolean => {
        const live = !settled && props.app.tabs.get().includes(tab) && activeTab() === tab &&
          props.app.backendForTab(tab) === backend && !graphRetired && currentGraphId(tab) === graphId &&
          tab.execution === undefined && !externallyModalLocked()
        if (!live && !settled) finish()
        return live
      }
      request = { cancel: finish }
      fileDropRequest = request
      cancelCanvasFileDrop = request.cancel
      const cancelIfOwnerLost = (): void => { ownerLive() }
      const stopActiveWatch = props.app.activeTabId.subscribe(cancelIfOwnerLost)
      const stopTabsWatch = props.app.tabs.subscribe(cancelIfOwnerLost)
      const stopTargetsWatch = props.app.tabTargets.subscribe(cancelIfOwnerLost)
      // Split layout changes can retarget this editor to another tab
      // without the app-global active tab moving.
      const stopSplitWatch = props.app.editorSplits.layout.subscribe(cancelIfOwnerLost)
      const stopGraphOwnerWatch = watchFileDropGraphOwner({
        graphId,
        document: tab.store.document,
        graphStack: tab.graphStack,
        cancel: finish,
        onRetired: () => { graphRetired = true },
      })
      stopOwnershipWatch = (): void => { stopActiveWatch(); stopTabsWatch(); stopTargetsWatch(); stopSplitWatch(); stopGraphOwnerWatch() }
      modalObserver = new MutationObserver(cancelIfOwnerLost)
      modalObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'data-dismiss-blocked'] })
      const report = (code: string, message: string, title = 'File could not be added'): void => {
        props.app.reportProblems(tab.id, [diag('warning', 'import', code, message)])
        presentFileDropResult({ state: 'error', title, detail: message })
      }
      const openWorkflow = async (document: unknown): Promise<void> => {
        if (!ownerLive()) { finish(); return }
        setFileDropSurface({
          state: 'inspecting',
          title: 'Opening workflow',
          detail: 'Validating the dropped workflow before opening it.',
          cancelable: true,
        })
        await props.app.importWorkflowFile({ name: `${origin === 'drop' ? 'dropped' : 'pasted'}-workflow.json`, text: async () => JSON.stringify(document) }, ownerLive)
        finish()
      }
      const loadLatent = async (metadata: LatentMetadata): Promise<void> => {
        if (!ownerLive()) { finish(); return }
        setFileDropSurface({
          state: 'uploading',
          title: 'Adding latent',
          detail: 'Uploading the latent and preparing Load Latent.',
          cancelable: true,
        })
        const outcome = await insertDroppedLatent({
          file,
          graphId,
          position,
          tabStillOpen: ownerLive,
          graphStillOwned: () => !graphRetired,
          currentGraphId: () => currentGraphId(tab),
          frozen: () => tab.execution !== undefined,
          document: () => tab.store.doc,
          schemas: () => props.app.registryForTab(tab)?.schemas.values(),
          predictedNodeId: () => tab.store.predictedNodeId(graphId),
          upload: (body) => backend.protocol === 'dinkster'
            ? backend.connection.uploadLatentAsset(body, { scope: 'local', name: 'dropped-latent.latent', signal: abort.signal })
            : Promise.reject(new Error('latent upload requires a Dinkster backend')),
          dispatch: (invocation) => props.app.dispatchTo(tab, invocation).ok,
          onInserted: (nodeId) => { if (activeTab() === tab) controller.setSelection([nodeId]) },
        })
        const reportable = ownerLive()
        finish()
        if (!reportable) return
        if (outcome === 'inserted') {
          const facts = [
            ...(metadata.vaeHint === undefined ? [] : [{ label: 'VAE source', value: metadata.vaeHint }]),
            ...(metadata.latentSpace === undefined ? [] : [{ label: 'Latent space', value: metadata.latentSpace }]),
          ]
          presentFileDropResult({
            state: 'success',
            title: 'Latent added',
            detail: 'Load Latent was inserted without running the workflow.',
            ...(facts.length === 0 ? {} : { facts }),
          })
        } else if (outcome === 'upload-failed') report('fileDrop.latentUploadFailed', 'Dropped latent upload failed; no node was inserted', 'Latent could not be added')
        else if (outcome === 'invalid-asset') report('fileDrop.invalidLatentAsset', 'Latent upload returned an incomplete asset reference; no node was inserted', 'Latent could not be added')
        else if (outcome === 'schema-missing') report('fileDrop.loadLatentUnavailable', 'The active catalog has no canonical Load Latent ASSET node; no node was inserted', 'Load Latent unavailable')
        else if (outcome === 'rejected') report('fileDrop.insertLatentRejected', 'Load Latent insertion was rejected atomically', 'Latent could not be added')
      }
      const recoverLatentWorkflow = async (metadata: LatentMetadata): Promise<void> => {
        if (metadata.workflow === undefined) { await loadLatent(metadata); return }
        if (!ownerLive()) { finish(); return }
        setFileDropSurface({
          state: 'inspecting',
          title: 'Recovering latent workflow',
          detail: 'Validating the embedded workflow before opening it.',
          cancelable: true,
        })
        const imported = await props.app.importWorkflowFile({
          name: 'dropped-latent-workflow.json',
          text: async () => JSON.stringify(metadata.workflow),
        }, ownerLive)
        if (imported || !ownerLive()) finish()
        else await loadLatent(metadata)
      }
      const loadImage = async (mediaType: 'image/png' | 'image/jpeg' | 'image/webp'): Promise<void> => {
        if (!ownerLive()) { finish(); return }
        setEmbeddedDropChoice(undefined)
        setFileDropSurface({
          state: 'uploading',
          title: 'Adding image',
          detail: 'Uploading the image and preparing Load Image.',
          cancelable: true,
        })
        const outcome = await insertDroppedImage({
          file,
          mediaType,
          ...(origin === 'paste' ? { assetName: pastedImageName(mediaType) } : {}),
          graphId,
          position,
          tabStillOpen: ownerLive,
          graphStillOwned: () => !graphRetired,
          currentGraphId: () => currentGraphId(tab),
          frozen: () => tab.execution !== undefined,
          document: () => tab.store.doc,
          schemas: () => props.app.registryForTab(tab)?.schemas.values(),
          predictedNodeId: () => tab.store.predictedNodeId(graphId),
          upload: (body) => backend.protocol === 'dinkster'
            ? backend.connection.uploadAsset(body, abort.signal)
            : Promise.reject(new Error('asset upload requires a Dinkster backend')),
          dispatch: (invocation) => props.app.dispatchTo(tab, invocation).ok,
          onInserted: (nodeId) => { if (activeTab() === tab) controller.setSelection([nodeId]) },
        })
        const reportable = ownerLive()
        finish()
        if (!reportable) return
        if (outcome === 'inserted') presentFileDropResult({
          state: 'success',
          title: 'Image added',
          detail: 'Load Image was inserted without running the workflow.',
        })
        else if (outcome === 'upload-failed') report('fileDrop.uploadFailed', `${origin === 'drop' ? 'Dropped' : 'Pasted'} image upload failed; no node was inserted`, 'Image could not be added')
        else if (outcome === 'invalid-asset') report('fileDrop.invalidAsset', 'Image upload returned an incomplete asset reference; no node was inserted', 'Image could not be added')
        else if (outcome === 'schema-missing') report('fileDrop.loadImageUnavailable', 'The active catalog has no canonical Load Image ASSET node; no node was inserted', 'Load Image unavailable')
        else if (outcome === 'rejected') report('fileDrop.insertRejected', 'Load Image insertion was rejected atomically', 'Image could not be added')
      }
      void classifyDroppedFile(file).then((classification) => {
        if (fileDropRequest !== request || !ownerLive()) {
          finish()
          return
        }
        if (classification.kind === 'rejected') {
          finish()
          // The classifier words its messages for the drop path; reword the
          // codes a pasted clipboard blob can reach so the surface says so.
          const pasteMessages: Partial<Record<string, string>> = {
            'fileDrop.invalidSize': 'Pasted image is empty or exceeds the safe size limit',
            'fileDrop.readFailed': 'Pasted image could not be read',
            'fileDrop.unsupported': 'Unsupported pasted image type',
          }
          report(classification.code, (origin === 'paste' ? pasteMessages[classification.code] : undefined) ?? classification.message)
        } else if (classification.kind === 'workflow') {
          void openWorkflow(classification.document)
        } else if (classification.kind === 'latent') {
          void recoverLatentWorkflow(classification.metadata)
        } else if (classification.embeddedWorkflow !== undefined) {
          const choice = singleUseFileDropChoice(() => setEmbeddedDropChoice(undefined))
          const cancel = (): void => { choice.run(finish) }
          setEmbeddedDropChoice({
            loadImage: () => { choice.run(() => { void loadImage(classification.mediaType) }) },
            openWorkflow: () => { choice.run(() => { void openWorkflow(classification.embeddedWorkflow) }) },
            cancel,
            valid: ownerLive,
          })
        } else {
          void loadImage(classification.mediaType)
        }
      }, () => {
        if (fileDropRequest !== request || !ownerLive()) {
          finish()
          return
        }
        finish()
        report('fileDrop.readFailed', origin === 'drop' ? 'Dropped file could not be read' : 'Pasted image could not be read')
      })
    }

    const onFileDrop = (event: DragEvent): void => {
      const transfer = event.dataTransfer
      if (!acceptedFileTransfer(transfer)) return
      event.preventDefault()
      fileDragDepth = 0
      if (transfer.files.length !== 1) {
        const tab = activeTab()
        if (tab) props.app.reportProblems(tab.id, [diag('warning', 'import', 'fileDrop.multipleFiles', 'Drop exactly one file at a time')])
        presentFileDropResult({ state: 'error', title: 'File not added', detail: 'Drop exactly one file at a time.' })
        return
      }
      const file = transfer.files[0]
      if (!file) return
      const rect = canvasEl.getBoundingClientRect()
      const world = renderer.toWorld(event.clientX - rect.left, event.clientY - rect.top)
      ingestCanvasFile(file, { x: Math.round(world.x), y: Math.round(world.y) }, 'drop')
    }
    canvasEl.addEventListener('dragenter', onFileDragEnter)
    canvasEl.addEventListener('dragover', onFileDragOver)
    canvasEl.addEventListener('dragleave', onFileDragLeave)
    canvasEl.addEventListener('drop', onFileDrop)

    // -- presence ingress: remote cursors/selection into the renderer ------
    // Rebinds on tab switch, membership change, and graph navigation;
    // non-shared tabs paint no presence. The
    // projection filters to the CURRENT graph - a remote actor drilled into
    // a different subgraph has no world coordinates here.
    // Rebinding hygiene: a channel this canvas stops feeding must not keep
    // heartbeating its last on-canvas cursor (peers would see us frozen
    // mid-graph forever), and world coordinates never survive a tab or
    // graph change - a different camera means a different space.
    let boundChannel: PresenceChannel | undefined
    let boundTabId: string | undefined
    let boundGraph: string | undefined
    const presenceProjector = new PresenceProjector((remotes, graph) => {
      const actors: PresenceActor[] = []
      if (graph !== undefined) {
        for (const r of remotes.values()) {
          if (r.graph !== graph) continue
          actors.push({
            id: r.actorId,
            label: r.identity?.displayName ?? actorLabel(r.actorId),
            color: actorColor(r.actorId),
            selection: new Set(r.selection),
            rerouteSelection: new Set(r.reroutes),
            ...(r.cursor !== undefined ? { cursor: r.cursor } : {}),
            ...(r.hover !== undefined ? { hover: r.hover } : {}),
            ...(r.drag !== undefined ? { drag: r.drag } : {}),
            ...(r.link !== undefined ? { link: r.link } : {}),
            ...(r.view !== undefined ? { view: r.view } : {}),
          })
        }
      }
      renderer.setPresence(actors)
      // The minimap paints remote view rects from this same set; it has no
      // subscription of its own (its only trigger besides host calls is
      // the local viewport), so presence changes repaint it here.
      minimap.paint()
    })
    refreshPresenceProjection = () => presenceProjector.refresh()
    createEffect(() => {
      // `stack` changes only for graph navigation, unlike docTick (which
      // changes for every local or remote document op). A node drop must not
      // tear down another actor's still-live drag projection.
      stack()
      docTick()
      registry()
      tabTargets()
      const tab = activeTab()
      const entry = tab !== undefined ? collabTabs().get(tab.id) : undefined
      const channel = entry?.presence
      const graph = tab !== undefined ? currentGraphId(tab) : undefined
      if (armedPlacement && !armedPlacementIsCurrent(armedPlacement)) {
        clearArmedPlacement()
      }
      if (boundChannel !== undefined && boundChannel !== channel) boundChannel.blur()
      if (tab?.id !== boundTabId || graph !== boundGraph || channel !== boundChannel) {
        // ALL positional egress state dies with the space it was measured
        // in; hover/drag ids may even name another graph's entities.
        pointerWorld = undefined
        hoverNode = undefined
        dragOffsets = undefined
      }
      boundChannel = channel
      boundTabId = tab?.id
      boundGraph = graph
      presenceProjector.bind(channel, graph)
      if (tab !== undefined && entry !== undefined) publishPresence()
    })

    const copySelection = async (): Promise<void> => {
      const tab = activeTab()
      if (!tab) return
      const graphId = currentGraphId(tab)
      const scopeToken = `clipboard-${++clipboardScopeSeq}`
      const envelope = serializeSelection(tab.store.doc, graphId, {
        nodes: controller.getSelection(),
        reroutes: controller.getRerouteSelection(),
        groups: controller.getGroupSelection(),
      }, scopeToken)
      if (!envelope) return
      const graph = tab.store.doc.graphs[graphId]!
      const endpointTypes = clipboardSceneEndpointTypes(scene)
      clipboardScopes.clear()
      clipboardScopes.set(scopeToken, {
        tab,
        graphId,
        sources: new Map((envelope.externalIncoming ?? []).flatMap((stub) => {
          const node = graph.nodes[stub.source.node]
          return node === undefined ? [] : [[stub.source.node, node] as const]
        })),
        endpointTypes,
      })
      const text = JSON.stringify(envelope)
      clipboardFallback = text
      try { await navigator.clipboard.writeText(text) } catch { /* in-memory fallback remains available */ }
    }

    const pasteSelection = async (anchor = pointerWorld, connectInputs = false): Promise<void> => {
      // Owner capture BEFORE the clipboard await; the helper refuses to
      // commit if the tab closed, navigated, or froze during the read.
      // Selection is a view concern of the CURRENT canvas, so it only
      // updates when the invoking tab is still the active one.
      const tab = activeTab()
      if (!tab || frozen()) return
      const graphId = currentGraphId(tab)
      // Graph INCARNATION latch (the AP7 blueprint contract): graph ids are
      // reusable after an undo-of-import, so the id matching again after
      // the read does not prove the gesture's graph survived. Watch the
      // owner document while the read is in flight: once the captured
      // graph is absent, the incarnation is dead for good.
      let graphRetired = false
      const unsubscribe = tab.store.document.subscribe((document) => {
        if (document.graphs[graphId] === undefined) graphRetired = true
      })
      try {
        await pasteClipboardIntoTab({
          readText: async () => {
            try { return await navigator.clipboard.readText() } catch { return clipboardFallback }
          },
          graphId,
          anchor,
          connectInputs,
          // The session's own allocation scope, not the collab UI map: a
          // workspace-promoted tab is a shared session (actor-scoped id
          // cursors) without ever appearing in collabTabs.
          ...(tab.store.allocationActor !== undefined ? { actor: tab.store.allocationActor } : {}),
          acceptExternal: (envelope, stub: ExternalIncomingStub) => {
            const token = envelope.scope?.token
            const scope = token === undefined ? undefined : clipboardScopes.get(token)
            const sourceKey = clipboardEndpointKey(
              'tap' in stub.source ? 'tap' : 'output', stub.source.node,
              'tap' in stub.source ? stub.source.tap : stub.source.port,
              'tap' in stub.source ? undefined : stub.source.members,
            )
            const targetKey = clipboardEndpointKey('input', stub.target.node, stub.target.port, stub.target.members)
            const currentTypes = clipboardSceneEndpointTypes(scene)
            return scope?.tab === tab && scope.graphId === graphId &&
              scope.sources.get(stub.source.node) === tab.store.doc.graphs[graphId]?.nodes[stub.source.node] &&
              scope.endpointTypes.has(targetKey) && scope.endpointTypes.get(sourceKey) !== undefined &&
              scope.endpointTypes.get(sourceKey) === currentTypes.get(sourceKey)
          },
          tabStillOpen: () => props.app.tabs.get().includes(tab),
          frozen: () => tab.execution !== undefined,
          currentGraphId: () => currentGraphId(tab),
          graphStillOwned: () => !graphRetired,
          doc: () => tab.store.doc,
          dispatch: (invocation) => props.app.dispatchTo(tab, invocation).ok,
          onPasted: (nodeIds, rerouteIds) => {
            if (activeTab() === tab) controller.setSelection([...nodeIds], [], [...rerouteIds])
          },
        })
      } finally {
        unsubscribe()
      }
    }

    // Paste prefers an OS clipboard image over the graph text envelope: the
    // internal graph copy writes only clipboard text, so an image item always
    // came from outside the app. Without an image this falls through to the
    // ordinary selection paste.
    const pasteFromClipboard = async (anchor = pointerWorld, connectInputs = false): Promise<void> => {
      // Owner capture BEFORE the clipboard await, mirroring pasteSelection:
      // a tab or graph switch during the OS read must not receive a paste
      // aimed at the previous canvas (the anchor is in its coordinates).
      const tab = activeTab()
      if (!tab || frozen()) return
      const graphId = currentGraphId(tab)
      const image = await readClipboardImage(() => navigator.clipboard.read())
      if (activeTab() !== tab || currentGraphId(tab) !== graphId || tab.execution !== undefined) return
      if (image === undefined) {
        await pasteSelection(anchor, connectInputs)
        return
      }
      const file = new File([image.blob], pastedImageName(image.mediaType), { type: image.mediaType })
      const position = anchor ?? ((): { x: number; y: number } => {
        const rect = canvasEl.getBoundingClientRect()
        return renderer.toWorld(rect.width / 2, rect.height / 2)
      })()
      ingestCanvasFile(file, { x: Math.round(position.x), y: Math.round(position.y) }, 'paste')
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Only the focused split group's canvas responds to window-level
      // canvas shortcuts; unfocused sibling editors stay passive.
      if (!hostFocused()) return
      // Native text surfaces own Escape too; armed canvas placement must not
      // consume or stop keys originating in selectable shell content.
      if (isNativeTextScopeTarget(e.target)) return
      if (armedPlacement !== undefined && e.key === 'Escape') {
        clearArmedPlacement()
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      // The shell command dispatcher (App.tsx) registered its window
      // listener first, so it runs before this one: a key it consumed as a
      // registry command must never ALSO fire a canvas action.
      if (e.defaultPrevented) return
      // Canvas shortcuts are suspended while typing in a field or while a
      // modal/popover surface owns the keyboard; the shell's command
      // dispatcher (App.tsx) shares the exact same guard.
      if (shortcutSuppressed(e)) return
      const tab = activeTab()
      if (!tab) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        void copySelection()
        return
      }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void pasteFromClipboard()
        return
      }
      if (mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void pasteFromClipboard(undefined, true)
        return
      }
      // Lens toggle: plain D (works on frozen tabs too - inspecting a past
      // run's data is the lens's best use). Field focus already returned.
      if (!mod && !e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        props.app.toggleLens(tab.id, 'data')
        return
      }
      // Camera bookmarks (RTS control groups): Shift+1..0 saves the current
      // view into a numbered slot, plain 1..0 jumps back. e.code keeps digit
      // detection keyboard-layout independent; Shift (not Ctrl) is the save
      // chord because browsers reserve Ctrl+digit for their own tabs.
      const digit = /^Digit(\d)$/.exec(e.code)
      if (digit && !mod && !e.altKey) {
        if (e.repeat) return
        camera.cancel()
        const slot = digit[1] === '0' ? 10 : Number(digit[1])
        if (e.shiftKey) {
          const path = viewInstancePath(tab)
          if (path === undefined) return // desynced navigation: abstain
          e.preventDefault()
          const now = performance.now()
          const saveMode = bookmarkSaveMode(lastSavePress?.tab === tab ? lastSavePress : undefined, slot, now)
          if (savePressTimer !== undefined) clearTimeout(savePressTimer)
          if (saveMode === 'delete') {
            lastSavePress = undefined
            props.app.dispatchTo(tab, { command: 'view.clearBookmark', params: { slot } })
            return
          }
          const view = bookmarkViewFromViewport(renderer.getViewport(), {
            width: canvasEl.clientWidth,
            height: canvasEl.clientHeight,
          })
          if (!view) return
          lastSavePress = { tab, slot, at: now }
          savePressTimer = setTimeout(() => {
            lastSavePress = undefined
            savePressTimer = undefined
          }, 500)
          props.app.dispatchTo(tab, {
            command: 'view.setBookmark',
            params: {
              slot,
              graphStack: [...tab.graphStack.get()],
              instancePath: [...path],
              view,
            },
          })
        } else {
          const bm = tab.store.doc.view.bookmarks?.[String(slot)]
          if (!bm) return
          e.preventDefault()
          const now = performance.now()
          // Orphaned bookmarks (undefined plan) never target the current
          // canvas, so the press-mode question collapses to instant/no-op.
          const plan = bookmarkJumpPlan(
            tab.store.doc,
            { graphStack: tab.graphStack.get(), instancePath: viewInstancePath(tab) },
            bm,
            { width: canvasEl.clientWidth, height: canvasEl.clientHeight },
          )
          const transitions = props.app.settings.get<boolean>('canvas.bookmarkTransitions')
          const mode = bookmarkJumpMode(lastJumpPress?.tab === tab ? lastJumpPress : undefined, slot, now, (plan?.sameCanvas ?? false) && transitions)
          lastJumpPress = { tab, slot, at: now }
          if (plan) jumpToBookmark(tab, bm, plan, mode)
        }
        return
      }
      // Registry-bound command shortcuts (undo, queue, view toggles, ...)
      // dispatch at the SHELL level (App.tsx), not here: they must keep
      // working when a non-graph editor kind owns the center region.
    }
    window.addEventListener('keydown', onKeyDown)

    // Publish the typed bridge other panels consume (surface bindings need
    // the selection and invocation-time group membership). Answers are
    // scoped to the graph currently rendered; anything else is unknowable
    // geometry and stays undefined. Only the focused split group's canvas
    // owns the app-level bridge; an unfocused sibling never publishes.
    const bridge: CanvasBridge = {
      selectedNodes: () => [...controller.getSelection()],
      groupMembers: (graphId, groupId) => {
        if (scene.graphId !== graphId) return undefined
        const group = scene.groups.find((g) => g.id === groupId)
        return group ? nodesInGroup(scene, group) : undefined
      },
      deleteSelection,
      selectAll: () => controller.selectAll(),
      setSelectedMode: (mode) => {
        const tab = activeTab()
        const nodeIds = [...controller.getSelection()]
        if (!tab || nodeIds.length === 0) return
        const def = tab.store.doc.graphs[currentGraphId(tab)]
        const nextMode = mode === 'active'
          ? 'active'
          : toggledSelectionMode(nodeIds.map((id) => def?.nodes[id]?.mode ?? 'active'), mode)
        props.app.dispatchTo(tab, { command: 'node.setMode', params: { graphId: currentGraphId(tab), nodeIds, mode: nextMode } })
      },
      toggleSelectedCollapsed: () => {
        const tab = activeTab()
        const nodeIds = [...controller.getSelection()]
        if (!tab || nodeIds.length === 0) return
        toggleSelectedNodes(tab, nodeIds)
      },
      zoomBy,
      // CanvasRenderer currently exposes whole-scene fit only. Selection fit
      // uses that safe fallback until a public rectangle-fit primitive lands.
      fitSelection: fitView,
      armNodePlacement: (type, expected) => {
        const tab = activeTab()
        const entry = paletteEntries().find((candidate) =>
          candidate.type === type &&
          candidate.kind === 'node' &&
          candidate.schema !== undefined &&
          (expected === undefined || placementSchemaKey(candidate.schema) === expected.schemaKey))
        if (
          !entry || !tab || entry.schema === undefined ||
          searchVisibilityOf(entry.schema) !== 'normal' ||
          (expected !== undefined && props.app.backendForTab(tab).id !== expected.backendId)
        ) {
          clearArmedPlacement()
          return false
        }
        const armed = armPaletteEntry(entry)
        // The Search Dinkster dialog that invoked this is still open; closing
        // it restores focus to whatever opened the search. Re-focus the
        // canvas afterwards so the armed placement answers Escape and rides
        // the cursor without a first canvas click.
        if (armed) queueMicrotask(() => canvasEl.focus())
        return armed
      },
      createEmptySubgraph: (position) => {
        const tab = activeTab()
        if (!tab || frozen()) return false
        const vp = renderer.getViewport()
        const center = position ?? {
          x: (canvasEl.clientWidth / 2 - vp.x) / vp.scale,
          y: (canvasEl.clientHeight / 2 - vp.y) / vp.scale,
        }
        return props.app.createEmptySubgraph(tab, currentGraphId(tab), center).ok
      },
      createRegion: (kind, position) => {
        const tab = activeTab()
        if (!tab || frozen()) return false
        const vp = renderer.getViewport()
        const center = position ?? {
          x: (canvasEl.clientWidth / 2 - vp.x) / vp.scale,
          y: (canvasEl.clientHeight / 2 - vp.y) / vp.scale,
        }
        return createRegionAt(tab, currentGraphId(tab), center, kind)
      },
      extractSubgraph: beginExtractSubgraph,
      flattenSubgraph: flattenSelectedSubgraph,
      canExtractSubgraph,
      canFlattenSubgraph,
    }
    createEffect(() => {
      if (hostFocused()) {
        untrack(() => {
          props.app.canvasBridge.set(bridge)
          props.app.canvasSelection.set(instanceSelection)
          props.app.selectionTick.update((v) => v + 1)
          props.app.solveDiagnostics.set(instanceDiagnostics())
        })
      } else if (props.app.canvasBridge.get() === bridge) {
        untrack(() => {
          props.app.canvasBridge.set(undefined)
          props.app.canvasSelection.set(EMPTY_CANVAS_SELECTION)
          props.app.selectionTick.update((v) => v + 1)
          // A graph sibling gaining focus republishes its own diagnostics;
          // this clear covers focus moving to a non-graph editor, whose
          // Problems view must not show another pane's canvas diagnostics.
          props.app.solveDiagnostics.set([])
        })
      }
    })
    commitArmedPlacement = (event) => {
      const placement = armedPlacement
      if (!placement || event.button !== 0) return
      if (!armedPlacementIsCurrent(placement)) {
        clearArmedPlacement()
        return
      }
      event.preventDefault(); event.stopImmediatePropagation()
      const rect = canvasEl.getBoundingClientRect(); const vp = renderer.getViewport()
      const pointer = {
        x: (event.clientX - rect.left - vp.x) / vp.scale,
        y: (event.clientY - rect.top - vp.y) / vp.scale,
      }
      const topLeft = titleCenteredPlacement(pointer, placement.geometry)
      clearArmedPlacement()
      commitPaletteEntry(placement.entry, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        worldX: topLeft.x,
        worldY: topLeft.y,
      }, { tab: placement.tab, graphId: placement.graphId })
    }
    canvasEl.addEventListener('pointerdown', commitArmedPlacement, true)

    onCleanup(() => {
      zoomCanvas = undefined
      resetCanvasZoom = undefined
      fitCanvas = undefined
      boundChannel?.blur() // host unmount: peers see us leave
      presenceProjector.dispose()
      if (props.app.canvasBridge.get() === bridge) {
        props.app.canvasBridge.set(undefined)
        props.app.canvasSelection.set(EMPTY_CANVAS_SELECTION)
        props.app.solveDiagnostics.set([])
      }
      lifecycleSelectNodes = undefined
      clearArmedPlacement()
      canvasEl.removeEventListener('pointerdown', commitArmedPlacement, true)
      window.removeEventListener('keydown', onKeyDown)
      canvasEl.removeEventListener('pointermove', rememberPointer)
      canvasEl.removeEventListener('pointerleave', forgetPointer)
      window.removeEventListener('pointermove', rememberWindowPointer, { capture: true })
      window.removeEventListener('pointerdown', rememberWindowPointer, { capture: true })
      canvasEl.removeEventListener('dragenter', onFileDragEnter)
      canvasEl.removeEventListener('dragover', onFileDragOver)
      canvasEl.removeEventListener('dragleave', onFileDragLeave)
      canvasEl.removeEventListener('drop', onFileDrop)
      fileDropRequest?.cancel()
      if (savePressTimer !== undefined) clearTimeout(savePressTimer)
      camera.dispose()
      minimap.dispose()
      unsubscribeEditorViewport()
      unsubscribeTabViewport()
      unsubscribePresenceViewport()
      hideCanvasTooltips()
      unsubscribeTooltipViewport()
      resizeObserver?.disconnect()
      removeGestureGuards()
      reducedMotionQuery?.removeEventListener('change', onReducedMotionChange)
      if (traceWindow.__dinksterPointerTrace === pointerTraceConsole)
        delete traceWindow.__dinksterPointerTrace
      controller.dispose()
      renderer.dispose()
      previewLoader.dispose()
      imageEstimator.dispose()
      mirrorGlslRunner.dispose()
      setPreviewA11yTargets([])
      setSemanticSource(undefined)
      setSemanticFocused(false)
      setMediaPreviews([])
      setActiveCanvasMedia(new Set<string>())
      setOutputImagePreviews([])
      setOutputPages(new Map())
      setOutputViewerKey(undefined)
      semanticTargetSelected = () => false
      activateSemanticItem = () => {}
      focusSemanticPin = () => {}
      focusCanvas = () => {}
    })
  })

  const breadcrumbName = (graphId: string): string => {
    const tab = activeTab()
    return tab?.store.doc.graphs[graphId]?.name ?? graphId
  }

  /** Frozen-tab banner data: execution identity, status, live-sync verdict. */
  const frozenInfo = () => {
    executions()
    tabs()
    backendsTick() // registry availability moves with backend/schema changes
    const tab = activeTab()
    if (!tab?.execution) return undefined
    const state = props.app.store.get(tab.execution)
    return {
      prompt: tab.execution.prompt,
      status: state?.status ?? 'unknown',
      sync: props.app.frozenSyncStatus(tab),
      live: props.app.liveTabFor(tab.store.doc.lineage),
      // The compile-time registry is gone (e.g. app restarted, backend
      // removed before it was retained): the snapshot renders without node
      // definitions. Say so - never silently resolve with other schemas.
      schemasUnavailable: !registry(),
    }
  }

  /** Live-tab chip: how the document relates to its overlay execution. */
  const liveSync = () => {
    executions()
    overlayPins()
    docTick()
    const tab = activeTab()
    if (!tab || tab.execution) return undefined
    return props.app.liveSyncStatus(tab)
  }

  // Badge popover content: reactive wrappers binding the framework-free
  // badge-info resolvers to host state (active tab, per-graph scan items,
  // backend advisory problem feed). Presentation lives in BadgePopover.tsx.
  const subgraphInfoFor = (nodeId: string) => {
    const tab = activeTab()
    return tab ? subgraphBadgeInfo(tab.store.doc, currentGraphId(tab), nodeId) : undefined
  }

  const openSubgraphFromPopover = (nodeId: string): void => {
    const info = subgraphInfoFor(nodeId)
    setBadgePopover(undefined)
    const tab = activeTab()
    if (info && tab) pushGraph(tab, info.defId, nodeId)
  }

  /** Deprecation badge popover content (scan item is per-graph, may be absent). */
  const replacementInfoFor = (nodeId: string) => {
    const tab = activeTab()
    if (!tab) return undefined
    return replacementBadgeInfo({
      doc: tab.store.doc,
      graphId: currentGraphId(tab),
      nodeId,
      resolve: props.app.registryForTab(tab)?.resolve,
      item: replaceItems.get(nodeId),
      problems: props.app.backendForTab(tab).replacementProblems.get(),
    })
  }

  const applyReplacementFromPopover = (nodeId: string): void => {
    const tab = activeTab()
    const item = replaceItems.get(nodeId)
    setBadgePopover(undefined)
    if (tab && item?.plan) props.app.applyReplacements(tab, [item])
  }

  const problemMessages = (nodeId: string, kind: NodeProblemKind): readonly string[] => {
    const tab = activeTab()
    const model = nodeProblems[nodeId]?.find((candidate) => candidate.kind === kind)
    if (!tab || !model) return []
    const reg = props.app.registryForTab(tab)
    return model.diagnostics.map((diagnostic) => problemDisplay(diagnostic, tab.store.doc, reg))
  }

  createEffect(() => {
    if (editor() || controllerMenu() || linkDoubleClickMenu() || menu() || modalPanel()) props.tooltips?.hide()
  })

  return (
    <>
      <canvas
        ref={canvasEl}
        class="graph-canvas"
        tabIndex={-1}
        data-testid="graph-canvas"
        onPointerMove={(event) => { lastCanvasPointer = { x: event.clientX, y: event.clientY } }}
        data-lens={activeLens().id}
        data-selection={selectionSize() + rerouteSelectionSize() + valueSourceSelectionSize() + selectorSelectionSize() + groupSelectionSize()}
        data-link-selection={linkSelectionSize()}
        data-reroute-selection={rerouteSelectionSize()}
        data-value-source-selection={valueSourceSelectionSize()}
        data-selector-selection={selectorSelectionSize()}
        data-group-selection={groupSelectionSize()}
      />
      <Show when={!editor() && !controllerMenu() && !linkDoubleClickMenu() && !menu() && !modalPanel()}>
        <CanvasSemanticNavigator
          owner={semanticScene().owner}
          items={semanticScene().items}
          selectionVersion={selVersion()}
          isSelected={(target) => semanticTargetSelected(target)}
          onActivate={(item) => activateSemanticItem(item)}
          onExit={() => focusCanvas()}
          onFocusChange={(focused) => setSemanticFocused(focused)}
          onActiveChange={(item) => focusSemanticPin(item)}
        />
      </Show>
      <Show when={fileDropSurface()} keyed>
        {(surface) => {
          const busy = surface.state === 'inspecting' || surface.state === 'uploading'
          const stateIcon = surface.state === 'success'
            ? CheckCircle2
            : surface.state === 'error' || surface.state === 'disabled'
              ? TriangleAlert
              : busy ? LoaderCircle : FileUp
          return (
            <section
              class="canvas-file-drop-surface"
              data-testid="canvas-file-drop-surface"
              data-state={surface.state}
              role={surface.state === 'error' || surface.state === 'disabled' ? 'alert' : 'status'}
              aria-live={surface.state === 'error' || surface.state === 'disabled' ? 'assertive' : 'polite'}
              aria-busy={busy ? 'true' : undefined}
            >
              <div class="canvas-file-drop-card">
                <span class="canvas-file-drop-icon" aria-hidden="true"><Icon icon={stateIcon} /></span>
                <div class="canvas-file-drop-copy">
                  <strong>{surface.title}</strong>
                  <span>{surface.detail}</span>
                  <Show when={surface.facts !== undefined && surface.facts.length > 0}>
                    <dl class="canvas-file-drop-facts">
                      <For each={surface.facts}>{(fact) => <><dt>{fact.label}</dt><dd>{fact.value}</dd></>}</For>
                    </dl>
                  </Show>
                </div>
                <Show when={surface.cancelable} fallback={
                  <Show when={surface.state === 'success' || surface.state === 'error'}>
                    <button
                      type="button"
                      class="canvas-file-drop-action"
                      aria-label={`Dismiss ${surface.title}`}
                      onClick={() => presentFileDropResult(undefined)}
                    >
                      <Icon icon={X} />
                    </button>
                  </Show>
                }>
                  <button
                    type="button"
                    class="canvas-file-drop-action"
                    onClick={() => cancelCanvasFileDrop?.()}
                  >Cancel</button>
                </Show>
              </div>
            </section>
          )
        }}
      </Show>
      <Show when={gestureRefusal()} keyed>
        {(refusal) => (
          <div
            class="gesture-refusal-toast"
            data-testid="gesture-refusal-toast"
            data-refusal-id={refusal.id}
            role="alert"
            style={{ left: `${refusal.x}px`, top: `${refusal.y}px`, 'max-height': `${refusal.maxHeight}px` }}
          >
            <span style={{ 'max-height': `${refusal.contentMaxHeight}px` }}>
              <strong>{refusal.diagnostic.code}</strong>: {refusal.diagnostic.message}
            </span>
            <button
              type="button"
              aria-label="Dismiss refusal message"
              onClick={() => setGestureRefusal(undefined)}
            >
              <Icon icon={X} />
            </button>
          </div>
        )}
      </Show>
      <For each={visibleMediaPreviewIds()}>{(id) => {
        const item = () => mediaPreviewById().get(id)
        let retainedItem = item()!
        const currentItem = () => {
          const current = item()
          if (current !== undefined) retainedItem = current
          return retainedItem
        }
        const projected = () => {
          const current = item()
          return current === undefined ? undefined : mediaScreenRect(current.node, current.preview, editorViewport(), canvasClientRect())
        }
        return (
          <Show when={item() !== undefined && projected() !== undefined}>
            <Show when={currentItem().media.kind === 'model3d'} fallback={
              <NodeMediaOverlay
                ownerId={id}
                media={currentItem().media as NodePreview & { readonly kind: 'video' | 'audio'; readonly src: string }}
                rect={projected()!}
                scale={editorViewport().scale}
                canvas={canvasEl}
                videoPreferences={(() => {
                  docTick()
                  const tab = activeTab()
                  return tab?.store.doc.view.graphs[currentGraphId(tab)]?.nodes[id]?.video
                })()}
                onVideoPreferences={(video) => {
                  const tab = activeTab()
                  if (tab) props.app.dispatchTo(tab, { command: 'view.setNodeVideo', params: { graphId: currentGraphId(tab), nodeId: id, video } })
                }}
                {...(currentItem().onMediaError === undefined ? {} : { onMediaError: currentItem().onMediaError })}
                onActiveChange={(active) => setCanvasMediaActive(`media:${id}`, active)}
              />
            }>
              <NodeModel3dOverlay
                ownerId={id}
                media={currentItem().media as NodePreview & { readonly kind: 'model3d'; readonly src: string }}
                rect={projected()!}
                scale={editorViewport().scale}
                canvas={canvasEl}
                onActiveChange={(active) => setCanvasMediaActive(`media:${id}`, active)}
              />
            </Show>
          </Show>
        )
      }}</For>
      <For each={visibleOutputPreviewKeys()}>{(key) => {
        const item = () => outputImagePreviewFor(key)
        const projected = () => {
          const current = item()
          if (current === undefined) return undefined
          const rect = mediaScreenRect(current.node, current.preview, editorViewport(), canvasClientRect())
          return rect === undefined ? undefined : visibleOutputPagerRect(rect, canvasClientRect())
        }
        const page = (index: number): void => {
          const currentItem = item()
          if (currentItem === undefined) return
          setOutputPages((current) => {
            const next = new Map(current)
            if (next.size >= 128 && !next.has(key)) next.delete(next.keys().next().value!)
            next.set(key, Math.max(0, Math.min(index, currentItem.output.count - 1)))
            return next
          })
        }
        return (
          <Show when={item()}>
            {(current) => (
              <Show when={projected()}>
                {(rect) => (
                  <NodeOutputPager
                    title={current().title}
                    index={current().output.index}
                    count={current().output.count}
                    outputKey={key}
                    refusal={current().output.refusal}
                    {...(current().output.mediaKind === undefined ? {} : { mediaKind: current().output.mediaKind })}
                    {...(current().width === undefined ? {} : { width: current().width })}
                    {...(current().height === undefined ? {} : { height: current().height })}
                    {...(current().download === undefined ? {} : { download: current().download })}
                    rect={rect()}
                    canvas={canvasEl}
                    onPrevious={() => page(current().output.index - 1)}
                    onNext={() => page(current().output.index + 1)}
                    onActiveChange={(active) => setCanvasMediaActive(`pager:${key}`, active)}
                    {...((current().output.mediaKind !== undefined && current().output.mediaKind !== 'image') || (current().output.images.length === 0 && current().output.batch === undefined)
                      ? {}
                      : { onOpen: () => setOutputViewerKey(key) })}
                  />
                )}
              </Show>
            )}
          </Show>
        )
      }}</For>
      <Show when={outputViewer()} keyed>
        {(viewer) => <ExecutedImageViewer images={viewer.preview.output.images} batch={viewer.preview.output.batch} initialIndex={viewer.preview.output.index} provenance={viewer.provenance} onRequestClose={closeOutputViewer} />}
      </Show>
      <Show when={!editor() && !controllerMenu() && !linkDoubleClickMenu() && !menu() && !modalPanel()}>
        <div class="canvas-widget-a11y" aria-label="Canvas widget controls">
          <For each={widgetA11yTargets()}>{(item) => (
            <button
              type="button"
              data-testid={item.activate ? 'canvas-exposure-a11y' : 'canvas-widget-a11y'}
              aria-label={item.label}
              aria-pressed={item.pressed}
              disabled={item.disabled}
              onClick={() => item.activate?.()}
              onFocus={(event) => {
                if (item.target === undefined) return
                const rect = event.currentTarget.getBoundingClientRect()
                props.tooltips?.show(item.target, { x: rect.left, y: rect.bottom + 8 }, undefined, true, tooltipOwner)
              }}
              onBlur={() => props.tooltips?.hide()}
            >{item.label}</button>
          )}</For>
        </div>
      </Show>
      <CanvasPreviewA11y targets={previewA11yTargets()} />
      <Show when={embeddedDropChoice()} keyed>
        {(choice) => (
          <ModalSurface
            title="Embedded workflow found"
            ariaLabel="Choose how to open the dropped PNG"
            describedBy="embedded-drop-description"
            modalId="embedded-file-drop"
            testId="embedded-file-drop-dialog"
            closeLabel="Cancel dropped PNG"
            onRequestClose={choice.cancel}
          >
            <div class="embedded-file-drop-choice">
              <p id="embedded-drop-description">This PNG contains a Comfy workflow. Choose one action; nothing runs automatically.</p>
              <ProductActionFooter>
                <button type="button" autofocus onClick={choice.loadImage}>Load image</button>
                <button type="button" onClick={choice.openWorkflow}>Open embedded workflow</button>
                <button type="button" onClick={choice.cancel}>Cancel</button>
              </ProductActionFooter>
            </div>
          </ModalSurface>
        )}
      </Show>
      <Show when={controllerMenu()}>
        {(menu) => (
          <div
            class="palette-layer controller-menu-layer"
            data-testid="seed-controller-catcher"
            onPointerDown={(event) => { if (event.target === event.currentTarget) setControllerMenu(undefined) }}
          >
            <div
              ref={controllerMenuEl}
              class="floating-surface seed-controller-menu"
              data-testid="seed-controller-menu"
              style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
              role="menu"
            >
              <div class="seed-controller-title">After {menu().trigger === 'after_refresh' ? 'refresh' : 'generate'}</div>
              <For each={[
                { mode: 'fixed' as const, label: 'Fixed', description: menu().trigger === 'after_refresh' ? 'Keep this value after refresh.' : 'Keep this value after a successful run.', icon: Lock },
                { mode: 'increment' as const, label: 'Increment', description: menu().trigger === 'after_refresh' ? 'Choose the next option after refresh.' : 'Add the widget step after a successful run.', icon: Plus },
                { mode: 'decrement' as const, label: 'Decrement', description: menu().trigger === 'after_refresh' ? 'Choose the previous option after refresh.' : 'Subtract the widget step after a successful run.', icon: Minus },
                {
                  mode: 'randomize' as const,
                  label: menu().trigger === 'after_refresh' ? 'Randomize after refresh' : 'Randomize after run',
                  description: menu().trigger === 'after_refresh'
                    ? 'After each refresh, choose a random option; selecting this mode does not change the current value.'
                    : 'After each successful run, choose a new seed within bounds; selecting this mode does not change the current value.',
                  icon: Dice5,
                },
              ]}>
                {(option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={menu().mode === option.mode}
                    classList={{ 'seed-controller-option': true, selected: menu().mode === option.mode }}
                    data-testid={`seed-controller-${option.mode}`}
                    onClick={() => {
                      commitControllerMode(menu(), option.mode)
                      setControllerMenu(undefined)
                    }}
                  >
                    <Icon icon={option.icon} />
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    <Show when={menu().mode === option.mode}><Icon icon={Check} /></Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
      <Show when={minimapMenu()}>
        <div
          class="canvas-popover-backdrop"
          data-testid="canvas-popover-backdrop"
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            closeMinimapMenu()
          }}
        />
      </Show>
      <div ref={cornerControlsEl} class="canvas-corner-controls">
        <canvas ref={minimapEl} class="minimap" classList={{ hidden: (settingsTick(), !props.app.settings.get<boolean>('canvas.minimap.visible')) }} data-testid="minimap" data-node-colors={props.app.settings.get<boolean>('canvas.minimap.nodes')} data-bypass={props.app.settings.get<boolean>('canvas.minimap.bypass')} data-links={props.app.settings.get<boolean>('canvas.minimap.noodles')} data-groups={props.app.settings.get<boolean>('canvas.minimap.groups')} data-reroutes={props.app.settings.get<boolean>('canvas.minimap.reroutes')} data-errors={props.app.settings.get<boolean>('canvas.minimap.errors')} data-bookmarks={props.app.settings.get<boolean>('canvas.minimap.bookmarks')} />
        <div class="canvas-corner-bar">
          <div class="minimap-bar-controls" role="group" aria-label="Minimap controls">
            <button type="button" class="canvas-corner-button" data-testid="minimap-toggle" data-tooltip-label={minimapVisible() ? 'Hide minimap' : 'Show minimap'} aria-label={minimapVisible() ? 'Hide minimap' : 'Show minimap'} aria-pressed={minimapVisible()} onClick={toggleMinimap}><Icon icon={MapIcon} /></button>
            <button ref={minimapSettingsEl} type="button" class="canvas-corner-button" data-testid="minimap-settings" data-tooltip-label="Minimap settings" aria-label="Minimap settings" aria-expanded={minimapMenu()} onClick={() => minimapMenu() ? closeMinimapMenu() : openMinimapMenu()}><Icon icon={Settings2} /></button>
          </div>
          <div class="canvas-zoom-controls" role="group" aria-label="Canvas view controls">
            <button type="button" class="canvas-corner-button" data-testid="canvas-zoom-out" data-tooltip-label="Zoom out" aria-label="Zoom out (Alt+-)" onClick={() => zoomCanvas?.(1 / 1.2)}><Icon icon={ZoomOut} /></button>
            <button type="button" class="canvas-corner-button canvas-zoom-level" data-testid="canvas-zoom-level" data-tooltip-label="Reset zoom to 100%" aria-label={`Reset zoom to 100%. Current zoom ${Math.round(editorViewport().scale * 100)}%`} onClick={() => resetCanvasZoom?.()}>{Math.round(editorViewport().scale * 100)}%</button>
            <button type="button" class="canvas-corner-button" data-testid="canvas-fit-view" data-tooltip-label="Fit graph to view" aria-label="Fit graph to view (.)" onClick={() => fitCanvas?.()}><Icon icon={Maximize2} /></button>
            <button type="button" class="canvas-corner-button" data-testid="canvas-zoom-in" data-tooltip-label="Zoom in" aria-label="Zoom in (Alt+=)" onClick={() => zoomCanvas?.(1.2)}><Icon icon={ZoomIn} /></button>
          </div>
        </div>
        <Show when={minimapMenu()}><div classList={{ 'minimap-menu': true, above: minimapMenuPose().above }} style={minimapMenuPose().above ? { 'max-height': `${minimapMenuPose().maxHeight}px` } : undefined}>
            <For each={[["nodes", "Node Colors", Palette], ["bypass", "Render Bypass State", CircleSlash2], ["noodles", "Show Links", Route], ["groups", "Show Frames/Groups", Frame], ["reroutes", "Reroutes", CircleSlash2], ["errors", "Render Error State", MessageCircleWarning]] as const}>{([id, label, icon]) => {
              const setting = `canvas.minimap.${id}`
              const enabled = () => (settingsTick(), props.app.settings.get<boolean>(setting))
              return <button type="button" role="switch" class="minimap-setting-row" data-testid={`minimap-toggle-${id}`} aria-label={label} aria-checked={enabled()} onClick={() => { props.app.settings.set(setting, !enabled()); repaintMinimap?.() }}><Icon icon={icon} /><span>{label}</span><span class="minimap-switch" aria-hidden="true"><span /></span></button>
            }}</For>
            <button type="button" role="switch" class="minimap-setting-row" data-testid="minimap-marker-toggle" aria-checked={(settingsTick(), props.app.settings.get<boolean>('canvas.minimap.bookmarks'))} data-tooltip-label="Show bookmark numbers on the minimap" aria-label="Bookmarks. Show bookmark numbers on the minimap" onClick={() => { props.app.settings.set('canvas.minimap.bookmarks', !props.app.settings.get<boolean>('canvas.minimap.bookmarks')); repaintMinimap?.() }}><Icon icon={Bookmark} /><span>Bookmarks</span><span class="minimap-switch" aria-hidden="true"><span /></span></button>
          </div></Show>
      </div>

      <Show when={frozenInfo()}>
        {(f) => (
          <div class="frozen-banner" data-testid="frozen-banner" data-sync={f().sync}>
            <span class="frozen-label">FROZEN</span>
            <span>
              execution {f().prompt.slice(0, 8)} - {f().status}
            </span>
            <span class="frozen-sync">
              {f().sync === 'in-sync'
                ? 'matches the live workflow'
                : f().sync === 'diverged'
                  ? 'live workflow has changed since this ran'
                  : 'no live tab open'}
            </span>
            <Show when={f().schemasUnavailable}>
              <span class="frozen-schema-warning" data-testid="frozen-schema-missing">
                schemas from this run are unavailable - nodes render without definitions
              </span>
            </Show>
            <Show when={f().live}>
              {(live) => (
                <button
                  class="banner-button"
                  data-testid="frozen-go-live"
                  onClick={() => props.app.activeTabId.set(live().id)}
                >
                  Go to Live
                </button>
              )}
            </Show>
          </div>
        )}
      </Show>

      <Show when={liveSync()}>
        {(s) => (
          <div
            class="sync-chip"
            data-testid="sync-chip"
            data-sync={s().inSync ? 'in-sync' : 'diverged'}
            data-overlay-mode={s().mode}
          >
            <span>
              {s().mode === 'pinned' ? 'pinned: ' : ''}
              {s().inSync
                ? `execution ${s().ref.prompt.slice(0, 8)}: ${s().status}`
                : `edited since execution ${s().ref.prompt.slice(0, 8)} (${s().status})`}
            </span>
            <Show when={s().mode === 'pinned'}>
              <button
                class="banner-button"
                data-testid="sync-chip-follow-latest"
                onClick={() => {
                  const tab = activeTab()
                  if (tab) props.app.followLatestExecution(tab.id)
                }}
              >
                Follow Latest
              </button>
            </Show>
            <button
              class="banner-button"
              data-testid="sync-chip-open"
              onClick={() => props.app.openExecutionView(s().ref)}
            >
              View Frozen
            </button>
          </div>
        )}
      </Show>

      <Show when={stack().length > 1}>
        <nav class="breadcrumb" data-testid="graph-breadcrumb">
          <Index each={stack()}>
            {(graphId, i) => (
              <button
                class="crumb"
                disabled={i === stack().length - 1}
                onClick={() => {
                  const tab = activeTab()
                  if (tab) truncateGraphStack(tab, i + 1)
                }}
              >
                {breadcrumbName(graphId())}
              </button>
            )}
          </Index>
        </nav>
      </Show>

      <Show when={palette()}>
        {(p) => (
          <NodePalette
            anchor={p()}
            entries={paletteEntries}
            recentTypes={recentNodeTypes}
            widgetRegistry={widgetRegistry()}
            bounds={() => canvasClientRect()}
            onCommit={(entry) => paletteCommit(entry)}
            onHelp={(entry) => {
              const tab = activeTab()
              if (tab && props.app.openNodeHelp(tab, entry.type)) closePalette()
            }}
            onClose={closePalette}
          />
        )}
      </Show>

      <Show when={linkDoubleClickMenu()} keyed>
        {(linkMenu) => (
          <div class="link-menu-layer" data-testid="link-double-click-backdrop" tabIndex={-1} onPointerDown={(event) => { if (event.target === event.currentTarget && performance.now() - linkMenuOpenedAt > LINK_MENU_DISMISS_GRACE_MS) setLinkDoubleClickMenu(undefined) }} onKeyDown={(event) => { if (event.key === 'Escape') setLinkDoubleClickMenu(undefined) }} ref={(element) => queueMicrotask(() => element.focus())}>
            <div class="link-double-click-menu" data-testid="link-double-click-menu" style={{ left: `${linkMenu.x}px`, top: `${linkMenu.y}px` }}>
              <button type="button" onClick={() => {
                const tab = activeTab()
                setLinkDoubleClickMenu(undefined)
                if (tab) props.app.dispatchTo(tab, { command: 'reroute.insert', params: { graphId: currentGraphId(tab), linkId: linkMenu.context.linkId, position: linkMenu.context.position } })
              }}>Add reroute</button>
              <button type="button" onClick={() => {
                setLinkDoubleClickMenu(undefined)
                openSplicePalette(linkMenu.context)
              }}>Insert node...</button>
            </div>
          </div>
        )}
      </Show>

      <Show when={menu()} keyed>
        {(m) => (
          <ContextMenu
            menu={m}
            onInvoke={(item) => menuInvoke(item)}
            onClose={() => setMenu(undefined)}
          />
        )}
      </Show>

      <Show when={badgePopover()}>
        {(p) => (
          <BadgePopover
            anchor={p()}
            errors={nodeErrors}
            nodeLogs={nodeRunLogs}
            onDismissError={dismissNodeError}
            onOpenExecutionLog={openExecutionLogForNode}
            problems={problemMessages}
            subgraphInfo={subgraphInfoFor}
            replacementInfo={replacementInfoFor}
            onOpenSubgraph={openSubgraphFromPopover}
            onApplyReplacement={applyReplacementFromPopover}
            onClose={() => setBadgePopover(undefined)}
          />
        )}
      </Show>

      <Show when={vsPopover()}>
        {(p) => (
          <div
            class="badge-popover"
            data-testid="value-source-popover"
            tabindex="-1"
            ref={(el) => queueMicrotask(() => el.focus())}
            style={{ left: `${p().x}px`, top: `${p().y}px` }}
            onFocusOut={(e) => {
              // Stay open while focus moves within the popover (buttons).
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setVsPopover(undefined)
            }}
          >
            <Show
              when={valueSourceInfoFor(p().valueSourceId)}
              fallback={<p class="empty">Value source missing.</p>}
            >
              {(info) => (
                <>
                  <div class="badge-popover-title">
                    Value Source: {info().vs.title ?? info().effective.spec?.widgetType ?? 'value'}
                  </div>
                  <p
                    class="badge-popover-line"
                    data-testid="value-source-spec-state"
                    data-state={info().specState}
                  >
                    {info().specState === 'declared'
                      ? 'spec: declared (pinned)'
                      : info().specState === 'derived'
                        ? 'spec: derived from consumers'
                        : 'spec: none (raw value)'}
                    {info().effective.spec ? ` - ${info().effective.spec!.widgetType}` : ''}
                    {` - drives ${info().effective.consumers.length} input${
                      info().effective.consumers.length === 1 ? '' : 's'
                    }`}
                  </p>
                  <For each={info().effective.diagnostics}>
                    {(d) => (
                      <p class="badge-popover-line" data-testid="value-source-conflict">
                        {d.message}
                      </p>
                    )}
                  </For>
                  <Show when={!frozen() && info().specState === 'derived' && info().effective.spec}>
                    <button
                      class="banner-button"
                      data-testid="value-source-pin-spec"
                      // mousedown, not click: fires before the popover blurs.
                      onMouseDown={(e) => {
                        e.preventDefault()
                        pinValueSourceSpec(p().valueSourceId)
                      }}
                    >
                      Pin Current Spec
                    </button>
                  </Show>
                  <Show when={!frozen() && info().specState === 'declared'}>
                    <button
                      class="banner-button"
                      data-testid="value-source-unpin-spec"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        unpinValueSourceSpec(p().valueSourceId)
                      }}
                    >
                      Unpin Spec
                    </button>
                  </Show>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>

      <Show when={selExecPopover()}>
        {(p) => (
          <div
            class="badge-popover"
            data-testid="selector-exec-popover"
            tabindex="-1"
            ref={(el) => queueMicrotask(() => el.focus())}
            style={{ left: `${p().x}px`, top: `${p().y}px` }}
            onFocusOut={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSelExecPopover(undefined)
            }}
          >
            <Show
              when={selectorExecInfoFor(p().selectorId)}
              fallback={<p class="empty">Selector missing.</p>}
            >
              {(info) => (
                <>
                  <div class="badge-popover-title">Selector: {info().sel.title ?? 'Select'}</div>
                  <Show
                    when={info().choice}
                    fallback={
                      <p class="badge-popover-line" data-testid="selector-exec-no-choice">
                        Not resolved by this execution (branch not reached).
                      </p>
                    }
                  >
                    {(choice) => (
                      <>
                        <p
                          class="badge-popover-line"
                          data-testid="selector-exec-choice"
                          data-policy={choice().policy}
                          data-candidate={choice().candidate}
                        >
                          {choice().policy === 'random' ? 'Random pick' : 'Fixed pick'}
                          {': '}
                          {info().candidate?.title ??
                            (info().index >= 0 ? `candidate ${info().index + 1}` : choice().candidate)}
                        </p>
                        <p class="badge-popover-line">
                          This execution used this branch; the recorded choice never changes.
                        </p>
                      </>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>

      <Show when={netPrompt()}>
        {(p) => (
          <NamePrompt
            x={p().x}
            y={p().y}
            testid="net-prompt"
            placeholder={p().mode === 'create' ? 'Net name...' : 'New net name...'}
            initial={p().initial}
            onCommit={netPromptCommit}
            onCancel={() => setNetPrompt(undefined)}
          />
        )}
      </Show>

      <Show when={groupPrompt()}>
        {(p) => (
          <NamePrompt
            x={p().x}
            y={p().y}
            testid="group-prompt"
            placeholder="Group title..."
            initial={p().initial}
            onCommit={groupPromptCommit}
            onCancel={() => setGroupPrompt(undefined)}
          />
        )}
      </Show>

      <Show when={nodePrompt()}>
        {(p) => (
          <NamePrompt
            x={p().x}
            y={p().y}
            testid="node-prompt"
            placeholder="Node title..."
            initial={p().initial}
            onCommit={nodePromptCommit}
            onCancel={() => setNodePrompt(undefined)}
          />
        )}
      </Show>

      <Show when={selectorPrompt()}>
        {(p) => (
          <NamePrompt
            x={p().x}
            y={p().y}
            testid="selector-prompt"
            placeholder="Selector title..."
            initial={p().initial}
            onCommit={selectorPromptCommit}
            onCancel={() => setSelectorPrompt(undefined)}
          />
        )}
      </Show>

      <Show when={boundaryPrompt()}>
        {(p) => (
          <NamePrompt
            x={p().x}
            y={p().y}
            testid="boundary-prompt"
            placeholder={`${p().itemId} (empty resets)`}
            initial={p().initial}
            onCommit={boundaryPromptCommit}
            onCancel={() => setBoundaryPrompt(undefined)}
          />
        )}
      </Show>

      <Show when={editor()} keyed>
        {(ed) => (
          <WidgetEditor
            app={props.app}
            ed={ed}
            boundary={canvasEl.parentElement!}
            {...(props.federatedAssets !== undefined ? { federatedAssets: props.federatedAssets } : {})}
            viewport={editorViewport}
            bindClickAway={(handler) => { editorClickAway = handler }}
            onAssetBackdropPointerDown={(event) => openAssetWidgetAt(event.clientX, event.clientY)}
            onClose={() => {
              setEditor(undefined)
              if (ed.spec?.widgetType !== 'ASSET') queueMicrotask(() => canvasEl.focus())
            }}
          />
        )}
      </Show>
    </>
  )
}
