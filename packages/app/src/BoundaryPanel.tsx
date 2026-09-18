/**
 * Boundary exposure editor (hazard F10): shown while a tab is editing a
 * subgraph DEFINITION, one entry per boundary item.
 *
 * Forwarded families get the exposure tree: a mirror of the family's
 * template where each slot is whole / narrowed / excluded. All document
 * writes go through boundary.setSlots / boundary.clearSlots (undoable,
 * serializable); the tree's state is always derived FROM the document -
 * there is no local selection mirror to fall out of sync.
 *
 * Invalid configurations are unrepresentable at the source: toggles come
 * from toggleSlotSelection, which never emits a whole-subtree entry
 * alongside a narrowed descendant and refuses to empty a pinned selection
 * (the refusal surfaces as an inline notice). Template-aware problems the
 * editor cannot rule out structurally (starvation of a required socket-only
 * slot) come back from deriveBoundarySchema and render inline on the item.
 */

import { createEffect, createSignal as createSolidSignal, For, Index, onCleanup, Show } from 'solid-js'
import {
  defaultBoundaryLabels,
  deriveBoundarySchema,
  documentResolver,
  exposureAt,
  inputsOf,
  outputsOf,
  parseSelection,
  resolveBoundaryRoute,
  toggleSlotSelection,
  type BoundaryItem,
  type Diagnostic,
  type GraphDef,
  type InputSpec,
  type JsonObject,
  type RegionContract,
  type SelectionTree,
} from '@dinkster/core'
import { ProductCheckbox } from './ProductControls.js'
import { useAppMessage } from './locale.js'
import { activateProblem } from './ProblemsPanel.js'
import {
  currentGraphId,
  editedSubgraphDefinition,
  occurrenceReferencesDefinition,
  viewInstancePath,
  type AppState,
  type Tab,
} from './app-state.js'
import { useSignal } from './solid-adapter.js'
import { ProductNumberInput } from './ProductNumberInput.js'

