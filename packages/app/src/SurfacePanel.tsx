/**
 * Control surfaces panel: create mode panels, edit their bindings, and
 * fire bulk mode changes - the sanctioned form of rgthree's Fast Muter /
 * Fast Groups Muter (architecture section 6).
 *
 * Everything here is derived FROM the document (surfaces serialize with the
 * workflow); there is no local binding state to fall out of sync. All writes
 * are commands: binding edits are surface.update, applying a mode is ONE
 * surface.mode.apply (one undo step, attributed to the surface). Group
 * membership is captured from the canvas bridge at the moment a button is
 * pressed - never polled, never stored.
 *
 * A surface whose type has no registered definition renders as an inert
 * shell (delete only): unknown types stay intact in the document, exactly
 * like unknown binding kinds inside a mode panel.
 */

import { createEffect, createMemo, createSignal as createSolidSignal, For, onCleanup, Show } from 'solid-js'
import X from 'lucide-solid/icons/x'
import {
  brokenBindingMessage,
  decodeModePanelConfig,
  encodeModePanelConfig,
  MODE_PANEL_TYPE,
  resolveModePanelBindings,
  type CommandOutcome,
  type ControlSurfaceData,
  type GroupMembers,
  type ModePanelBinding,
  type ModePanelConfig,
  type NodeMode,
} from '@dinkster/core'
import { currentGraphId, type AppState, type Tab } from './app-state.js'
import { Icon } from './Icon.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductNotice } from './ProductForm.js'
import { ProductEmptyState, ProductListRow } from './ProductSurfaces.js'
import { useSignal } from './solid-adapter.js'

const MODES: readonly { mode: NodeMode; messageKey: string }[] = [
  { mode: 'active', messageKey: 'controlSurfaces.mode.active' },
  { mode: 'muted', messageKey: 'controlSurfaces.mode.mute' },
  { mode: 'bypassed', messageKey: 'controlSurfaces.mode.bypass' },
]

