/**
 * Boundary panel: the rows of one subgraph definition's node, in stored
 * order (inputs, then outputs), and the settings of the selected row in a
 * fixed area below them. It edits the definition being viewed, or, with no
 * subgraph open, the definition of the one subgraph node selected on the
 * canvas. Every setting is one command; problems deriveBoundarySchema
 * reports show on their row.
 */

import { createEffect, createSignal as createSolidSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { defaultTokens, typeColor } from '@dinkster/canvas'
import {
  boundaryConditionScope,
  boundaryInnerInput,
  canonicalTypeIdOf,
  defaultBoundaryLabels,
  deriveBoundarySchema,
  documentResolver,
  inputsOf,
  normalizedComboOptions,
  numberFieldRange,
  outputsOf,
  subgraphDefIdOf,
  type BoundaryBinding,
  type BoundaryItem,
  type Diagnostic,
  type GraphDef,
  type InputSpec,
  type Json,
  type JsonObject,
  type OutputSpec,
  type RegionContract,
} from '@dinkster/core'
import { ProductButton, ProductCheckbox, ProductTextInput } from './ProductControls.js'
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
  if (binding.kind !== 'port' && binding.kind !== 'slot' && binding.kind !== 'dynamicCombo') return undefined
  return {
    node: binding.node,
    port: binding.port,
    ...(binding.kind !== 'port' ? { bindingKind: binding.kind } : {}),
    ...(binding.members !== undefined ? { members: [...binding.members] } : {}),
    ...(binding.viaReroute !== undefined ? { viaReroute: binding.viaReroute } : {}),
  }
}

/** The type's color, as pins of that type are drawn on the canvas. */
const TypeDot = (dotProps: { typeId: string }): JSX.Element => (
  <span class="boundary-dot" style={{ background: typeColor(defaultTokens, dotProps.typeId) }} aria-hidden="true" />
)

const ConditionMark = (): JSX.Element => (
  <svg class="boundary-mark" data-mark="condition" width="13" height="12" viewBox="0 0 13 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M1 6c1.6-2.7 3.4-4 5.5-4s3.9 1.3 5.5 4c-1.6 2.7-3.4 4-5.5 4S2.6 8.7 1 6z" />
    <circle cx="6.5" cy="6" r="1.6" />
  </svg>
)