export function BoundaryPanel(props: { app: AppState }) {
  const message = useAppMessage()
  const tabs = useSignal(props.app.tabs)
  const activeTabId = useSignal(props.app.activeTabId)
  const backendsTick = useSignal(props.app.backendsTick)
  const tabTargets = useSignal(props.app.tabTargets)

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

  /** The subgraph definition being edited, or undefined (panel hidden). */
  const editedDef = (): { tab: Tab; def: GraphDef } | undefined => {
    docTick()
    const tab = activeTab()
    if (!tab) return undefined
    const def = editedSubgraphDefinition(tab)
    return def ? { tab, def } : undefined
  }

  const regionCtx = (): {
    tab: Tab
    parentGraphId: string
    occurrenceNodeId: string
    region: RegionContract
  } | undefined => {
    docTick()
    const tab = activeTab()
    if (!tab) return undefined
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

  /**
   * Boundary diagnostics for the edited definition, from the SAME derivation
   * the canvas uses. Matching an item by the quoted id in the message is a
   * stopgap until diagnostics carry structured targets.
   */
  const boundaryDerivation = () => {
    const ctx = editedDef()
    const reg = registry()
    if (!ctx || !reg) return undefined
    const resolve = documentResolver(ctx.tab.store.doc, reg.resolve)
    return deriveBoundarySchema(ctx.def, resolve, regionCtx()?.region)
  }

  const boundaryDiags = (): readonly Diagnostic[] =>
    (boundaryDerivation()?.diagnostics ?? []).filter((d) =>
      d.code.startsWith('boundary.'),
    )

  const diagsFor = (item: BoundaryItem): readonly Diagnostic[] =>
    boundaryDiags().filter((d) => d.message.includes(`'${item.id}'`))

  const defaultItemName = (side: 'inputs' | 'outputs', item: BoundaryItem): string => {
    const fallback = defaultBoundaryLabels(editedDef()?.def.boundary?.[side] ?? []).get(item.id) ?? 'Boundary'
    const schema = boundaryDerivation()?.schema
    if (schema === undefined) return fallback
    const spec = (side === 'inputs' ? inputsOf(schema) : outputsOf(schema)).find((candidate) => candidate.id === item.id)
    if (spec?.displayName !== undefined) return spec.displayName
    return fallback
  }

  const itemName = (side: 'inputs' | 'outputs', item: BoundaryItem): string =>
    item.displayName ?? defaultItemName(side, item)

  const conditionalKind = (item: BoundaryItem): 'dynamicCombo' | 'dynamicSlot' | undefined => {
    const ctx = editedDef()
    const reg = registry()
    const node = ctx?.def.nodes[item.binds.node]
    const schema = ctx && reg && node && documentResolver(ctx.tab.store.doc, reg.resolve)(node.type)
    const route = schema && resolveBoundaryRoute(schema, item.binds, 'input')
    const kind = route?.ok && route.route.terminal.kind === 'port' ? route.route.terminal.slot.dynamic?.kind : undefined
    return kind === 'dynamicCombo' || kind === 'dynamicSlot' ? kind : undefined
  }

  const setConditionalBinding = (item: BoundaryItem, bindingKind: 'port' | 'slot' | 'dynamicCombo'): void => {
    if (item.binds.kind === 'widgetTap') return
    dispatch('boundary.setBinding', { side: 'inputs', itemId: item.id, node: item.binds.node, port: item.binds.port,
      ...(item.binds.members !== undefined ? { members: [...item.binds.members] } : {}), bindingKind })
  }

  /** Template of the family an item forwards, resolved structurally. */
  const familyTemplate = (side: 'inputs' | 'outputs', item: BoundaryItem): readonly InputSpec[] | undefined => {
    const ctx = editedDef()
    const reg = registry()
    if (!ctx || !reg || item.binds.kind !== 'family') return undefined
    const node = ctx.def.nodes[item.binds.node]
    if (!node) return undefined
    const schema = documentResolver(ctx.tab.store.doc, reg.resolve)(node.type)
    if (!schema) return undefined
    const route = resolveBoundaryRoute(schema, item.binds, side === 'inputs' ? 'input' : 'output')
    if (!route.ok || route.route.terminal.kind !== 'family') return undefined
    return route.route.terminal.spec.template
  }

  // One inline notice at a time (e.g. "at least one slot must stay
  // exposed"), keyed to the item that provoked it; cleared by any
  // successful edit.
  const [notice, setNotice] = createSolidSignal<{ key: string; text: string } | undefined>(undefined)
  const [nameDrafts, setNameDrafts] = createSolidSignal<Record<string, string>>({})

  const itemKey = (side: string, item: BoundaryItem): string => `${side}:${item.id}`
  const clearNameDraft = (key: string): void => {
    setNameDrafts((current) => {
      const { [key]: _removed, ...remaining } = current
      return remaining
    })
  }

  const dispatch = (command: string, params: JsonObject): boolean => {
    const ctx = editedDef()
    if (!ctx) return false
    const outcome = props.app.dispatchTo(ctx.tab, {
      command,
      params: { graphId: ctx.def.id, ...params },
    })
    if (outcome.ok) setNotice(undefined)
    return outcome.ok
  }

  const regionDispatch = (command: string, params: JsonObject): boolean => {
    const ctx = regionCtx()
    if (!ctx) return false
    const outcome = props.app.dispatchTo(ctx.tab, {
      command,
      params: { graphId: ctx.parentGraphId, nodeId: ctx.occurrenceNodeId, ...params },
    })
    if (outcome.ok) setNotice(undefined)
    else if (outcome.diagnostics[0]) setNotice({ key: 'region', text: outcome.diagnostics[0].message })
    return outcome.ok
  }

  const roleOf = (side: 'inputs' | 'outputs', item: BoundaryItem, region: RegionContract): string => {
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

  const pin = (side: 'inputs' | 'outputs', item: BoundaryItem, template: readonly InputSpec[]): void => {
    // Pinning starts from an explicit FULL selection: same exposure as
    // absence today, but new template slots stay hidden until selected.
    dispatch('boundary.setSlots', { side, itemId: item.id, slots: template.map((s) => s.id) })
  }

  const unpin = (side: 'inputs' | 'outputs', item: BoundaryItem): void => {
    dispatch('boundary.clearSlots', { side, itemId: item.id })
  }

  const toggle = (
    side: 'inputs' | 'outputs',
    item: BoundaryItem,
    template: readonly InputSpec[],
    path: string,
  ): void => {
    const slots = item.binds.slots
    if (slots === undefined) return
    const result = toggleSlotSelection(template, slots, path)
    if (!result.ok) {
      setNotice({
        key: itemKey(side, item),
        text:
          result.reason === 'empty'
            ? 'At least one slot must stay exposed; unpin to expose the whole template.'
            : 'This selection cannot be edited (unrecognized slot path).',
      })
      return
    }
    dispatch('boundary.setSlots', { side, itemId: item.id, slots: result.entries })
  }

  const sideItemCache: Record<'inputs' | 'outputs', readonly BoundaryItem[]> = { inputs: [], outputs: [] }
  const sideItems = (side: 'inputs' | 'outputs'): readonly BoundaryItem[] => {
    const previous = new Map(sideItemCache[side].map((item) => [item.id, item]))
    const items = (editedDef()?.def.boundary?.[side] ?? []).map((item) => {
      const existing = previous.get(item.id)
      return existing !== undefined && JSON.stringify(existing) === JSON.stringify(item) ? existing : item
    })
    sideItemCache[side] = items
    return items
  }

  const rename = (side: 'inputs' | 'outputs', item: BoundaryItem, displayName: string): void => {
    dispatch('boundary.renameItem', { side, itemId: item.id, displayName: displayName.trim() })
  }

  const showOnCanvas = (item: BoundaryItem): void => {
    activateProblem(props.app, {
      severity: 'info',
      origin: 'schema',
      code: 'boundary.focus',
      message: `Show boundary binding '${item.id}' on canvas`,
      anchor: {
        port: {
          node: item.binds.node,
          port: item.binds.kind === 'widgetTap' ? item.binds.tap : item.binds.port,
        },
      },
    })
  }

  return (
    <Show when={editedDef()}>
      <section
        class="rail-section boundary-panel"
        data-testid="boundary-panel"
        role="region"
        aria-label="Boundary editor"
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
        <h2>Boundary</h2>
        <header class="boundary-intro">
          <div>
            <p class="boundary-eyebrow">Workflow interface</p>
            <p class="boundary-intro-copy">Define what this workflow receives, returns, and exposes.</p>
          </div>
          <Show when={frozen()}>
            <span class="boundary-state-badge" data-tone="frozen">Read only</span>
          </Show>
        </header>
        <Show when={frozen()}>
          <p class="boundary-frozen" data-testid="boundary-frozen" role="status">
            This execution snapshot is frozen. You can inspect bindings and show their nodes on the canvas, but editing is unavailable.
          </p>
        </Show>
        <Show when={regionCtx()}>
          {(ctx) => (
            <div
              class="region-panel"
              data-testid="region-panel"
              role="group"
              aria-label={`${ctx().region.kind[0]!.toUpperCase()}${ctx().region.kind.slice(1)} region settings`}
            >
              <div class="boundary-section-heading">
                <div>
                  <p class="boundary-eyebrow">Occurrence settings</p>
                  <h3>{ctx().region.kind} region</h3>
                </div>
                <span class="boundary-state-badge">{ctx().region.binding ?? 'zip'}</span>
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
                      aria-pressed={(ctx().region.binding ?? 'zip') === binding}
                      disabled={frozen()}
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
                  disabled={frozen()}
                  value={ctx().region.maxIterations ?? ''}
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
        <For each={['inputs', 'outputs'] as const}>
          {(side) => (
            <section class="boundary-side-section" data-boundary-side={side} aria-label={`Workflow ${side}`}>
              <div class="boundary-side-heading">
                <div>
                  <p class="boundary-eyebrow">{side === 'inputs' ? 'Into this workflow' : 'From this workflow'}</p>
                  <h3>{side}</h3>
                </div>
                <span class="boundary-count" aria-label={`${sideItems(side).length} ${side}`}>
                  {sideItems(side).length}
                </span>
              </div>
              <Show
                when={sideItems(side).length > 0}
                fallback={
                  <p class="boundary-empty" data-testid="boundary-empty" data-side={side} role="status">
                    No workflow {side} are exposed.
                  </p>
                }
              >
                <div class="boundary-items">
                  <For each={sideItems(side)}>
                    {(item) => (
                  <div
                    class="boundary-item"
                    data-testid="boundary-item"
                    data-boundary-id={item.id}
                    data-binding-kind={item.binds.kind}
                    role="group"
                    aria-label={`${side === 'inputs' ? 'Input' : 'Output'} ${itemName(side, item)}`}
                  >
                    <div class="boundary-head">
                      <div class="boundary-identity">
                        <span class="boundary-direction" aria-hidden="true">{side === 'inputs' ? 'IN' : 'OUT'}</span>
                        <span class="boundary-name">{itemName(side, item)}</span>
                      </div>
                      <div class="boundary-badges">
                        <Show when={regionCtx()}>
                          {(ctx) => (
                            <span class="boundary-role" data-region-role={roleOf(side, item, ctx().region)}>
                              {roleOf(side, item, ctx().region)}
                            </span>
                          )}
                        </Show>
                        <Show when={item.binds.kind === 'family'}>
                          <span class="boundary-kind">Nested slots</span>
                        </Show>
                        <Show when={item.binds.kind === 'widgetTap'}>
                          <span class="boundary-kind">Widget output</span>
                        </Show>
                      </div>
                    </div>
                    <label class="boundary-name-field">
                      <span class="boundary-field-label">Display name</span>
                      <input
                        type="text"
                        class="boundary-name-input"
                        data-testid="boundary-name-input"
                        aria-label={`${side === 'inputs' ? 'Input' : 'Output'} ${item.id} display name`}
                        placeholder={defaultItemName(side, item)}
                        value={nameDrafts()[itemKey(side, item)] ?? item.displayName ?? ''}
                        disabled={frozen()}
                        onInput={(event) => setNameDrafts((current) => ({
                          ...current,
                          [itemKey(side, item)]: event.currentTarget.value,
                        }))}
                        onChange={(event) => {
                          rename(side, item, event.currentTarget.value)
                          clearNameDraft(itemKey(side, item))
                        }}
                        onBlur={(event) => {
                          rename(side, item, event.currentTarget.value)
                          clearNameDraft(itemKey(side, item))
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            event.currentTarget.blur()
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            event.stopPropagation()
                            clearNameDraft(itemKey(side, item))
                            event.currentTarget.value = item.displayName ?? ''
                            event.currentTarget.blur()
                          }
                        }}
                      />
                    </label>
                    <div class="boundary-binding-row">
                      <div class="boundary-binding-copy">
                        <span class="boundary-field-label">Canvas destination</span>
                        <code class="boundary-bind">
                          {item.binds.node}.{item.binds.kind === 'widgetTap' ? item.binds.tap : item.binds.port}
                        </code>
                      </div>
                      <button
                        type="button"
                        class="boundary-focus-action"
                        data-testid="boundary-show-on-canvas"
                        aria-label={`Show ${itemName(side, item)} destination on canvas`}
                        onClick={() => showOnCanvas(item)}
                      >
                        Show
                      </button>
                    </div>
                    <Show when={regionCtx()}>
                      {(ctx) => (
                        <Show
                          when={side === 'inputs'}
                          fallback={
                            <div role="group" class="region-role-controls" data-tooltip-session="region-output-role" aria-label={`Output ${itemName(side, item)} role`}>
                              <For each={['gather', 'compact', 'flatten'] as const}>
                                {(role) => (
                                  <button
                                    type="button"
                                    class="boundary-button"
                                    data-region-output={item.id}
                                    data-role-choice={role}
                                    data-tooltip-label={message('boundary.region.output.explanation', {
                                      role: outputRoleTitle(role),
                                      explanation: outputRoleExplanation(role),
                                    })}
                                    data-tooltip-detail={message('boundary.region.output.occurrenceOnly')}
                                    aria-label={`Set output ${itemName(side, item)} role to ${role}`}
                                    aria-pressed={roleOf(side, item, ctx().region) === role}
                                    disabled={frozen()}
                                    onClick={() => regionDispatch('region.setOutputRole', { outputId: item.id, role })}
                                  >
                                    {role}
                                  </button>
                                )}
                              </For>
                              <For each={ctx().region.statePorts ?? []}>
                                {(statePort) => (
                                  <button
                                    type="button"
                                    class="boundary-button"
                                    data-region-output={item.id}
                                    data-state-port={statePort}
                                    data-tooltip-label={message('boundary.region.output.state', { statePort })}
                                    data-tooltip-detail={message('boundary.region.output.occurrenceOnly')}
                                    aria-label={`Set output ${itemName(side, item)} role to state ${statePort}`}
                                    aria-pressed={statePortOf(item, ctx().region) === statePort}
                                    disabled={frozen()}
                                    onClick={() => regionDispatch('region.setOutputRole', { outputId: item.id, role: 'state', statePort })}
                                  >
                                    state: {statePort}
                                  </button>
                                )}
                              </For>
                              <button
                                type="button"
                                class="boundary-button"
                                data-region-output={item.id}
                                data-role-choice="continue"
                                data-tooltip-label={message('boundary.region.output.continuation')}
                                data-tooltip-detail={message('boundary.region.output.occurrenceOnly')}
                                aria-label={`Use output ${item.displayName ?? item.id} as continuation`}
                                aria-pressed={ctx().region.continueOutput === item.id}
                                disabled={frozen()}
                                onClick={() => regionDispatch('region.setContinueOutput', {
                                  ...(ctx().region.continueOutput === item.id ? {} : { outputId: item.id }),
                                })}
                              >
                                continuation
                              </button>
                            </div>
                          }
                        >
                          <div role="group" class="region-role-controls" aria-label={`Input ${item.displayName ?? item.id} role`}>
                            <For each={[
                              ['element', 'Element'],
                              ['state', 'State'],
                              ['broadcast', 'Capture'],
                            ] as const}>
                              {([role, label]) => (
                                <button
                                  type="button"
                                  class="boundary-button"
                                  data-region-input={item.id}
                                  data-role-choice={role === 'broadcast' ? 'capture' : role}
                                  aria-label={`Set input ${item.displayName ?? item.id} role to ${label.toLowerCase()}`}
                                  aria-pressed={roleOf(side, item, ctx().region) === label.toLowerCase()}
                                  disabled={frozen()}
                                  onClick={() => regionDispatch('region.setPortRole', {
                                    side: 'input', portId: item.id, role,
                                  })}
                                >
                                  {label}
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      )}
                    </Show>
                    <Show when={side === 'inputs' && conditionalKind(item) === 'dynamicCombo'}>
                      <p class="boundary-message" role="status">
                        {item.binds.kind === 'dynamicCombo' ? 'Full branch: inputs and values are independent on each instance.' : 'Selector only: branch inputs stay definition-owned.'}
                      </p>
                      <button type="button" class="boundary-button" disabled={frozen()}
                        aria-label={`${item.binds.kind === 'dynamicCombo' ? 'Use selector only for' : 'Upgrade to full branch for'} ${itemName(side, item)}`}
                        onClick={() => setConditionalBinding(item, item.binds.kind === 'dynamicCombo' ? 'port' : 'dynamicCombo')}>
                        {item.binds.kind === 'dynamicCombo' ? 'Use selector only' : 'Upgrade to full branch'}
                      </button>
                    </Show>
                    <Show when={side === 'inputs' && conditionalKind(item) === 'dynamicSlot'}>
                      <p class="boundary-message" role="status">
                        {item.binds.kind === 'slot' ? 'Full slot: specialization and dependents are independent on each instance.' : 'Slot dependents are not forwarded.'}
                      </p>
                      <Show when={item.binds.kind !== 'slot'}>
                        <button type="button" class="boundary-button" disabled={frozen()}
                          aria-label={`Forward full slot for ${itemName(side, item)}`}
                          onClick={() => setConditionalBinding(item, 'slot')}>Forward full slot</button>
                      </Show>
                    </Show>
                    <Show when={item.binds.kind === 'family'}>
                      <Show
                        when={familyTemplate(side, item)}
                        fallback={
                          <p class="boundary-message" data-tone="unavailable" data-testid="boundary-unavailable" role="status">
                            <strong>Exposure unavailable.</strong> The nested slot template cannot be resolved from the current schema catalog.
                          </p>
                        }
                      >
                        {(template) => (
                          <div class="boundary-exposure">
                            <div class="boundary-pin-row">
                              <Show
                                when={item.binds.slots !== undefined}
                                fallback={
                                  <>
                                    <div class="boundary-mode-copy">
                                      <span class="boundary-state-badge" data-tone="tracking">Tracks template</span>
                                      <span class="boundary-mode">New nested slots are exposed automatically.</span>
                                    </div>
                                    <button
                                      type="button"
                                      class="boundary-button"
                                      data-testid="boundary-pin"
                                      disabled={frozen()}
                                      onClick={() => pin(side, item, template())}
                                    >
                                      Pin selection
                                    </button>
                                  </>
                                }
                              >
                                <div class="boundary-mode-copy">
                                  <span class="boundary-state-badge" data-tone="pinned">Pinned</span>
                                  <span class="boundary-mode">Only selected nested slots are exposed.</span>
                                </div>
                                <button
                                  type="button"
                                  class="boundary-button"
                                  data-testid="boundary-unpin"
                                  disabled={frozen()}
                                  onClick={() => unpin(side, item)}
                                >
                                  Track all slots
                                </button>
                              </Show>
                            </div>
                            <Show when={item.binds.slots}>
                              {(slots) => {
                                const tree = (): SelectionTree | undefined => {
                                  const parsed = parseSelection(slots())
                                  return 'error' in parsed ? undefined : parsed.tree
                                }
                                return (
                                  <Show
                                    when={tree()}
                                    fallback={
                                      <p class="boundary-message" data-tone="invalid" data-testid="boundary-invalid" role="alert">
                                        <strong>Invalid stored selection.</strong> Track all slots to reset this exposure safely.
                                      </p>
                                    }
                                  >
                                    {(t) => (
                                      <SlotTree
                                        template={template()}
                                        tree={t()}
                                        prefix=""
                                        disabled={frozen()}
                                        onToggle={(path) => toggle(side, item, template(), path)}
                                      />
                                    )}
                                  </Show>
                                )
                              }}
                            </Show>
                          </div>
                        )}
                      </Show>
                    </Show>
                    <Show when={notice()?.key === itemKey(side, item)}>
                      <p class="boundary-message" data-tone="notice" data-testid="boundary-notice" role="status">
                        {notice()!.text}
                      </p>
                    </Show>
                    <For each={diagsFor(item)}>
                      {(d) => (
                        <div class="boundary-message" data-tone="diagnostic" data-testid="boundary-diag" data-code={d.code} role="alert">
                          <span class="boundary-message-code">{d.code}</span>
                          <span>{d.message}</span>
                        </div>
                      )}
                    </For>
                  </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          )}
        </For>
      </section>
    </Show>
  )
}

/**
 * One level of the exposure tree. Checkbox state is derived from the
 * document's selection: checked = whole subtree, indeterminate = narrowed
 * (exposed only through selected descendants), unchecked = excluded.
 * Autogrow constructs expand to their nested template.
 */
function SlotTree(props: {
  template: readonly InputSpec[]
  tree: SelectionTree
  prefix: string
  disabled: boolean
  onToggle: (path: string) => void
}) {
  const pathOf = (slot: InputSpec): string =>
    props.prefix === '' ? slot.id : `${props.prefix}.${slot.id}`
  return (
    <ul class="slot-tree">
      <Index each={props.template as InputSpec[]}>
        {(slot) => {
          const path = () => pathOf(slot())
          const state = () => exposureAt(props.tree, path())
          const nested = (): readonly InputSpec[] | undefined =>
            slot().dynamic?.kind === 'autogrow'
              ? (slot().dynamic as { template: readonly InputSpec[] }).template
              : undefined
          return (
            <li class="slot-row">
              <label classList={{ 'slot-label': true, excluded: state() === 'excluded' }}>
                <ProductCheckbox
                  testId="slot-toggle"
                  dataAttributes={{ 'data-slot-path': path(), 'data-state': state() }}
                  ariaLabel={`Expose ${slot().displayName ?? slot().id}: ${state()}`}
                  checked={state() === 'narrowed' ? 'mixed' : state() === 'whole'}
                  disabled={props.disabled}
                  enterActivates
                  onChange={() => props.onToggle(path())}
                />
                <span class="slot-copy">
                  <span class="slot-id">{slot().displayName ?? slot().id}</span>
                  <code class="slot-path">{path()}</code>
                </span>
                <Show when={nested()}>
                  <span class="slot-kind">autogrow</span>
                </Show>
              </label>
              <Show when={nested()}>
                {(t) => (
                  <SlotTree
                    template={t()}
                    tree={props.tree}
                    prefix={path()}
                    disabled={props.disabled}
                    onToggle={props.onToggle}
                  />
                )}
              </Show>
            </li>
          )
        }}
      </Index>
    </ul>
  )
}