export function SurfacePanel(props: { app: AppState }) {
  const message = useAppMessage()
  const tabs = useSignal(props.app.tabs)
  const activeTabId = useSignal(props.app.activeTabId)
  const selectionTick = useSignal(props.app.selectionTick)
  const bridge = useSignal(props.app.canvasBridge)

  const activeTab = (): Tab | undefined => tabs().find((t) => t.id === activeTabId())
  const frozen = (): boolean => activeTab()?.execution !== undefined
  const groupTab = createMemo(activeTab)
  const [groupPending, setGroupPending] = createSolidSignal<string>()
  const [groupRefusal, setGroupRefusal] = createSolidSignal<{ surface: string; message: string }>()
  let groupGeneration = 0
  let groupLive = true
  const resetGroup = (): void => {
    groupGeneration++
    setGroupPending(undefined)
    setGroupRefusal(undefined)
  }
  onCleanup(() => { groupLive = false; groupGeneration++ })
  createEffect(() => {
    const tab = groupTab()
    resetGroup()
    if (tab) onCleanup(tab.graphStack.subscribe(resetGroup))
  })

  // Re-render on document changes of the active tab (same pattern as
  // BoundaryPanel: subscription rebinds on tab switch).
  const [docTick, setDocTick] = createSolidSignal(0)
  createEffect(() => {
    const tab = activeTab()
    if (!tab) return
    const unsub = tab.store.document.subscribe(() => setDocTick((n) => n + 1))
    onCleanup(unsub)
  })

  const surfaces = (): ControlSurfaceData[] => {
    docTick()
    const tab = activeTab()
    return tab ? Object.values(tab.store.doc.surfaces ?? {}) : []
  }

  /** Capture group membership for every group binding the canvas can answer. */
  const captureGroupMembers = (config: ModePanelConfig): GroupMembers[] => {
    const b = bridge()
    if (!b) return []
    const out: GroupMembers[] = []
    for (const binding of config.bindings) {
      if (binding.kind !== 'group') continue
      const nodeIds = b.groupMembers(binding.graphId, binding.groupId)
      if (nodeIds) out.push({ graphId: binding.graphId, groupId: binding.groupId, nodeIds })
    }
    return out
  }

  const updateConfig = (surface: ControlSurfaceData, config: ModePanelConfig): CommandOutcome | undefined => {
    const tab = activeTab()
    if (!tab) return
    return props.app.dispatchTo(tab, {
      command: 'surface.update',
      params: { surfaceId: surface.id, config: encodeModePanelConfig(config) },
    })
  }

  const addPanel = (): void => {
    const tab = activeTab()
    if (!tab) return
    props.app.dispatchTo(tab, {
      command: 'surface.add',
      params: { type: MODE_PANEL_TYPE, config: { title: 'Mode Panel', bindings: [] } },
    })
  }

  const removeSurface = (surface: ControlSurfaceData): void => {
    const tab = activeTab()
    if (!tab) return
    props.app.dispatchTo(tab, { command: 'surface.remove', params: { surfaceId: surface.id } })
  }

  const applyMode = (surface: ControlSurfaceData, config: ModePanelConfig, mode: NodeMode): void => {
    const tab = activeTab()
    if (!tab) return
    props.app.dispatchTo(tab, {
      command: 'surface.mode.apply',
      params: {
        surfaceId: surface.id,
        mode,
        groupMembers: captureGroupMembers(config).map((m) => ({ ...m, nodeIds: [...m.nodeIds] })),
      },
    })
  }

  const bindSelection = (surface: ControlSurfaceData, config: ModePanelConfig): void => {
    const tab = activeTab()
    const b = bridge()
    if (!tab || !b) return
    const graphId = currentGraphId(tab)
    const bound = new Set(
      config.bindings
        .filter((x): x is ModePanelBinding & { kind: 'node' } => x.kind === 'node')
        .map((x) => `${x.graphId}\u0000${x.nodeId}`),
    )
    const added = b
      .selectedNodes()
      .filter((nodeId) => !bound.has(`${graphId}\u0000${nodeId}`))
      .map((nodeId): ModePanelBinding => ({ kind: 'node', graphId, nodeId }))
    if (added.length === 0) return
    updateConfig(surface, { ...config, bindings: [...config.bindings, ...added] })
  }

  const bindGroup = async (surface: ControlSurfaceData, config: ModePanelConfig, groupId: string, stillWanted: () => boolean): Promise<boolean> => {
    const tab = activeTab()
    if (!tab || tab.execution || groupId === '' || groupPending()) return false
    const generation = groupGeneration
    const store = tab.store
    const graphId = currentGraphId(tab)
    const isCurrent = () => groupLive && groupGeneration === generation && activeTab() === tab && tab.store === store
    setGroupPending(surface.id)
    setGroupRefusal(undefined)
    try {
      const outcome = await updateConfig(surface, {
        ...config,
        bindings: [...config.bindings, { kind: 'group', graphId, groupId }],
      })
      if (!isCurrent() || !stillWanted()) return false
      if (outcome?.ok) return true
      if (outcome !== undefined) setGroupRefusal({ surface: surface.id, message: outcome.diagnostics[0]?.message ?? message('widgetEditor.commitRefused') })
      return false
    } catch (error) {
      if (isCurrent() && stillWanted()) setGroupRefusal({ surface: surface.id, message: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      if (isCurrent()) setGroupPending(undefined)
    }
  }

  const removeBinding = (surface: ControlSurfaceData, config: ModePanelConfig, index: number): void => {
    updateConfig(surface, { ...config, bindings: config.bindings.filter((_, i) => i !== index) })
  }

  /** Groups of the current graph not yet bound by this panel. */
  const bindableGroups = (config: ModePanelConfig): { id: string; title: string }[] => {
    docTick()
    const tab = activeTab()
    if (!tab) return []
    const graphId = currentGraphId(tab)
    const groups = tab.store.doc.view.graphs[graphId]?.groups ?? {}
    return Object.values(groups)
      .filter(
        (g) =>
          !config.bindings.some((b) => b.kind === 'group' && b.graphId === graphId && b.groupId === g.id),
      )
      .map((g) => ({ id: g.id, title: g.title }))
  }

  const bindingLabel = (binding: ModePanelBinding, tab: Tab): string => {
    if (binding.kind === 'node') {
      const node = tab.store.doc.graphs[binding.graphId]?.nodes[binding.nodeId]
      return node ? (node.title ?? node.type) : binding.nodeId
    }
    if (binding.kind === 'group') {
      const group = tab.store.doc.view.graphs[binding.graphId]?.groups?.[binding.groupId]
      return message('controlSurfaces.binding.group', { title: group?.title ?? binding.groupId })
    }
    return message('controlSurfaces.binding.unknown')
  }

  return (
    <Show when={activeTab()}>
      {(tab) => (
        <section class="rail-section" data-testid="surface-panel">
          <h2>{message('controlSurfaces.title')}</h2>
          <Show when={!frozen()}>
            <button class="banner-button" data-testid="surface-add" disabled={groupPending() !== undefined} onClick={addPanel}>
              {message('controlSurfaces.action.addModePanel')}
            </button>
          </Show>
          <For each={surfaces().map((surface) => surface.id)} fallback={<ProductEmptyState title={message('controlSurfaces.empty')} />}>
            {(surfaceId) => {
              const initial = surfaces().find((surface) => surface.id === surfaceId)!
              const surface = createMemo(() => surfaces().find((surface) => surface.id === surfaceId) ?? initial)
              const decoded = () => {
                docTick()
                return surface().type === MODE_PANEL_TYPE ? decodeModePanelConfig(surface().config) : undefined
              }
              return (
                <div class="surface" data-testid={`surface-${surfaceId}`}>
                  <div class="surface-header">
                    <span class="surface-title">
                      {(() => {
                        const d = decoded()
                        return d?.ok ? (d.config.title ?? surfaceId) : `${surfaceId} (${surface().type})`
                      })()}
                    </span>
                    <Show when={!frozen()}>
                      <button
                        class="surface-remove"
                        data-testid={`surface-remove-${surfaceId}`}
                        data-tooltip-label={message('controlSurfaces.action.deleteSurface')}
                        aria-label={message('controlSurfaces.action.deleteSurface')}
                        disabled={groupPending() !== undefined}
                        onClick={() => removeSurface(surface())}
                      >
                        <Icon icon={X} />
                      </button>
                    </Show>
                  </div>
                  <Show
                    when={decoded()?.ok ? decoded() : undefined}
                    fallback={
                      <ProductEmptyState
                        tone={surface().type === MODE_PANEL_TYPE ? 'error' : 'empty'}
                        title={surface().type === MODE_PANEL_TYPE
                          ? message('controlSurfaces.config.invalid')
                          : message('controlSurfaces.config.unknownType', { type: surface().type })}
                      />
                    }
                  >
                    {(d) => {
                      const config = () => (d() as { config: ModePanelConfig }).config
                      const resolved = () => {
                        docTick()
                        selectionTick() // group membership shifts with drags too; cheap to re-derive
                        return resolveModePanelBindings(
                          tab().store.doc,
                          config(),
                          captureGroupMembers(config()),
                        )
                      }
                      return (
                        <>
                          <ul class="surface-bindings">
                            <For
                              each={resolved()}
                              fallback={<li><ProductEmptyState title={message('controlSurfaces.binding.empty')} /></li>}
                            >
                              {(r, i) => (
                                <li>
                                  <ProductListRow
                                    testId={`surface-binding-${surfaceId}-${i()}`}
                                    dataAttributes={{ 'data-status': r.status }}
                                    primary={<span classList={{ 'mode-binding-unresolved': r.status !== 'ok' }}>{bindingLabel(r.binding, tab())}</span>}
                                    leading={<Show when={brokenBindingMessage(r)}>
                                      {(msg) => <span class="mode-binding-warning" tabindex="0" data-tooltip-label={msg()} aria-label={msg()}>!</span>}
                                    </Show>}
                                    actions={<Show when={!frozen()}>
                                      <button
                                        class="surface-remove"
                                        data-testid={`surface-unbind-${surfaceId}-${i()}`}
                                        data-tooltip-label={message('controlSurfaces.action.removeBinding')}
                                        aria-label={message('controlSurfaces.action.removeBinding')}
                                        disabled={groupPending() !== undefined}
                                        onClick={() => removeBinding(surface(), config(), i())}
                                      >
                                        <Icon icon={X} />
                                      </button>
                                    </Show>}
                                  />
                                </li>
                              )}
                            </For>
                          </ul>
                          <Show when={!frozen()}>
                            <Show when={groupRefusal()?.surface === surfaceId ? groupRefusal() : undefined}>
                              {(refusal) => <ProductNotice tone="error" testId="surface-group-error">{refusal().message}</ProductNotice>}
                            </Show>
                            <div class="surface-actions">
                              <button
                                class="banner-button"
                                data-testid={`surface-bind-selection-${surfaceId}`}
                                disabled={groupPending() !== undefined || (selectionTick(), (bridge()?.selectedNodes().length ?? 0) === 0)}
                                onClick={() => bindSelection(surface(), config())}
                              >
                                {message('controlSurfaces.action.bindSelection')}
                              </button>
                              <ProductSelect
                                class="surface-group-select"
                                testId={`surface-bind-group-${surfaceId}`}
                                ariaLabel={message('controlSurfaces.action.bindGroup')}
                                selectedId=""
                                options={[
                                  { id: '', label: message('controlSurfaces.placeholder.bindGroup'), value: '', disabled: true },
                                  ...bindableGroups(config()).map((group) => ({ id: group.id, label: group.title, value: group.id, disabled: groupPending() !== undefined })),
                                ]}
                                onSelectAsync={(option, stillWanted) => bindGroup(surface(), config(), option.value, stillWanted)}
                              />
                            </div>
                            <div class="surface-actions">
                              <For each={MODES}>
                                {({ mode, messageKey }) => (
                                  <button
                                    class="banner-button"
                                    data-testid={`surface-apply-${mode}-${surfaceId}`}
                                    disabled={groupPending() !== undefined || config().bindings.length === 0}
                                    onClick={() => applyMode(surface(), config(), mode)}
                                  >
                                    {message(messageKey)}
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </>
                      )
                    }}
                  </Show>
                </div>
              )
            }}
          </For>
        </section>
      )}
    </Show>
  )
}