const ProblemMark = (): JSX.Element => (
  <svg class="boundary-mark" data-mark="problem" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M6 1.2l5 9.3H1z" />
    <path d="M6 4.8v2.7M6 9v.3" />
  </svg>
)

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

  const defaultItemName = (row: Row): string =>
    specOf(row)?.displayName
      ?? defaultBoundaryLabels(context()?.def.boundary?.[row.side] ?? []).get(row.item.id)
      ?? row.item.id

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

  const rowCache = new Map<string, Row>()
  /** Rows in stored order, reusing unchanged row objects so their DOM stays. */
  const rows = (): readonly Row[] => {
    const boundary = context()?.def.boundary
    const next = (['inputs', 'outputs'] as const).flatMap((side) => (boundary?.[side] ?? []).map((item): Row => {
      const existing = rowCache.get(item.id)
      return existing !== undefined && existing.side === side && JSON.stringify(existing.item) === JSON.stringify(item)
        ? existing
        : { side, item }
    }))
    rowCache.clear()
    for (const row of next) rowCache.set(row.item.id, row)
    return next
  }

  const selected = (): Row | undefined => {
    const ctx = context()
    const current = focus()
    if (!ctx || !current || current.tabId !== ctx.tab.id || current.graphId !== ctx.def.id) return undefined
    return rows().find((row) => row.item.id === current.item)
  }

  const select = (row: Row): void => {
    const ctx = context()
    if (!ctx) return
    props.app.boundaryFocus.set({ tabId: ctx.tab.id, graphId: ctx.def.id, item: row.item.id })
  }

  // The list scrolls to a row selected from elsewhere once per selection, so
  // rows re-created by a later edit never scroll it back.
  const rowElements = new Map<string, HTMLElement>()
  let scrolledFocus: object | undefined
  createEffect(() => {
    const current = focus()
    const row = selected()
    if (current === undefined || row === undefined || current === scrolledFocus) return
    scrolledFocus = current
    rowElements.get(row.item.id)?.scrollIntoView?.({ block: 'nearest' })
  })

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
      if (spec.widget?.widgetType !== 'COMBO') continue
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
    <div class="boundary-setting">
      <Show when={settingProps.for} fallback={<span class="boundary-setting-label">{settingProps.label}</span>}>
        <label class="boundary-setting-label" for={settingProps.for}>{settingProps.label}</label>
      </Show>
      <div class="boundary-setting-value">{settingProps.children}</div>
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
          <ProductTextInput
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

  const Settings = (settingsProps: { row: Row }) => {
    const row = () => settingsProps.row
    const id = () => row().item.id
    const kindLabel = () => row().side === 'outputs'
      ? message('boundaryPanel.kind.output')
      : isField(row()) ? message('boundaryPanel.kind.field') : message('boundaryPanel.kind.pin')
    const range = () => innerRange(row())
    const formatBound = (value: number | undefined, fallback: string): string => value === undefined ? fallback : String(value)
    const show = () => showChoices(row())
    return (
      <div class="boundary-settings" data-testid="boundary-settings" data-boundary-id={id()} role="group" aria-label={message('boundaryPanel.aria.settings', { name: itemName(row()) })}>
        <div class="boundary-settings-head">
          <TypeDot typeId={typeIdOf(row())} />
          <span class="boundary-settings-name">{itemName(row())}</span>
          <span class="boundary-quiet">{kindLabel()}</span>
        </div>
        <For each={diagsFor(row().item)}>
          {(d) => (
            <div class="boundary-message" data-tone="diagnostic" data-testid="boundary-diag" data-code={d.code} role="alert">
              <span>{problemText(d)}</span>
              <Show when={d.code === 'boundary.limitsNotNumber'}>
                <ProductButton
                  type="button"
                  size="compact"
                  data-testid="boundary-clear-limits"
                  disabled={editingDisabled()}
                  onClick={() => void dispatch('boundary.setLimits', { itemId: id(), min: null, max: null }, rowKey(row()))}
                >
                  {message('boundaryPanel.problem.clearLimits')}
                </ProductButton>
              </Show>
            </div>
          )}
        </For>
        <Show when={notice()?.key === rowKey(row())}>
          <p class="boundary-message" data-tone="notice" data-testid="boundary-notice" role="status">{notice()!.text}</p>
        </Show>
        <Setting label={message('boundaryPanel.label')} for={`boundary-label-${id()}`}>
          <ProductTextInput
            id={`boundary-label-${id()}`}
            data-testid="boundary-name-input"
            placeholder={defaultItemName(row())}
            value={drafts()[`name:${id()}`] ?? row().item.displayName ?? ''}
            disabled={editingDisabled()}
            onInput={(event) => setDrafts((current) => ({ ...current, [`name:${id()}`]: event.currentTarget.value }))}
            onChange={(event) => commitText(row(), 'name', event.currentTarget.value)}
            onBlur={(event) => commitText(row(), 'name', event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                clearDraft(`name:${id()}`)
                event.currentTarget.value = row().item.displayName ?? ''
                event.currentTarget.blur()
              }
            }}
          />
        </Setting>
        <Setting label={message('boundaryPanel.help')} for={`boundary-help-${id()}`}>
          <ProductTextInput
            id={`boundary-help-${id()}`}
            data-testid="boundary-help-input"
            placeholder={message('boundaryPanel.help.placeholder')}
            value={drafts()[`help:${id()}`] ?? row().item.tooltip ?? ''}
            disabled={editingDisabled()}
            onInput={(event) => setDrafts((current) => ({ ...current, [`help:${id()}`]: event.currentTarget.value }))}
            onChange={(event) => commitText(row(), 'help', event.currentTarget.value)}
            onBlur={(event) => commitText(row(), 'help', event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                clearDraft(`help:${id()}`)
                event.currentTarget.value = row().item.tooltip ?? ''
                event.currentTarget.blur()
              }
            }}
          />
        </Setting>
        <Setting label={row().side === 'outputs' ? message('boundaryPanel.from') : message('boundaryPanel.goesTo')}>
          <Show when={destination(row())} fallback={<span class="boundary-quiet">{message('boundaryPanel.unbound')}</span>}>
            {(text) => (
              <button
                type="button"
                class="boundary-link"
                data-testid="boundary-show-on-canvas"
                aria-label={context()?.outsideNode !== undefined
                  ? message('boundaryPanel.goesTo.open', { destination: text() })
                  : message('boundaryPanel.goesTo.show', { destination: text() })}
                onClick={() => showOnCanvas(row())}
              >
                {text()}
              </button>
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
              <span class="boundary-quiet">{message('boundaryPanel.limits.to')}</span>
              <ProductNumberInput
                class="boundary-limit"
                testId="boundary-limit-max"
                inputMode="decimal"
                ariaLabel={message('boundaryPanel.limits.highest')}
                value={row().item.limits?.max ?? ''}
                disabled={editingDisabled()}
                onCommit={(raw) => setLimit(row(), 'max', raw)}
              />
              <span class="boundary-quiet boundary-limits-inside">{message('boundaryPanel.limits.inside', {
                min: formatBound(inner().min, message('boundaryPanel.limits.noLowest')),
                max: formatBound(inner().max, message('boundaryPanel.limits.noHighest')),
              })}</span>
            </Setting>
          )}
        </Show>
        <Show when={row().side === 'inputs'}>
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
              <span class="boundary-quiet" data-testid="boundary-show-unnamed">{message('boundaryPanel.show.unnamed')}</span>
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
        <Show when={removable(row())}>
          <Show when={confirmingRemove() === id()} fallback={
            <ProductButton
              type="button"
              size="compact"
              class="boundary-remove"
              data-testid="boundary-remove"
              disabled={editingDisabled()}
              onClick={() => setConfirmingRemove(id())}
            >
              {message('boundaryPanel.remove')}
            </ProductButton>
          }>
            <div class="boundary-remove-confirm" role="group" data-testid="boundary-remove-confirm">
              <span>{message('boundaryPanel.remove.question', { name: itemName(row()), count: usedIn() })}</span>
              <div class="boundary-remove-actions">
                <ProductButton type="button" size="compact" variant="danger" data-testid="boundary-remove-yes" disabled={editingDisabled()} onClick={() => void remove(row())}>
                  {message('boundaryPanel.remove.yes')}
                </ProductButton>
                <ProductButton type="button" size="compact" variant="ghost" onClick={() => setConfirmingRemove(undefined)}>
                  {message('boundaryPanel.remove.cancel')}
                </ProductButton>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    )
  }

  const moveSelection = (delta: -1 | 1): void => {
    const list = rows()
    if (list.length === 0) return
    const index = list.findIndex((row) => row === selected())
    const next = list[index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + delta))]!
    select(next)
    rowElements.get(next.item.id)?.focus()
  }

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
            when={rows().length > 0}
            fallback={
              <div data-testid="boundary-empty" role="status">
                <ProductEmptyState title={message('boundaryPanel.empty.rows')} hint={message('boundaryPanel.empty.rowsHint')} />
              </div>
            }
          >
            <div
              class="boundary-rows"
              role="listbox"
              aria-label={message('boundaryPanel.aria.rows')}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                moveSelection(event.key === 'ArrowDown' ? 1 : -1)
              }}
            >
              <For each={rows()}>
                {(row) => {
                  onCleanup(() => rowElements.delete(row.item.id))
                  const marks = () => (
                    <>
                      <Show when={row.item.visible !== undefined}>
                        <span class="boundary-mark-slot" title={message('boundaryPanel.mark.condition')}><ConditionMark /></span>
                      </Show>
                      <Show when={diagsFor(row.item).length > 0}>
                        <span class="boundary-mark-slot" title={message('boundaryPanel.mark.problem')}><ProblemMark /></span>
                      </Show>
                    </>
                  )
                  const dot = () => <TypeDot typeId={typeIdOf(row)} />
                  return (
                    <button
                      ref={(element) => rowElements.set(row.item.id, element)}
                      type="button"
                      class="boundary-row"
                      data-testid="boundary-item"
                      data-boundary-id={row.item.id}
                      data-binding-kind={row.item.binds.kind}
                      data-side={row.side}
                      data-problem={diagsFor(row.item).length > 0 ? 'true' : undefined}
                      role="option"
                      aria-selected={selected() === row}
                      tabIndex={selected() === row || (selected() === undefined && rows()[0] === row) ? 0 : -1}
                      onClick={() => select(row)}
                    >
                      <Show when={row.side === 'outputs'} fallback={
                        <>
                          {dot()}
                          <span class="boundary-row-label">{itemName(row)}</span>
                          {marks()}
                          <span class="boundary-row-node">{quietNodeName(row)}</span>
                        </>
                      }>
                        <span class="boundary-row-node" data-align="start">{quietNodeName(row)}</span>
                        {marks()}
                        <span class="boundary-row-label">{itemName(row)}</span>
                        {dot()}
                      </Show>
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>
          <div class="boundary-settings-area" data-testid="boundary-settings-area">
            <Show when={selected()} fallback={<p class="boundary-quiet" data-testid="boundary-pick">{message('boundaryPanel.pick')}</p>}>
              {(row) => <Settings row={row()} />}
            </Show>
          </div>
        </section>
      )}
    </Show>
  )
}
