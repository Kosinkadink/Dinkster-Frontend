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

import { createEffect, createSignal as createSolidSignal, For, onCleanup, Show } from 'solid-js'
import X from 'lucide-solid/icons/x'
import {
  brokenBindingMessage,
  decodeModePanelConfig,
  encodeModePanelConfig,
  MODE_PANEL_TYPE,
  resolveModePanelBindings,
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

  const updateConfig = (surface: ControlSurfaceData, config: ModePanelConfig): void => {
    const tab = activeTab()
    if (!tab) return
    props.app.dispatchTo(tab, {
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

  const bindGroup = (surface: ControlSurfaceData, config: ModePanelConfig, groupId: string): void => {
    const tab = activeTab()
    if (!tab || groupId === '') return
    const graphId = currentGraphId(tab)
    updateConfig(surface, {
      ...config,
      bindings: [...config.bindings, { kind: 'group', graphId, groupId }],
    })
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
            <button class="banner-button" data-testid="surface-add" onClick={addPanel}>
              {message('controlSurfaces.action.addModePanel')}
            </button>
          </Show>
          <For each={surfaces()} fallback={<p class="empty">{message('controlSurfaces.empty')}</p>}>
            {(surface) => {
              const decoded = () => {
                docTick()
                return surface.type === MODE_PANEL_TYPE ? decodeModePanelConfig(surface.config) : undefined
              }
              return (
                <div class="surface" data-testid={`surface-${surface.id}`}>
                  <div class="surface-header">
                    <span class="surface-title">
                      {(() => {
                        const d = decoded()
                        return d?.ok ? (d.config.title ?? surface.id) : `${surface.id} (${surface.type})`
                      })()}
                    </span>
                    <Show when={!frozen()}>
                      <button
                        class="surface-remove"
                        data-testid={`surface-remove-${surface.id}`}
                        data-tooltip-label={message('controlSurfaces.action.deleteSurface')}
                        aria-label={message('controlSurfaces.action.deleteSurface')}
                        onClick={() => removeSurface(surface)}
                      >
                        <Icon icon={X} />
                      </button>
                    </Show>
                  </div>
                  <Show
                    when={decoded()?.ok ? decoded() : undefined}
                    fallback={
                      <p class="empty">
                        {surface.type === MODE_PANEL_TYPE
                          ? message('controlSurfaces.config.invalid')
                          : message('controlSurfaces.config.unknownType', { type: surface.type })}
                      </p>
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
                              fallback={<li class="empty">{message('controlSurfaces.binding.empty')}</li>}
                            >
                              {(r, i) => (
                                <li
                                  class="surface-binding"
                                  data-status={r.status}
                                  data-testid={`surface-binding-${surface.id}-${i()}`}
                                >
                                  <span>{bindingLabel(r.binding, tab())}</span>
                                  <Show when={brokenBindingMessage(r)}>
                                    {(msg) => <span class="surface-binding-broken" tabindex="0" data-tooltip-label={msg()} aria-label={msg()}>!</span>}
                                  </Show>
                                  <Show when={!frozen()}>
                                    <button
                                      class="surface-remove"
                                      data-testid={`surface-unbind-${surface.id}-${i()}`}
                                      data-tooltip-label={message('controlSurfaces.action.removeBinding')}
                                      aria-label={message('controlSurfaces.action.removeBinding')}
                                      onClick={() => removeBinding(surface, config(), i())}
                                    >
                                      <Icon icon={X} />
                                    </button>
                                  </Show>
                                </li>
                              )}
                            </For>
                          </ul>
                          <Show when={!frozen()}>
                            <div class="surface-actions">
                              <button
                                class="banner-button"
                                data-testid={`surface-bind-selection-${surface.id}`}
                                disabled={(selectionTick(), (bridge()?.selectedNodes().length ?? 0) === 0)}
                                onClick={() => bindSelection(surface, config())}
                              >
                                {message('controlSurfaces.action.bindSelection')}
                              </button>
                              <ProductSelect
                                class="surface-group-select"
                                testId={`surface-bind-group-${surface.id}`}
                                ariaLabel={message('controlSurfaces.action.bindGroup')}
                                selectedId=""
                                options={[
                                  { id: '', label: message('controlSurfaces.placeholder.bindGroup'), value: '', disabled: true },
                                  ...bindableGroups(config()).map((group) => ({ id: group.id, label: group.title, value: group.id })),
                                ]}
                                onSelect={(option) => bindGroup(surface, config(), option.value)}
                              />
                            </div>
                            <div class="surface-actions">
                              <For each={MODES}>
                                {({ mode, messageKey }) => (
                                  <button
                                    class="banner-button"
                                    data-testid={`surface-apply-${mode}-${surface.id}`}
                                    disabled={config().bindings.length === 0}
                                    onClick={() => applyMode(surface, config(), mode)}
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
