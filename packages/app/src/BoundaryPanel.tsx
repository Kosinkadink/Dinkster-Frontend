/**
 * Boundary panel: the rows of one subgraph definition's node, in stored
 * order (inputs, then outputs), and the settings of the selected row in a
 * fixed area below them. It edits the definition being viewed, or, with no
 * subgraph open, the definition of the one subgraph node selected on the
 * canvas. Every setting is one command; problems deriveBoundarySchema
 * reports show on their row.
 */

import { createEffect, createMemo, createSignal as createSolidSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { Plus, Trash2, TriangleAlert } from 'lucide-solid'
import { defaultTokens, typeColor } from '@dinkster/canvas'
import {
  boundaryConditionScope,
  boundaryInnerInput,
  boundaryItems,
  canonicalTypeIdOf,
  defaultBoundaryLabels,
  deriveBoundarySchema,
  documentResolver,
  inputsOf,
  isComboWidgetInput,
  memberRowsOf,
  normalizedComboOptions,
  numberFieldRange,
  optionRows,
  outputsOf,
  scopeRowsOf,
  subgraphDefIdOf,
  type BoundaryBinding,
  type BoundaryEntry,
  type BoundaryItem,
  type BoundaryLineEntry,
  type BoundarySectionEntry,
  type ChoiceSpec,
  type DescribedSpec,
  type Diagnostic,
  type GraphDef,
  type GroupSpec,
  type InputSpec,
  type Json,
  type JsonObject,
  type OptionRow,
  type OutputSpec,
  type RegionContract,
  type TypeChoiceSpec,
  type TypeExpr,
} from '@dinkster/core'
import {
  BoundaryTree,
  ProductButton as UiButton,
  ProductCheckbox as UiCheckbox,
  ProductIcon,
  ProductLink,
  ProductTextInput as UiTextInput,
  type BoundaryTreeDrag,
  type BoundaryTreeDrop,
  type BoundaryTreeEntry,
  type BoundaryTreeRow,
  type BoundaryTreeTemplateRow,
} from '@dinkster/ui'
import { ProductButton, ProductCheckbox } from './ProductControls.js'
import {
  addSection,
  arrangeBody,
  changeSection,
  entryKey,
  lineKey,
  lineOf,
  locate,
  moveEntry,
  placeOf,
  sectionKey,
  setOwnRow,
} from './boundary-body.js'
import { ProductEmptyState } from './ProductSurfaces.js'
import { ProductSelect } from './ProductSelect.js'
import { useAppMessage } from './locale.js'
import { activateProblem } from './ProblemsPanel.js'
import {
  currentGraphId,
  editedSubgraphDefinition,
  occurrenceReferencesDefinition,
  pushGraph,
  viewInstancePath,
  type AppState,
  type Tab,
} from './app-state.js'
import { useSignal } from './solid-adapter.js'
import { ProductNumberInput } from './ProductNumberInput.js'

type Side = 'inputs' | 'outputs'

interface PanelContext {
  readonly tab: Tab
  readonly def: GraphDef
  /** Set when no subgraph is open: the selected subgraph node outside. */
  readonly outsideNode?: string
}

interface Row {
  readonly side: Side
  readonly item: BoundaryItem
}

const formulaLiteral = (value: string | number | boolean): string =>
  typeof value === 'boolean' ? (value ? 'True' : 'False') : typeof value === 'number' ? String(value) : JSON.stringify(value)

/** The unbind parameters of one binding, or undefined when no unbind can remove it. */
const unbindParams = (binding: BoundaryBinding): JsonObject | undefined => {
  if (binding.kind === 'widgetTap') return { node: binding.node, tap: binding.tap }
  if (binding.kind !== 'port') return undefined
  return {
    node: binding.node,
    port: binding.port,
    ...(binding.viaReroute !== undefined ? { viaReroute: binding.viaReroute } : {}),
  }
}

export function BoundaryPanel(props: { app: AppState }) {
  const message = useAppMessage()
  const tabs = useSignal(props.app.tabs)
  const activeTabId = useSignal(props.app.activeTabId)
  const backendsTick = useSignal(props.app.backendsTick)
  const tabTargets = useSignal(props.app.tabTargets)
  const canvasSelection = useSignal(props.app.canvasSelection)
  const focus = useSignal(props.app.boundaryFocus)

  const activeTab = (): Tab | undefined => tabs().find((t) => t.id === activeTabId())

  // The ACTIVE tab's backend schema registry (same routing as CanvasHost).
  const registry = (): ReturnType<AppState['registryForTab']> => {
    backendsTick()
    tabTargets()
    const tab = activeTab()
    return tab ? props.app.registryForTab(tab) : props.app.registry.get()
  }

  // Re-render on document/stack changes of the active tab (same pattern as
  // CanvasHost: subscriptions rebind on tab switch).
  const [docTick, setDocTick] = createSolidSignal(0)
  createEffect(() => {
    const tab = activeTab()
    if (!tab) return
    const bump = () => setDocTick((n) => n + 1)
    const unsubDoc = tab.store.document.subscribe(bump)
    const unsubStack = tab.graphStack.subscribe(bump)
    onCleanup(() => {
      unsubDoc()
      unsubStack()
    })
  })

  /** The one subgraph node selected on the canvas, when no subgraph is open. */
  const selectedOccurrence = (tab: Tab): PanelContext | undefined => {
    const nodes = canvasSelection().nodes
    if (nodes.length !== 1) return undefined
    const node = tab.store.doc.graphs[currentGraphId(tab)]?.nodes[nodes[0]!]
    const id = node === undefined ? undefined : subgraphDefIdOf(node.type)
    const def = id === undefined ? undefined : tab.store.doc.graphs[id]
    return def?.boundary ? { tab, def, outsideNode: node!.id } : undefined
  }

  /** The definition whose rows the panel shows, or undefined (show the prompt). */
  const context = (): PanelContext | undefined => {
    docTick()
    const tab = activeTab()
    if (!tab) return undefined
    const def = editedSubgraphDefinition(tab)
    return def ? { tab, def } : selectedOccurrence(tab)
  }

  const availableDefinitions = () => {
    docTick()
    const tab = activeTab()
    const graph = tab?.store.doc.graphs[currentGraphId(tab)]
    if (!tab || !graph) return []
    return Object.values(graph.nodes).flatMap((node) => {
      const id = subgraphDefIdOf(node.type)
      const def = id === undefined ? undefined : tab.store.doc.graphs[id]
      return def?.boundary ? [{ tab, def, nodeId: node.id }] : []
    })
  }

  const regionCtx = (): {
    tab: Tab
    parentGraphId: string
    occurrenceNodeId: string
    region: RegionContract
  } | undefined => {
    docTick()
    const tab = activeTab()
    if (!tab || editedSubgraphDefinition(tab) === undefined) return undefined
    const path = viewInstancePath(tab)
    const stack = tab.graphStack.get()
    if (path === undefined || path.length === 0 || stack.length < 2) return undefined
    const occurrenceNodeId = path[path.length - 1]!
    const parentGraphId = stack[stack.length - 2]!
    const node = tab.store.doc.graphs[parentGraphId]?.nodes[occurrenceNodeId]
    if (!occurrenceReferencesDefinition(node, currentGraphId(tab)) || node?.region === undefined) return undefined
    return { tab, parentGraphId, occurrenceNodeId, region: node.region }
  }

  const frozen = (): boolean => activeTab()?.execution !== undefined

  const resolver = () => {
    const ctx = context()
    const reg = registry()
    return ctx && reg ? documentResolver(ctx.tab.store.doc, reg.resolve) : undefined
  }

  /** The SAME derivation the canvas uses, for names, types and problems. */
  const derivation = () => {
    const ctx = context()
    const resolve = resolver()
    if (!ctx || !resolve) return undefined
    return deriveBoundarySchema(ctx.def, resolve, regionCtx()?.region)
  }

  const boundaryDiags = (): readonly Diagnostic[] =>
    (derivation()?.diagnostics ?? []).filter((d) => d.code.startsWith('boundary.'))

  const diagsFor = (item: BoundaryItem): readonly Diagnostic[] =>
    boundaryDiags().filter((d) => d.refs?.some((ref) => ref.portId === item.id) ?? d.message.includes(`'${item.id}'`))

  const specOf = (row: Row): InputSpec | OutputSpec | undefined => {
    const schema = derivation()?.schema
    if (schema === undefined) return undefined
    return (row.side === 'inputs' ? inputsOf(schema) : outputsOf(schema)).find((spec) => spec.id === row.item.id)
  }

  const defaultItemName = (row: Row): string => {
    const construct = constructOf(row)?.displayName
    return specOf(row)?.displayName
      ?? (typeof construct === 'string' ? construct : undefined)
      ?? defaultBoundaryLabels(boundaryItems(context()?.def.boundary, row.side)).get(row.item.id)
      ?? row.item.id
  }

  const itemName = (row: Row): string => row.item.displayName ?? defaultItemName(row)

  /** A field on the subgraph node, as opposed to a pin. */
  const isField = (row: Row): boolean => {
    const spec = specOf(row)
    return row.side === 'inputs' && spec?.kind === 'input' && spec.widget !== undefined && row.item.promoted === true
  }

  const typeIdOf = (row: Row): string => {
    const spec = specOf(row)
    if (spec !== undefined) return canonicalTypeIdOf(spec.type) ?? (spec.kind === 'input' ? spec.widget?.widgetType : undefined) ?? '*'
    const binds = row.item.binds
    return (binds.kind === 'unbound' || binds.kind === 'valueSource' ? canonicalTypeIdOf(binds.type) : undefined) ?? '*'
  }

  const innerNodeName = (nodeId: string): string => {
    const ctx = context()
    const node = ctx?.def.nodes[nodeId]
    if (node === undefined) return nodeId
    return node.title ?? resolver()?.(node.type)?.displayName ?? node.type
  }

  /** The inner field or pin's label: its schema name, else its id. */
  const innerPortName = (side: Side, binding: BoundaryBinding): string => {
    if (binding.kind === 'unbound' || binding.kind === 'valueSource') return ''
    const node = context()?.def.nodes[binding.node]
    const schema = node === undefined ? undefined : resolver()?.(node.type)
    const port = binding.kind === 'widgetTap' ? binding.tap : binding.port
    const specs = schema === undefined ? [] : side === 'inputs' || binding.kind === 'widgetTap' ? inputsOf(schema) : outputsOf(schema)
    return specs.find((spec) => spec.id === port)?.displayName ?? port
  }

  /** Where a row goes, in words: "strength on Blend", never an id. */
  const destination = (row: Row): string | undefined => {
    const binds = row.item.binds
    if (binds.kind === 'unbound') return undefined
    if (binds.kind === 'valueSource') return context()?.def.valueSources?.[binds.valueSource]?.title ?? message('boundaryPanel.valueSource')
    const text = message('boundaryPanel.destination', { name: innerPortName(row.side, binds), node: innerNodeName(binds.node) })
    const more = row.item.alsoBinds?.length ?? 0
    return more > 0 ? message('boundaryPanel.destination.more', { destination: text, count: more }) : text
  }

  const quietNodeName = (row: Row): string => {
    const binds = row.item.binds
    if (binds.kind === 'unbound') return message('boundaryPanel.unbound')
    if (binds.kind === 'valueSource') return context()?.def.valueSources?.[binds.valueSource]?.title ?? message('boundaryPanel.valueSource')
    return innerNodeName(binds.node)
  }

  const usedIn = (): number => {
    const ctx = context()
    if (!ctx) return 0
    return Object.values(ctx.tab.store.doc.graphs).reduce((count, graph) =>
      count + Object.values(graph.nodes).filter((node) => occurrenceReferencesDefinition(node, ctx.def.id)).length, 0)
  }

  /** The stored body of the shown definition: its rows in the order the subgraph node draws them. */
  const body = (): readonly BoundaryEntry[] => context()?.def.boundary?.body ?? []

  const rowCache = new Map<string, Row>()
  /** Every input and output with its side, reusing unchanged row objects. */
  const rows = (): readonly Row[] => {
    const boundary = context()?.def.boundary
    const next = (['inputs', 'outputs'] as const).flatMap((side) => boundaryItems(boundary, side).map((item): Row => {
      const existing = rowCache.get(item.id)
      return existing !== undefined && existing.side === side && JSON.stringify(existing.item) === JSON.stringify(item)
        ? existing
        : { side, item }
    }))
    rowCache.clear()
    for (const row of next) rowCache.set(row.item.id, row)
    return next
  }
  const rowById = (id: string): Row | undefined => rows().find((row) => row.item.id === id)

  /** The key of the tree entry selected in this definition: an item id, or `section:<id>`. */
  const selectedKey = (): string | undefined => {
    const ctx = context()
    const current = focus()
    return ctx && current && current.tabId === ctx.tab.id && current.graphId === ctx.def.id ? current.item : undefined
  }
  const selected = (): Row | undefined => {
    const key = selectedKey()
    return key === undefined ? undefined : rowById(key)
  }
  const selectedSection = (): BoundarySectionEntry | undefined => {
    const key = selectedKey()
    const found = key?.startsWith('section:') ? locate(body(), key) : undefined
    return found?.entry.kind === 'section' ? found.entry : undefined
  }

  /** Selects a tree entry. A line itself has no settings; its fields do. */
  const selectKey = (key: string): void => {
    const ctx = context()
    if (!ctx || key.startsWith('line:')) return
    props.app.boundaryFocus.set({ tabId: ctx.tab.id, graphId: ctx.def.id, item: key })
  }

  // -- The tree -------------------------------------------------------------

  /** A whole group, choice, type choice or described row, as the derived schema holds it. */
  const constructOf = (row: Row): GroupSpec | ChoiceSpec | TypeChoiceSpec | DescribedSpec | undefined => {
    const schema = derivation()?.schema
    if (schema === undefined || row.item.binds.kind !== 'construct') return undefined
    const found = scopeRowsOf(schema.body).find((candidate) => 'id' in candidate && candidate.id === row.item.id)
    return found?.kind === 'group' || found?.kind === 'choice' || found?.kind === 'typeChoice' || found?.kind === 'described'
      ? found
      : undefined
  }

  const textOf = (value: unknown, fallback: string): string => typeof value === 'string' ? value : fallback

  /** What a construct is, in quiet text beside its name. */
  const constructNote = (row: Row): string => {
    const construct = constructOf(row)
    if (construct === undefined) return message('boundaryPanel.kind.construct')
    if (construct.kind !== 'group') return constructKind(row)
    const grows = construct.grows
    const fieldName = (id: string): string => {
      const schema = derivation()?.schema
      const spec = schema === undefined ? undefined : inputsOf(schema).find((candidate) => candidate.id === id)
      return textOf(spec?.displayName, id.replaceAll('_', ' '))
    }
    if (typeof grows === 'object' && 'count' in grows) return message('boundaryPanel.construct.countedBy', { name: fieldName(grows.count) })
    if (typeof grows === 'object') return message('boundaryPanel.construct.follows', { name: fieldName(grows.followList) })
    return message('boundaryPanel.construct.growing')
  }

  /** The kind a construct is, as the settings head names it. */
  const constructKind = (row: Row): string => {
    const kind = constructOf(row)?.kind
    return kind === 'group' ? message('boundaryPanel.kind.group')
      : kind === 'choice' ? message('boundaryPanel.kind.choice')
        : kind === 'typeChoice' ? message('boundaryPanel.kind.typeChoice')
          : kind === 'described' ? message('boundaryPanel.kind.described')
            : message('boundaryPanel.kind.construct')
  }

  const colorOf = (type: TypeExpr | undefined): string => typeColor(defaultTokens, (type === undefined ? undefined : canonicalTypeIdOf(type)) ?? '*')

  /** What each member or option of a construct holds, listed under its name. */
  const constructTemplate = (row: Row): BoundaryTreeTemplateRow[] => {
    const construct = constructOf(row)
    const plain = (rows: readonly OptionRow[]) => scopeRowsOf(rows).flatMap((entry) =>
      entry.kind === 'input' || entry.kind === 'output' ? [entry] : [])
    const line = (entry: InputSpec | OutputSpec): BoundaryTreeTemplateRow => ({
      label: textOf(entry.displayName, entry.id),
      side: entry.kind,
      color: colorOf(entry.type),
    })
    if (construct === undefined) return []
    if (construct.kind === 'group') return plain(memberRowsOf(construct)).map(line)
    if (construct.kind === 'described') return construct.kinds.map(line)
    const options = construct.kind === 'choice'
      ? construct.options.map((option) => ({ key: option.label ?? option.key, rows: plain(optionRows(construct, option.key)), type: undefined }))
      : (construct.variants ?? []).map((variant) => ({ key: variant.key, rows: plain(variant.rows), type: variant.type }))
    return options.map((option) => ({
      label: option.rows.length === 0 ? option.key : `${option.key}: ${option.rows.map((entry) => textOf(entry.displayName, entry.id)).join(', ')}`,
      side: 'input',
      color: colorOf(option.type ?? option.rows[0]?.type),
    }))
  }

  const problemOf = (row: Row): string | undefined => {
    const first = diagsFor(row.item)[0]
    return first === undefined ? undefined : problemText(first)
  }

  const treeRow = (row: Row): BoundaryTreeRow => ({
    kind: 'row',
    id: row.item.id,
    side: row.side === 'inputs' ? 'input' : 'output',
    label: itemName(row),
    color: typeColor(defaultTokens, typeIdOf(row)),
    target: quietNodeName(row),
    ...(row.item.visible !== undefined ? { condition: true } : {}),
    ...(problemOf(row) !== undefined ? { problem: problemOf(row)! } : {}),
  })

  const [closedSections, setClosedSections] = createSolidSignal<ReadonlySet<string>>(new Set())
  const toggleSection = (key: string): void => {
    setClosedSections((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }

  const sectionName = (section: BoundarySectionEntry): string => section.displayName ?? message('boundaryPanel.section.unnamed')

  /** The stored body as the panel's tree, reusing unchanged entries so their rows keep their DOM. */
  const treeCache = new Map<string, { readonly json: string; readonly entry: BoundaryTreeEntry }>()
  const treeEntries = createMemo((): readonly BoundaryTreeEntry[] => {
    const seen = new Set<string>()
    const keep = (entry: BoundaryTreeEntry): BoundaryTreeEntry => {
      const json = JSON.stringify(entry)
      seen.add(entry.id)
      const cached = treeCache.get(entry.id)
      if (cached?.json === json) return cached.entry
      treeCache.set(entry.id, { json, entry })
      return entry
    }
    const visit = (entries: readonly BoundaryEntry[]): BoundaryTreeEntry[] => entries.flatMap((entry): BoundaryTreeEntry[] => {
      if (entry.kind === 'section') {
        const key = sectionKey(entry.id)
        return [keep({
          kind: 'section',
          id: key,
          label: sectionName(entry),
          open: !closedSections().has(key),
          ...(entry.openName === false ? { nameWhileOpen: false } : {}),
          rows: visit(entry.rows),
        })]
      }
      if (entry.kind === 'line') {
        const fields = entry.rows.flatMap((field) => {
          const row = rowById(field.id)
          return row === undefined ? [] : [treeRow(row)]
        })
        return [keep({ kind: 'line', id: lineKey(entry), rows: fields })]
      }
      const row = rowById(entry.id)
      if (row === undefined) return []
      if (row.item.binds.kind !== 'construct') return [keep(treeRow(row))]
      const problem = problemOf(row)
      return [keep({
        kind: 'construct',
        id: row.item.id,
        construct: constructOf(row)?.kind ?? 'described',
        side: row.side === 'inputs' ? 'input' : 'output',
        label: itemName(row),
        target: quietNodeName(row),
        note: constructNote(row),
        template: constructTemplate(row),
        ...(problem !== undefined ? { problem } : {}),
      })]
    })
    const entries = visit(body())
    for (const key of [...treeCache.keys()]) if (!seen.has(key)) treeCache.delete(key)
    return entries
  })

  /** Every tree entry a person can select, in the order the tree shows them. */
  const shownKeys = (): string[] => {
    const visit = (entries: readonly BoundaryTreeEntry[]): string[] => entries.flatMap((entry) =>
      entry.kind === 'section' ? [entry.id, ...(entry.open ? visit(entry.rows) : [])]
        : entry.kind === 'line' ? entry.rows.map((row) => row.id)
          : [entry.id])
    return visit(treeEntries())
  }

  let treeElement: HTMLDivElement | undefined
  const entryElement = (key: string): HTMLElement | undefined =>
    [...(treeElement?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])].find((element) => element.dataset.entryId === key)

  // The tree scrolls to an entry selected from elsewhere once per selection,
  // so entries re-created by a later edit never scroll it back.
  let scrolledFocus: object | undefined
  createEffect(() => {
    const current = focus()
    const key = selectedKey()
    treeEntries()
    if (current === undefined || key === undefined || current === scrolledFocus) return
    const element = entryElement(key)
    if (element === undefined) return
    scrolledFocus = current
    element.scrollIntoView?.({ block: 'nearest' })
  })

  // -- Moving entries -------------------------------------------------------

  const [drag, setDrag] = createSolidSignal<BoundaryTreeDrag | undefined>(undefined)
  let endDrag: ((commit: boolean) => void) | undefined
  onCleanup(() => endDrag?.(false))

  /** Stores a new layout in one undo step; an unchanged layout stores nothing. */
  const arrange = (next: readonly BoundaryEntry[]): Promise<boolean> =>
    JSON.stringify(next) === JSON.stringify(body())
      ? Promise.resolve(true)
      : dispatch('boundary.arrange', { body: arrangeBody(next) }, 'layout')

  /** A field may join a line with room: only fields share a line, and at most four. */
  const canJoin = (key: string, line: BoundaryLineEntry): boolean => {
    const row = rowById(key)
    return row !== undefined && row.side === 'inputs' && row.item.binds.kind !== 'construct' && isField(row)
      && line.rows.length < 4 && !line.rows.some((field) => field.id === key)
  }

  /** Where an entry dragged to a point would land; undefined keeps the drop it has. */
  const dropAt = (key: string, x: number, y: number): BoundaryTreeDrop | undefined => {
    const tree = treeElement
    if (tree === undefined) return undefined
    const entries = body()
    const shown = (list: readonly BoundaryEntry[]) => list.filter((entry) => entryKey(entry) !== key)
    const hit = document.elementFromPoint(x, y)
    if (hit === null || !tree.contains(hit)) {
      const box = tree.getBoundingClientRect()
      return x >= box.left && x <= box.right && y > box.bottom ? { kind: 'slot', index: shown(entries).length } : undefined
    }
    if (hit.closest('.boundary-tree-slot') !== null) return undefined
    let element = hit.closest<HTMLElement>('[data-entry-id]')
    // A field of a line lands as its line does, except in the line's pocket.
    if (element?.classList.contains('boundary-tree-cell')) element = element.parentElement?.closest<HTMLElement>('[data-entry-id]') ?? null
    const found = element === null ? undefined : locate(entries, element.dataset.entryId ?? '')
    if (element === null || found === undefined) return undefined
    const slot = (index: number): BoundaryTreeDrop => ({ kind: 'slot', ...(found.section !== undefined ? { section: found.section } : {}), index })
    const at = shown(found.list).indexOf(found.entry)
    const box = element.getBoundingClientRect()
    // The right end of a line with room is its pocket; the rest of it opens a slot above or below.
    if (found.entry.kind === 'line' && canJoin(key, found.entry) && x > box.left + box.width * 0.7) {
      return { kind: 'pocket', line: lineKey(found.entry) }
    }
    if (found.entry.kind === 'section') {
      const sectionId = sectionKey(found.entry.id)
      const header = [...element.children].find((child) => child.classList.contains('boundary-tree-header'))
      const head = header?.getBoundingClientRect()
      const headBottom = head?.bottom ?? box.top + box.height / 2
      if (y < headBottom) {
        const open = !closedSections().has(sectionId)
        if (y < ((head?.top ?? box.top) + headBottom) / 2) return slot(at)
        return open ? { kind: 'slot', section: sectionId, index: 0 } : slot(at + 1)
      }
      return { kind: 'slot', section: sectionId, index: shown(found.entry.rows).length }
    }
    return slot(y < box.top + box.height / 2 ? at : at + 1)
  }

  /** A press on an entry's body moved past the threshold: it lifts out until the press ends. */
  const startDrag = (key: string): void => {
    if (editingDisabled() || endDrag !== undefined) return
    const start = placeOf(body(), key)
    if (start === undefined) return
    setDrag({ id: key, drop: start })
    const move = (event: PointerEvent) => {
      const drop = dropAt(key, event.clientX, event.clientY)
      if (drop !== undefined) setDrag({ id: key, drop })
    }
    const up = () => endDrag?.(true)
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      endDrag?.(false)
    }
    endDrag = (commit) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', escape, true)
      endDrag = undefined
      const drop = drag()?.drop
      setDrag(undefined)
      const next = commit && drop !== undefined ? moveEntry(body(), key, drop) : undefined
      if (next !== undefined) void arrange(next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', escape, true)
  }

  /**
   * Alt with an arrow moves the selected entry one place up or down: past its
   * neighbour, into an open section it meets, out of the section or line it
   * ends. Fields of a line step out of it.
   */
  const moveByKey = (key: string, delta: -1 | 1): void => {
    const entries = body()
    const slot = (section: string | undefined, index: number): BoundaryTreeDrop => ({ kind: 'slot', ...(section !== undefined ? { section } : {}), index })
    let drop: BoundaryTreeDrop | undefined
    const line = lineOf(entries, key)
    const found = locate(entries, line === undefined ? key : lineKey(line))
    if (found === undefined) return
    const index = found.list.indexOf(found.entry)
    if (line !== undefined) drop = slot(found.section, delta < 0 ? index : index + 1)
    else {
      const neighbour = found.list[index + delta]
      if (neighbour?.kind === 'section' && !closedSections().has(sectionKey(neighbour.id))) {
        drop = slot(sectionKey(neighbour.id), delta > 0 ? 0 : neighbour.rows.length)
      } else if (neighbour !== undefined) {
        drop = slot(found.section, index + delta)
      } else if (found.section !== undefined) {
        const parent = locate(entries, found.section)
        if (parent !== undefined) drop = slot(parent.section, parent.list.indexOf(parent.entry) + (delta > 0 ? 1 : 0))
      }
    }
    const next = drop === undefined ? undefined : moveEntry(entries, key, drop)
    if (next !== undefined) void arrange(next)
  }

  const focusEntry = (key: string): void => {
    const element = entryElement(key)
    const target = element?.matches('[tabindex]') ? element : element?.querySelector<HTMLElement>('[tabindex]')
    target?.focus()
  }

  const onTreeKey = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const key = selectedKey()
    if (event.altKey) {
      if (key !== undefined && !editingDisabled()) moveByKey(key, delta)
      return
    }
    const keys = shownKeys()
    if (keys.length === 0) return
    const index = key === undefined ? -1 : keys.indexOf(key)
    const next = keys[index < 0 ? (delta > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, index + delta))]!
    selectKey(next)
    focusEntry(next)
  }

  // One inline notice at a time, keyed to the row (or the region) whose edit
  // the command refused; cleared by any successful edit.
  const [notice, setNotice] = createSolidSignal<{ key: string; text: string } | undefined>(undefined)
  const [drafts, setDrafts] = createSolidSignal<Record<string, string>>({})
  const [pending, setPending] = createSolidSignal<object | undefined>(undefined)
  const [confirmingRemove, setConfirmingRemove] = createSolidSignal<string | undefined>(undefined)
  let lifetime = {}
  createEffect(() => {
    const tab = activeTab()
    const reset = () => {
      lifetime = {}
      setPending(undefined)
      setNotice(undefined)
      setDrafts({})
      setConfirmingRemove(undefined)
    }
    reset()
    const unsubStack = tab?.graphStack.subscribe(reset)
    const unsubPath = tab?.instancePath.subscribe(reset)
    onCleanup(() => {
      unsubStack?.()
      unsubPath?.()
      reset()
    })
  })
  const editingDisabled = () => frozen() || pending() !== undefined

  const clearDraft = (key: string): void => {
    setDrafts((current) => {
      const { [key]: _removed, ...remaining } = current
      return remaining
    })
  }

  /** Dispatches one invocation against the shown tab; a refusal becomes the notice under `key`. */
  const run = async (invocation: { command: string; params: JsonObject }, key: string): Promise<boolean> => {
    const ctx = context()
    if (!ctx || editingDisabled()) return false
    const owner = lifetime
    const store = ctx.tab.store
    const request = {}
    setPending(request)
    try {
      const outcome = await props.app.dispatchTo(ctx.tab, invocation)
      if (lifetime !== owner || activeTab() !== ctx.tab || ctx.tab.store !== store) return false
      if (outcome.ok) setNotice(undefined)
      else if (outcome.diagnostics[0]) setNotice({ key, text: outcome.diagnostics[0].message })
      return outcome.ok
    } finally {
      if (pending() === request) setPending(undefined)
    }
  }

  const dispatch = (command: string, params: JsonObject, key: string): Promise<boolean> => {
    const ctx = context()
    return ctx ? run({ command, params: { graphId: ctx.def.id, ...params } }, key) : Promise.resolve(false)
  }

  const regionDispatch = (command: string, params: JsonObject): Promise<boolean> => {
    const occurrence = regionCtx()
    return occurrence
      ? run({ command, params: { graphId: occurrence.parentGraphId, nodeId: occurrence.occurrenceNodeId, ...params } }, 'region')
      : Promise.resolve(false)
  }

  const rowKey = (row: Row): string => `item:${row.item.id}`

  /** Commits a text setting from its draft; an unchanged value commits nothing. */
  const commitText = async (row: Row, field: 'name' | 'help', value: string): Promise<void> => {
    if (editingDisabled()) return
    const key = `${field}:${row.item.id}`
    const stored = (field === 'name' ? row.item.displayName : row.item.tooltip) ?? ''
    if (value.trim() === stored) {
      clearDraft(key)
      return
    }
    const owner = lifetime
    setDrafts((current) => ({ ...current, [key]: value }))
    const accepted = field === 'name'
      ? await dispatch('boundary.renameItem', { side: row.side, itemId: row.item.id, displayName: value.trim() }, rowKey(row))
      : await dispatch('boundary.setTooltip', { side: row.side, itemId: row.item.id, tooltip: value.trim() }, rowKey(row))
    if (accepted && lifetime === owner && drafts()[key] === value) clearDraft(key)
  }

  const showOnCanvas = (row: Row): void => {
    const ctx = context()
    const binds = row.item.binds
    if (!ctx || binds.kind === 'unbound') return
    if (ctx.outsideNode !== undefined) {
      pushGraph(ctx.tab, ctx.def.id, ctx.outsideNode)
      return
    }
    if (binds.kind === 'valueSource') {
      props.app.canvasBridge.get()?.showValueSource?.(ctx.tab.id, ctx.def.id, binds.valueSource)
      return
    }
    activateProblem(props.app, {
      severity: 'info',
      origin: 'schema',
      code: 'boundary.focus',
      message: `Show boundary binding '${row.item.id}' on canvas`,
      anchor: { port: { node: binds.node, port: binds.kind === 'widgetTap' ? binds.tap : binds.port } },
    })
  }

  const removable = (row: Row): boolean =>
    unbindParams(row.item.binds) !== undefined && (row.item.alsoBinds ?? []).every((binding) => unbindParams(binding) !== undefined)

  /** One batch of unbinds removes the row: fan-out bindings first, the primary last. */
  const remove = async (row: Row): Promise<void> => {
    const ctx = context()
    if (!ctx || !removable(row)) return
    const bindings = row.side === 'inputs' ? [...(row.item.alsoBinds ?? []), row.item.binds] : [row.item.binds]
    const invocations = bindings.map((binding) => ({
      command: 'boundary.unbind',
      params: { graphId: ctx.def.id, side: row.side, itemId: row.item.id, ...unbindParams(binding)! },
    }))
    const accepted = await run(invocations.length === 1 ? invocations[0]! : { command: 'batch', params: { invocations } }, rowKey(row))
    if (accepted) setConfirmingRemove(undefined)
  }

  // -- Region roles (unchanged controls, shown for the selected row) -------

  const roleOf = (side: Side, item: BoundaryItem, region: RegionContract): string => {
    if (side === 'inputs') {
      if (region.elementPorts?.includes(item.id)) return 'element'
      if (region.statePorts?.includes(item.id)) return 'state'
      return 'capture'
    }
    if (region.continueOutput === item.id) return 'continuation'
    return region.outputRoles?.[item.id]?.kind ?? 'gather'
  }

  const outputRoleExplanation = (role: 'gather' | 'compact' | 'flatten'): string => role === 'gather'
    ? message('boundary.region.output.gather')
    : role === 'compact'
      ? message('boundary.region.output.compact')
      : message('boundary.region.output.flatten')

  const outputRoleTitle = (role: 'gather' | 'compact' | 'flatten'): string => role === 'gather'
    ? message('boundary.region.output.gather.title')
    : role === 'compact'
      ? message('boundary.region.output.compact.title')
      : message('boundary.region.output.flatten.title')

  const statePortOf = (item: BoundaryItem, region: RegionContract): string | undefined => {
    const role = region.outputRoles?.[item.id]
    return role?.kind === 'state' ? role.statePort : undefined
  }

  // -- Settings ------------------------------------------------------------

  /** The field's default: the inner field's stored value, else its schema default. */
  const defaultValue = (row: Row): unknown => {
    const spec = specOf(row)
    return spec?.kind === 'input' ? spec.widget?.default : undefined
  }

  const setDefault = (row: Row, value: Json): void => {
    const binds = row.item.binds
    if (binds.kind !== 'port') return
    void dispatch('node.setValue', { nodeId: binds.node, inputId: binds.port, value }, rowKey(row))
  }

  const innerRange = (row: Row) => {
    const ctx = context()
    const resolve = resolver()
    if (!ctx || !resolve || !isField(row)) return undefined
    return numberFieldRange(boundaryInnerInput(ctx.def, row.item, resolve))
  }

  const setLimit = (row: Row, bound: 'min' | 'max', raw: string): void => {
    const text = raw.trim()
    const value = text === '' ? null : Number(text)
    if (value !== null && !Number.isFinite(value)) return
    const limits = row.item.limits ?? {}
    void dispatch('boundary.setLimits', {
      itemId: row.item.id,
      min: bound === 'min' ? value : limits.min ?? null,
      max: bound === 'max' ? value : limits.max ?? null,
    }, rowKey(row))
  }

  /** "Show" choices: always, each nameable input plugged in, and each dropdown input's options. */
  const showChoices = (row: Row) => {
    const schema = derivation()?.schema
    const choices: { id: string; label: string; value: string | null }[] = [
      { id: 'always', label: message('boundaryPanel.show.always'), value: null },
    ]
    if (schema === undefined) return { choices, unnamed: false }
    const scope = boundaryConditionScope(schema)
    const inputs = inputsOf(schema).filter((spec) => spec.id !== row.item.id)
    const nameable = inputs.filter((spec) => scope.inputs?.has(spec.id) === true)
    const nameOf = (spec: InputSpec) => spec.displayName ?? spec.id
    for (const spec of nameable) {
      const formula = `linked(${spec.id})`
      choices.push({ id: formula, label: message('boundaryPanel.show.linked', { name: nameOf(spec) }), value: formula })
    }
    for (const spec of nameable) {
      if (spec.widget === undefined || !isComboWidgetInput(spec)) continue
      for (const option of normalizedComboOptions(spec.widget)) {
        const formula = `${spec.id} == ${formulaLiteral(option.value)}`
        choices.push({ id: formula, label: message('boundaryPanel.show.equals', { name: nameOf(spec), value: option.label }), value: formula })
      }
    }
    const stored = row.item.visible?.formula
    if (stored !== undefined && !choices.some((choice) => choice.value === stored)) {
      choices.push({ id: stored, label: message('boundaryPanel.show.formula', { formula: stored }), value: stored })
    }
    return { choices, unnamed: nameable.length < inputs.length }
  }

  /** A row's problem in the panel's words; other derivation messages lose their graph-id prefix. */
  const problemText = (d: Diagnostic): string => {
    if (d.code === 'boundary.visibleBroken') return message('boundaryPanel.problem.visibleBroken')
    if (d.code === 'boundary.limitsOutside') return message('boundaryPanel.problem.limitsOutside')
    if (d.code === 'boundary.limitsNotNumber') return message('boundaryPanel.problem.limitsNotNumber')
    return d.message.replace(/^\[[^\]]*\]\s*/u, '')
  }

  const Setting = (settingProps: { label: string; for?: string; children: JSX.Element }) => (
    <div class="boundary-tree-setting">
      <Show when={settingProps.for} fallback={<span class="boundary-tree-setting-label">{settingProps.label}</span>}>
        <label class="boundary-tree-setting-label" for={settingProps.for}>{settingProps.label}</label>
      </Show>
      <div class="boundary-tree-setting-value">{settingProps.children}</div>
    </div>
  )

  const DefaultEditor = (editorProps: { row: Row }) => {
    const row = () => editorProps.row
    const widget = () => {
      const spec = specOf(row())
      return spec?.kind === 'input' ? spec.widget : undefined
    }
    const value = () => defaultValue(row())
    const kind = () => row().item.binds.kind === 'port' ? widget()?.widgetType : undefined
    return (
      <Show when={kind() === 'INT' || kind() === 'FLOAT'} fallback={
        <Show when={kind() === 'STRING'} fallback={
          <Show when={kind() === 'COMBO'} fallback={
            <Show when={kind() === 'BOOLEAN'} fallback={
              <>
                <span class="boundary-default-text">{value() === undefined ? '' : typeof value() === 'string' ? value() as string : JSON.stringify(value())}</span>
                <ProductButton type="button" variant="ghost" size="compact" data-testid="boundary-default-show" onClick={() => showOnCanvas(row())}>
                  {message('boundaryPanel.default.showOnCanvas')}
                </ProductButton>
              </>
            }>
              <ProductCheckbox
                testId="boundary-default-input"
                ariaLabel={message('boundaryPanel.default')}
                checked={value() === true}
                disabled={editingDisabled()}
                onChange={(checked) => setDefault(row(), checked)}
              />
            </Show>
          }>
            <ProductSelect
              testId="boundary-default-input"
              ariaLabel={message('boundaryPanel.default')}
              options={normalizedComboOptions(widget()!).map((option) => ({ id: String(option.value), label: option.label, value: option.value }))}
              selectedId={String(value())}
              disabled={editingDisabled()}
              onSelect={(option) => setDefault(row(), option.value)}
            />
          </Show>
        }>
          <UiTextInput
            density="panel"
            data-testid="boundary-default-input"
            aria-label={message('boundaryPanel.default')}
            value={drafts()[`default:${row().item.id}`] ?? (typeof value() === 'string' ? value() as string : '')}
            disabled={editingDisabled()}
            onInput={(event) => setDrafts((current) => ({ ...current, [`default:${row().item.id}`]: event.currentTarget.value }))}
            onChange={(event) => {
              clearDraft(`default:${row().item.id}`)
              setDefault(row(), event.currentTarget.value)
            }}
          />
        </Show>
      }>
        <ProductNumberInput
          class="boundary-default-number"
          testId="boundary-default-input"
          ariaLabel={message('boundaryPanel.default')}
          inputMode={kind() === 'INT' ? 'numeric' : 'decimal'}
          integer={kind() === 'INT'}
          min={typeof widget()?.options['min'] === 'number' ? widget()!.options['min'] as number : undefined}
          max={typeof widget()?.options['max'] === 'number' ? widget()!.options['max'] as number : undefined}
          step={typeof widget()?.options['step'] === 'number' ? widget()!.options['step'] as number : undefined}
          value={typeof value() === 'number' ? value() as number : ''}
          disabled={editingDisabled()}
          onCommit={(raw) => {
            const parsed = Number(raw.trim())
            if (raw.trim() !== '' && Number.isFinite(parsed)) setDefault(row(), parsed)
          }}
        />
        <span class="boundary-quiet">{message('boundaryPanel.default.hint')}</span>
      </Show>
    )
  }

  const RegionRoles = (rolesProps: { row: Row; region: RegionContract }) => {
    const row = () => rolesProps.row
    const item = () => rolesProps.row.item
    const region = () => rolesProps.region
    return (
      <Show
        when={row().side === 'inputs'}
        fallback={
          <div role="group" class="region-role-controls" data-tooltip-session="region-output-role" aria-label={`Output ${itemName(row())} role`}>
            <For each={['gather', 'compact', 'flatten'] as const}>
              {(role) => (
                <button
                  type="button"
                  class="boundary-button"
                  data-region-output={item().id}
                  data-role-choice={role}
                  data-tooltip-label={message('boundary.region.output.explanation', {
                    role: outputRoleTitle(role),
                    explanation: outputRoleExplanation(role),
                  })}
                  data-tooltip-detail={message('boundary.region.output.occurrenceOnly')}
                  aria-label={`Set output ${itemName(row())} role to ${role}`}
                  aria-pressed={roleOf(row().side, item(), region()) === role}
                  disabled={editingDisabled()}
                  onClick={() => regionDispatch('region.setOutputRole', { outputId: item().id, role })}
                >
                  {role}
                </button>
              )}
            </For>
            <For each={region().statePorts ?? []}>
              {(statePort) => (
                <button
                  type="button"
                  class="boundary-button"
                  data-region-output={item().id}
                  data-state-port={statePort}
                  data-tooltip-label={message('boundary.region.output.state', { statePort })}
                  data-tooltip-detail={message('boundary.region.output.occurrenceOnly')}
                  aria-label={`Set output ${itemName(row())} role to state ${statePort}`}
                  aria-pressed={statePortOf(item(), region()) === statePort}
                  disabled={editingDisabled()}
                  onClick={() => regionDispatch('region.setOutputRole', { outputId: item().id, role: 'state', statePort })}
                >
                  state: {statePort}
                </button>
              )}
            </For>
            <button
              type="button"
              class="boundary-button"
              data-region-output={item().id}
              data-role-choice="continue"
              data-tooltip-label={message('boundary.region.output.continuation')}
              data-tooltip-detail={message('boundary.region.output.occurrenceOnly')}
              aria-label={`Use output ${item().displayName ?? item().id} as continuation`}
              aria-pressed={region().continueOutput === item().id}
              disabled={editingDisabled()}
              onClick={() => regionDispatch('region.setContinueOutput', {
                ...(region().continueOutput === item().id ? {} : { outputId: item().id }),
              })}
            >
              continuation
            </button>
          </div>
        }
      >
        <div role="group" class="region-role-controls" aria-label={`Input ${item().displayName ?? item().id} role`}>
          <For each={[
            ['element', 'Element'],
            ['state', 'State'],
            ['broadcast', 'Capture'],
          ] as const}>
            {([role, label]) => (
              <button
                type="button"
                class="boundary-button"
                data-region-input={item().id}
                data-role-choice={role === 'broadcast' ? 'capture' : role}
                aria-label={`Set input ${item().displayName ?? item().id} role to ${label.toLowerCase()}`}
                aria-pressed={roleOf(row().side, item(), region()) === label.toLowerCase()}
                disabled={editingDisabled()}
                onClick={() => regionDispatch('region.setPortRole', { side: 'input', portId: item().id, role })}
              >
                {label}
              </button>
            )}
          </For>
        </div>
      </Show>
    )
  }

  /** A text setting that commits on Enter, change or blur, and puts the stored text back on Escape. */
  const TextSetting = (textProps: {
    id: string
    testId: string
    draftKey: string
    stored: string
    placeholder?: string
    commit: (value: string) => void
  }) => (
    <UiTextInput
      density="panel"
      id={textProps.id}
      data-testid={textProps.testId}
      placeholder={textProps.placeholder}
      value={drafts()[textProps.draftKey] ?? textProps.stored}
      disabled={editingDisabled()}
      onInput={(event) => setDrafts((current) => ({ ...current, [textProps.draftKey]: event.currentTarget.value }))}
      onChange={(event) => textProps.commit(event.currentTarget.value)}
      onBlur={(event) => textProps.commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          clearDraft(textProps.draftKey)
          event.currentTarget.value = textProps.stored
          event.currentTarget.blur()
        }
      }}
    />
  )

  const Settings = (settingsProps: { row: Row }) => {
    const row = () => settingsProps.row
    const id = () => row().item.id
    const construct = () => row().item.binds.kind === 'construct'
    const kindLabel = () => construct() ? constructKind(row())
      : row().side === 'outputs' ? message('boundaryPanel.kind.output')
        : isField(row()) ? message('boundaryPanel.kind.field') : message('boundaryPanel.kind.pin')
    const range = () => innerRange(row())
    const formatBound = (value: number | undefined, fallback: string): string => value === undefined ? fallback : String(value)
    const show = () => showChoices(row())
    const ownRow = () => {
      const found = locate(body(), id())
      return found?.entry.kind === 'output' && found.entry.ownRow === true
    }
    return (
      <div class="boundary-tree-settings" data-testid="boundary-settings" data-boundary-id={id()} role="group" aria-label={message('boundaryPanel.aria.settings', { name: itemName(row()) })}>
        <div class="boundary-tree-settings-head">
          <span class="boundary-tree-panel-title">{itemName(row())}</span>
          <span class="boundary-tree-quiet">{kindLabel()}</span>
        </div>
        <For each={diagsFor(row().item)}>
          {(d) => (
            <div class="boundary-tree-problem" data-testid="boundary-diag" data-code={d.code} role="alert">
              <ProductIcon icon={TriangleAlert} />
              <span>{problemText(d)}</span>
              <Show when={d.code === 'boundary.limitsNotNumber'}>
                <UiButton
                  type="button"
                  density="panel"
                  data-testid="boundary-clear-limits"
                  disabled={editingDisabled()}
                  onClick={() => void dispatch('boundary.setLimits', { itemId: id(), min: null, max: null }, rowKey(row()))}
                >
                  {message('boundaryPanel.problem.clearLimits')}
                </UiButton>
              </Show>
            </div>
          )}
        </For>
        <Show when={notice()?.key === rowKey(row())}>
          <p class="boundary-message" data-tone="notice" data-testid="boundary-notice" role="status">{notice()!.text}</p>
        </Show>
        <Setting label={message('boundaryPanel.label')} for={`boundary-label-${id()}`}>
          <TextSetting
            id={`boundary-label-${id()}`}
            testId="boundary-name-input"
            draftKey={`name:${id()}`}
            stored={row().item.displayName ?? ''}
            placeholder={defaultItemName(row())}
            commit={(value) => void commitText(row(), 'name', value)}
          />
        </Setting>
        <Show when={!construct()}>
          <Setting label={message('boundaryPanel.help')} for={`boundary-help-${id()}`}>
            <TextSetting
              id={`boundary-help-${id()}`}
              testId="boundary-help-input"
              draftKey={`help:${id()}`}
              stored={row().item.tooltip ?? ''}
              placeholder={message('boundaryPanel.help.placeholder')}
              commit={(value) => void commitText(row(), 'help', value)}
            />
          </Setting>
        </Show>
        <Setting label={row().side === 'outputs' ? message('boundaryPanel.from') : message('boundaryPanel.goesTo')}>
          <Show when={destination(row())} fallback={<span>{message('boundaryPanel.unbound')}</span>}>
            {(text) => (
              <ProductLink
                href="#"
                data-testid="boundary-show-on-canvas"
                aria-label={context()?.outsideNode !== undefined
                  ? message('boundaryPanel.goesTo.open', { destination: text() })
                  : message('boundaryPanel.goesTo.show', { destination: text() })}
                onClick={(event) => {
                  event.preventDefault()
                  showOnCanvas(row())
                }}
              >
                {text()}
              </ProductLink>
            )}
          </Show>
        </Setting>
        <Show when={isField(row())}>
          <Setting label={message('boundaryPanel.default')}>
            <DefaultEditor row={row()} />
          </Setting>
        </Show>
        <Show when={range()}>
          {(inner) => (
            <Setting label={message('boundaryPanel.limits')}>
              <ProductNumberInput
                class="boundary-limit"
                testId="boundary-limit-min"
                inputMode="decimal"
                ariaLabel={message('boundaryPanel.limits.lowest')}
                value={row().item.limits?.min ?? ''}
                disabled={editingDisabled()}
                onCommit={(raw) => setLimit(row(), 'min', raw)}
              />
              <span class="boundary-tree-quiet">{message('boundaryPanel.limits.to')}</span>
              <ProductNumberInput
                class="boundary-limit"
                testId="boundary-limit-max"
                inputMode="decimal"
                ariaLabel={message('boundaryPanel.limits.highest')}
                value={row().item.limits?.max ?? ''}
                disabled={editingDisabled()}
                onCommit={(raw) => setLimit(row(), 'max', raw)}
              />
              <span class="boundary-tree-quiet boundary-limits-inside">{message('boundaryPanel.limits.inside', {
                min: formatBound(inner().min, message('boundaryPanel.limits.noLowest')),
                max: formatBound(inner().max, message('boundaryPanel.limits.noHighest')),
              })}</span>
            </Setting>
          )}
        </Show>
        <Show when={row().side === 'inputs' && !construct()}>
          <Setting label={message('boundaryPanel.show')}>
            <ProductSelect
              class="boundary-show-select"
              testId="boundary-show-select"
              ariaLabel={message('boundaryPanel.show')}
              options={show().choices}
              selectedId={row().item.visible?.formula ?? 'always'}
              disabled={editingDisabled()}
              onSelect={(option) => void dispatch('boundary.setVisible', { itemId: id(), formula: option.value }, rowKey(row()))}
            />
            <Show when={show().unnamed}>
              <span class="boundary-tree-quiet" data-testid="boundary-show-unnamed">{message('boundaryPanel.show.unnamed')}</span>
            </Show>
          </Setting>
        </Show>
        <Show when={row().side === 'inputs' && !isField(row()) && specOf(row())?.kind === 'input'}>
          <Setting label={message('boundaryPanel.empty')}>
            <span data-testid="boundary-empty-rule">{(specOf(row()) as InputSpec).optional
              ? message('boundaryPanel.empty.optional')
              : message('boundaryPanel.empty.required')}</span>
          </Setting>
        </Show>
        <Show when={regionCtx()}>
          {(ctx) => (
            <Setting label={message('boundaryPanel.role')}>
              <RegionRoles row={row()} region={ctx().region} />
            </Setting>
          )}
        </Show>
        <Show when={row().side === 'outputs' && !construct()}>
          <UiCheckbox
            label={message('boundaryPanel.ownRow')}
            data-testid="boundary-own-row"
            checked={ownRow()}
            disabled={editingDisabled()}
            onChange={(event) => void arrange(setOwnRow(body(), id(), event.currentTarget.checked))}
          />
        </Show>
        <Show when={removable(row())}>
          <Show when={confirmingRemove() === id()} fallback={
            <div class="dinkster-actions boundary-tree-actions">
              <UiButton
                type="button"
                density="panel"
                intent="remove"
                data-testid="boundary-remove"
                disabled={editingDisabled()}
                onClick={() => setConfirmingRemove(id())}
              >
                <ProductIcon icon={Trash2} />
                {message('boundaryPanel.remove')}
              </UiButton>
            </div>
          }>
            <div class="boundary-remove-confirm" role="group" data-testid="boundary-remove-confirm">
              <span>{message('boundaryPanel.remove.question', { name: itemName(row()), count: usedIn() })}</span>
              <div class="dinkster-actions boundary-tree-actions">
                <UiButton type="button" density="panel" onClick={() => setConfirmingRemove(undefined)}>
                  {message('boundaryPanel.remove.cancel')}
                </UiButton>
                <UiButton type="button" density="panel" intent="remove" fill="solid" data-testid="boundary-remove-yes" disabled={editingDisabled()} onClick={() => void remove(row())}>
                  {message('boundaryPanel.remove.yes')}
                </UiButton>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    )
  }

  /** Changes one section's layout settings, or unboxes it with `undefined`, in one undo step. */
  const editSection = (id: string, change: (section: BoundarySectionEntry) => BoundarySectionEntry | undefined): Promise<boolean> =>
    arrange(changeSection(body(), id, change))

  const commitSectionName = async (section: BoundarySectionEntry, value: string): Promise<void> => {
    if (editingDisabled()) return
    const key = `section:${section.id}`
    const name = value.trim()
    if (name === (section.displayName ?? '')) {
      clearDraft(key)
      return
    }
    const owner = lifetime
    setDrafts((current) => ({ ...current, [key]: value }))
    const accepted = await editSection(section.id, (current) => {
      const { displayName: _displayName, ...rest } = current
      return name === '' ? rest : { ...rest, displayName: name }
    })
    if (accepted && lifetime === owner && drafts()[key] === value) clearDraft(key)
  }

  const SectionSettings = (sectionProps: { section: BoundarySectionEntry }) => {
    const section = () => sectionProps.section
    const flag = (field: 'openName' | 'collapsedByDefault', on: boolean) => void editSection(section().id, (current) => {
      const { [field]: _field, ...rest } = current
      if (field === 'openName') return on ? rest : { ...rest, openName: false }
      return on ? { ...rest, collapsedByDefault: true } : rest
    })
    return (
      <div class="boundary-tree-settings" data-testid="boundary-settings" data-section-id={section().id} role="group" aria-label={message('boundaryPanel.aria.settings', { name: sectionName(section()) })}>
        <div class="boundary-tree-settings-head">
          <span class="boundary-tree-panel-title">{sectionName(section())}</span>
          <span class="boundary-tree-quiet">{message('boundaryPanel.kind.section')}</span>
        </div>
        <Setting label={message('boundaryPanel.section.name')} for={`boundary-section-name-${section().id}`}>
          <TextSetting
            id={`boundary-section-name-${section().id}`}
            testId="boundary-section-name"
            draftKey={`section:${section().id}`}
            stored={section().displayName ?? ''}
            placeholder={message('boundaryPanel.section.unnamed')}
            commit={(value) => void commitSectionName(section(), value)}
          />
        </Setting>
        <UiCheckbox
          label={message('boundaryPanel.section.showName')}
          data-testid="boundary-section-show-name"
          checked={section().openName !== false}
          disabled={editingDisabled()}
          onChange={(event) => flag('openName', event.currentTarget.checked)}
        />
        <UiCheckbox
          label={message('boundaryPanel.section.startClosed')}
          data-testid="boundary-section-start-closed"
          checked={section().collapsedByDefault === true}
          disabled={editingDisabled()}
          onChange={(event) => flag('collapsedByDefault', event.currentTarget.checked)}
        />
        <div class="dinkster-actions boundary-tree-actions">
          <span class="boundary-tree-quiet">{message('boundaryPanel.section.keepsRows')}</span>
          <UiButton
            type="button"
            density="panel"
            intent="remove"
            data-testid="boundary-section-remove"
            disabled={editingDisabled()}
            onClick={() => void editSection(section().id, () => undefined)}
          >
            <ProductIcon icon={Trash2} />
            {message('boundaryPanel.section.remove')}
          </UiButton>
        </div>
      </div>
    )
  }

  /** A new section at the end of the top level, selected so it can be named. */
  const newSection = async (): Promise<void> => {
    const added = addSection(body(), message('boundaryPanel.section.unnamed'))
    if (await arrange(added.body)) selectKey(sectionKey(added.id))
  }

  const AddSection = () => (
    <div class="dinkster-actions boundary-tree-actions">
      <UiButton type="button" density="panel" intent="add" data-testid="boundary-add-section" disabled={editingDisabled()} onClick={() => void newSection()}>
        <ProductIcon icon={Plus} />
        {message('boundaryPanel.section.add')}
      </UiButton>
    </div>
  )

  return (
    <Show when={context()} fallback={
      <section class="rail-section boundary-panel" data-testid="boundary-panel" role="region" aria-label={message('boundaryPanel.aria.editor')}>
        <h2>{message('shell.panel.boundary.title')}</h2>
        <ProductEmptyState
          testId="boundary-prompt"
          title={message('boundaryPanel.empty.title')}
          hint={message('boundaryPanel.empty.hint')}
          action={availableDefinitions().length > 0 ? <For each={availableDefinitions()}>
            {(entry) => <ProductButton type="button" onClick={() => pushGraph(entry.tab, entry.def.id, entry.nodeId)}>
              {message('boundaryPanel.empty.open', { name: entry.def.name })}
            </ProductButton>}
          </For> : undefined}
        />
      </section>
    }>
      {(ctx) => (
        <section
          class="rail-section boundary-panel"
          data-testid="boundary-panel"
          data-outside={ctx().outsideNode !== undefined ? 'true' : undefined}
          role="region"
          aria-label={message('boundaryPanel.aria.editor')}
          aria-busy={pending() !== undefined}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            const target = event.target as HTMLElement
            if (!target.matches('button, input')) return
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.focus()
          }}
        >
          <h2>{message('shell.panel.boundary.title')}</h2>
          <header class="boundary-head">
            <span class="boundary-title" data-testid="boundary-title">{ctx().def.name}</span>
            <span class="boundary-quiet" data-testid="boundary-used-in">{message('boundaryPanel.usedIn', { count: usedIn() })}</span>
            <Show when={frozen()}>
              <span class="boundary-state-badge" data-tone="frozen">{message('boundaryPanel.readOnly')}</span>
            </Show>
          </header>
          <Show when={frozen()}>
            <p class="boundary-frozen" data-testid="boundary-frozen" role="status">{message('boundaryPanel.frozen')}</p>
          </Show>
          <Show when={regionCtx()}>
            {(region) => (
              <div
                class="region-panel"
                data-testid="region-panel"
                role="group"
                aria-label={`${region().region.kind[0]!.toUpperCase()}${region().region.kind.slice(1)} region settings`}
              >
                <div class="boundary-section-heading">
                  <div>
                    <p class="boundary-eyebrow">Occurrence settings</p>
                    <h3>{region().region.kind} region</h3>
                  </div>
                  <span class="boundary-state-badge">{region().region.binding ?? 'zip'}</span>
                </div>
                <div class="region-control" role="group" aria-label="Region binding">
                  <span class="region-control-label">Binding</span>
                  <For each={['zip', 'cross', 'broadcast'] as const}>
                    {(binding) => (
                      <button
                        type="button"
                        class="boundary-button"
                        data-region-binding={binding}
                        aria-label={`Set binding to ${binding}`}
                        aria-pressed={(region().region.binding ?? 'zip') === binding}
                        disabled={editingDisabled()}
                        onClick={() => regionDispatch('region.setBinding', { binding })}
                      >
                        {binding}
                      </button>
                    )}
                  </For>
                </div>
                <div class="region-control" role="group" aria-label="Maximum iterations">
                  <label class="region-control-label" for="region-max-iterations">Maximum iterations</label>
                  <ProductNumberInput
                    id="region-max-iterations"
                    testId="region-max-iterations"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    ariaLabel="Maximum iterations"
                    disabled={editingDisabled()}
                    value={region().region.maxIterations ?? ''}
                    onCommit={(raw) => {
                      const value = raw.trim()
                      regionDispatch('region.setMaxIterations', {
                        maxIterations: value === '' ? null : Number(value),
                      })
                    }}
                  />
                </div>
                <Show when={notice()?.key === 'region'}>
                  <p class="boundary-message" data-tone="notice" data-testid="region-notice" role="status">{notice()!.text}</p>
                </Show>
              </div>
            )}
          </Show>
          <div class="boundary-rows-heading">{message('boundaryPanel.rows')}</div>
          <Show
            when={body().length > 0}
            fallback={
              <div class="boundary-tree-empty" data-testid="boundary-empty" role="status">
                <span>{message('boundaryPanel.empty.rows')}</span>
                <AddSection />
              </div>
            }
          >
            <div class="boundary-rows" ref={(element) => { treeElement = element }} onKeyDown={onTreeKey}>
              <BoundaryTree
                entries={treeEntries()}
                selected={selectedKey()}
                drag={drag()}
                onSelect={selectKey}
                onDragStart={startDrag}
                onToggle={toggleSection}
                strings={{
                  rows: message('boundaryPanel.aria.rows'),
                  move: message('boundaryPanel.tree.move'),
                  open: message('boundaryPanel.tree.open'),
                  close: message('boundaryPanel.tree.close'),
                  condition: message('boundaryPanel.mark.condition'),
                  problem: message('boundaryPanel.mark.problem'),
                  closedRows: (count: number) => message('boundaryPanel.tree.closedRows', { count }),
                }}
              />
            </div>
            <Show when={notice()?.key === 'layout'}>
              <p class="boundary-message" data-tone="notice" data-testid="boundary-notice" role="status">{notice()!.text}</p>
            </Show>
            <AddSection />
          </Show>
          <div class="boundary-settings-area" data-testid="boundary-settings-area">
            <Show when={selected()} fallback={
              <Show when={selectedSection()} fallback={
                <div class="boundary-tree-settings">
                  <p class="boundary-tree-quiet" data-testid="boundary-pick">{message('boundaryPanel.pick')}</p>
                </div>
              }>
                {(section) => <SectionSettings section={section()} />}
              </Show>
            }>
              {(row) => <Settings row={row()} />}
            </Show>
          </div>
        </section>
      )}
    </Show>
  )
}
