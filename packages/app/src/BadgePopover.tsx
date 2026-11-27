/**
 * Node-badge popover: presentation for the error, subgraph, and deprecation
 * badge branches.
 *
 * The host owns policy: when to open (badge hit-testing in the controller),
 * when to force-close (stale context after document/graph changes), and what
 * the action buttons DO (graph navigation and execution-log access).
 * This component owns the rendered content, focus-on-mount, and focus-scoped
 * closure; content data arrives through resolver props (host wrappers over
 * the framework-free badge-info.ts helpers), resolved lazily at render.
 */

import { For, Show } from 'solid-js'
import type { NodeBadge } from '@dinkster/canvas'
import type { DeprecationBadgeInfo, SubgraphBadgeInfo } from './badge-info.js'
import type { NodeProblemKind } from './problem-display.js'
import { ProductEmptyState } from './ProductSurfaces.js'
import { ProductButton } from './ProductControls.js'
import { useAppMessage } from './locale.js'

/** Where and on what the popover opened; anchored in canvas-pane CSS px. */
export interface BadgeAnchor {
  readonly x: number
  readonly y: number
  readonly nodeId: string
  readonly badge: NodeBadge
}

export function BadgePopover(props: {
  anchor: BadgeAnchor
  problems: (nodeId: string, kind: NodeProblemKind) => readonly string[]
  subgraphInfo: (nodeId: string) => SubgraphBadgeInfo | undefined
  deprecationInfo: (nodeId: string) => DeprecationBadgeInfo | undefined
  onOpenSubgraph: (nodeId: string) => void
  onApplyReplacement?: (nodeId: string) => void
  onClose: () => void
}) {
  const message = useAppMessage()
  return (
    <div
      class="badge-popover"
      data-testid="badge-popover"
      data-badge={props.anchor.badge.id}
      tabindex="-1"
      ref={(el) => queueMicrotask(() => el.focus())}
      style={{ left: `${props.anchor.x}px`, top: `${props.anchor.y}px` }}
      onFocusOut={(e) => {
        // Stay open while focus moves within the popover (buttons).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onClose()
      }}
    >
      <Show when={props.anchor.badge.id.startsWith('core.problem.')}>
        {(() => {
          const kind = props.anchor.badge.id.slice('core.problem.'.length) as NodeProblemKind
          const title = kind === 'error' ? 'Errors' : 'Warnings'
          return <>
            <div class="badge-popover-title">{title}: {props.anchor.nodeId}</div>
            <For each={props.problems(props.anchor.nodeId, kind)} fallback={<ProductEmptyState title="No problem details recorded." />}>
              {(message) => <p class="badge-popover-line badge-problem" data-testid="badge-problem-detail">{message}</p>}
            </For>
          </>
        })()}
      </Show>
      <Show when={props.anchor.badge.id === 'core.subgraph'}>
        <Show when={props.subgraphInfo(props.anchor.nodeId)} fallback={<ProductEmptyState title="Definition missing." />}>
          {(info) => (
            <>
              <div class="badge-popover-title">Subgraph: {info().name}</div>
              <p class="badge-popover-line">
                definition {info().defId}, {info().nodeCount} nodes (shared; edits affect all instances)
              </p>
              <button
                class="banner-button"
                data-testid="badge-open-subgraph"
                // mousedown, not click: fires before the popover blurs.
                onMouseDown={(e) => {
                  e.preventDefault()
                  props.onOpenSubgraph(props.anchor.nodeId)
                }}
              >
                Open Subgraph
              </button>
            </>
          )}
        </Show>
      </Show>
      <Show when={props.anchor.badge.id === 'core.deprecated'}>
        <Show when={props.deprecationInfo(props.anchor.nodeId)} fallback={<ProductEmptyState title="Node missing." />}>
          {(info) => (
            <>
              <div class="badge-popover-title">Deprecated: {info().type}</div>
              <Show when={info().deprecation}>
                {(dep) => (
                  <p class="badge-popover-line" data-testid="badge-deprecation-message">
                    {dep().message}
                    {dep().since ? ` (since ${dep().since})` : ''}
                  </p>
                )}
              </Show>
              <Show when={info().item}>{(item) => (
                <>
                  <p class="badge-popover-line" data-testid="badge-replace-target">
                    {item().sourceType} -&gt; {item().terminalType}
                  </p>
                  <For each={item().hops}>{(hop) => (
                    <Show when={hop.rule.note}>{(note) => <p class="badge-popover-line">{note()}</p>}</Show>
                  )}</For>
                  <For each={item().diagnostics}>{(entry) => <p class="badge-popover-line">{entry.message}</p>}</For>
                  <Show when={item().hops.length > 0 && props.onApplyReplacement}>
                    <ProductButton size="compact" data-testid="badge-apply-replacement"
                      onMouseDown={(event) => { event.preventDefault(); props.onApplyReplacement?.(props.anchor.nodeId) }}>
                      {message('problems.migration.apply')}
                    </ProductButton>
                  </Show>
                </>
              )}</Show>
              <Show
                when={info().pointer}
                fallback={<p class="badge-popover-line">No successor is declared.</p>}
              >
                {(ptr) => (
                  <p class="badge-popover-line" data-testid="badge-replace-pointer">
                    Successor: '{ptr().terminal}'
                    {ptr().path.length > 1 ? ` (via ${ptr().path.slice(0, -1).join(' -> ')})` : ''}
                    {ptr().status === 'dangling'
                      ? ' - not installed here'
                      : ptr().status !== 'ok'
                        ? ' - successor chain is unresolved'
                        : ''}{' '}
                    - no automatic migration.
                  </p>
                )}
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}
