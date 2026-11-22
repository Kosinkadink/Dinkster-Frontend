/**
 * Boundary editor: shown while a tab is editing a subgraph DEFINITION, one
 * entry per boundary item, with its name, binding and region role. Problems
 * deriveBoundarySchema reports (such as an unresolved forward) render inline
 * on the item.
 */

import { createEffect, createSignal as createSolidSignal, For, onCleanup, Show } from 'solid-js'
import {
  defaultBoundaryLabels,
  deriveBoundarySchema,
  documentResolver,
  inputsOf,
  outputsOf,
  subgraphDefIdOf,
  type BoundaryItem,
  type Diagnostic,
  type GraphDef,
  type JsonObject,
  type RegionContract,
} from '@dinkster/core'
import { ProductButton } from './ProductControls.js'
import { ProductEmptyState } from './ProductSurfaces.js'
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

  /** The subgraph definition being edited, or undefined (show the prompt). */
  const editedDef = (): { tab: Tab; def: GraphDef } | undefined => {
    docTick()
    const tab = activeTab()
    if (!tab) return undefined
    const def = editedSubgraphDefinition(tab)
    return def ? { tab, def } : undefined
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
   * the canvas uses. Prefer structured targets; messages without refs still
   * identify their boundary item with a quoted id.
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
    boundaryDiags().filter((d) => d.refs?.some((ref) => ref.portId === item.id) ?? d.message.includes(`'${item.id}'`))

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

  // One inline notice at a time, keyed to the item whose edit the command
  // refused; cleared by any successful edit.
  const [notice, setNotice] = createSolidSignal<{ key: string; text: string } | undefined>(undefined)
  const [nameDrafts, setNameDrafts] = createSolidSignal<Record<string, string>>({})
  const [pending, setPending] = createSolidSignal<object | undefined>(undefined)
  let lifetime = {}
  createEffect(() => {
    const tab = activeTab()
    const reset = () => {
      lifetime = {}
      setPending(undefined)
      setNotice(undefined)
      setNameDrafts({})
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

  const itemKey = (side: string, item: BoundaryItem): string => `${side}:${item.id}`
  const clearNameDraft = (key: string): void => {
    setNameDrafts((current) => {
      const { [key]: _removed, ...remaining } = current
      return remaining
    })
  }

  const dispatch = async (command: string, params: JsonObject, region = false): Promise<boolean> => {
    const ctx = editedDef()
    const occurrence = region ? regionCtx() : undefined
    if (!ctx || editingDisabled() || (region && !occurrence)) return false
    const owner = lifetime
    const store = ctx.tab.store
    const request = {}
    setPending(request)
    try {
      const outcome = await props.app.dispatchTo(ctx.tab, {
        command,
        params: occurrence
          ? { graphId: occurrence.parentGraphId, nodeId: occurrence.occurrenceNodeId, ...params }
          : { graphId: ctx.def.id, ...params },
      })
      if (lifetime !== owner || activeTab() !== ctx.tab || ctx.tab.store !== store) return false
      if (outcome.ok) setNotice(undefined)
      else if (outcome.diagnostics[0]) setNotice({
        key: region ? 'region' : `${params.side}:${params.itemId}`,
        text: outcome.diagnostics[0].message,
      })
      return outcome.ok
    } finally {
      if (pending() === request) setPending(undefined)
    }
  }

  const regionDispatch = (command: string, params: JsonObject): Promise<boolean> =>
    dispatch(command, params, true)

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

  const rename = async (side: 'inputs' | 'outputs', item: BoundaryItem, displayName: string): Promise<void> => {
    if (editingDisabled()) return
    const key = itemKey(side, item)
    if (displayName.trim() === (item.displayName ?? '')) {
      clearNameDraft(key)
      return
    }
    const owner = lifetime
    setNameDrafts((current) => ({ ...current, [key]: displayName }))
    const accepted = await dispatch('boundary.renameItem', { side, itemId: item.id, displayName: displayName.trim() })
    if (accepted && lifetime === owner && nameDrafts()[key] === displayName) clearNameDraft(key)
  }

  const showOnCanvas = (item: BoundaryItem): void => {
    if (item.binds.kind === 'unbound') return
    if (item.binds.kind === 'valueSource') {
      const ctx = editedDef()
      if (ctx) props.app.canvasBridge.get()?.showValueSource?.(ctx.tab.id, ctx.def.id, item.binds.valueSource)
      return
    }
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
    <Show when={editedDef()} fallback={
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
      <section
        class="rail-section boundary-panel"
        data-testid="boundary-panel"
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
                  <div data-testid="boundary-empty" data-side={side} role="status">
                    <ProductEmptyState title={message(`boundaryPanel.empty.${side}`)} />
                  </div>
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
                        disabled={editingDisabled()}
                        onInput={(event) => setNameDrafts((current) => ({
                          ...current,
                          [itemKey(side, item)]: event.currentTarget.value,
                        }))}
                        onChange={(event) => rename(side, item, event.currentTarget.value)}
                        onBlur={(event) => rename(side, item, event.currentTarget.value)}
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
                          {item.binds.kind === 'unbound'
                            ? message('boundaryPanel.unbound')
                            : item.binds.kind === 'valueSource'
                            ? [editedDef()?.def.valueSources?.[item.binds.valueSource]?.title, `(${item.binds.valueSource})`].filter(Boolean).join(' ')
                            : `${item.binds.node}.${item.binds.kind === 'widgetTap' ? item.binds.tap : item.binds.port}`}
                        </code>
                      </div>
                      <button
                        type="button"
                        class="boundary-focus-action"
                        data-testid="boundary-show-on-canvas"
                        disabled={item.binds.kind === 'unbound'}
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
                                    disabled={editingDisabled()}
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
                                    disabled={editingDisabled()}
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
                                disabled={editingDisabled()}
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
                                  disabled={editingDisabled()}
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
