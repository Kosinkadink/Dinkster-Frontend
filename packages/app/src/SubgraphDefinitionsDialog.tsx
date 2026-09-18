import { createMemo, For, Show } from 'solid-js'
import { planSubgraphDefinitionCleanup, type SubgraphDefinitionCleanupEntry } from '@dinkster/core'
import type { AppState } from './app-state.js'
import { ProductActionFooter } from './ProductForm.js'
import { useSignal } from './solid-adapter.js'

function DefinitionRow(props: {
  readonly entry: SubgraphDefinitionCleanupEntry
  readonly state: 'unreachable' | 'reachable'
  readonly definition: (id: string) => SubgraphDefinitionCleanupEntry | undefined
}) {
  return (
    <li class="subgraph-definition-row" data-definition-id={props.entry.id}>
      <div class="subgraph-definition-header">
        <span class="subgraph-definition-identity"><strong>{props.entry.name}</strong><code>{props.entry.id}</code></span>
        <span class="subgraph-definition-state" data-state={props.state}>
          {props.state === 'unreachable' ? 'Unreachable' : 'Reachable'}
        </span>
      </div>
      <dl class="subgraph-definition-facts">
        <div><dt>Body nodes</dt><dd>{props.entry.nodeCount}</dd></div>
        <div><dt>Occurrences</dt><dd>{props.entry.occurrenceCount}</dd></div>
        <div><dt>Related saved items</dt><dd>{props.entry.relatedItemCount}</dd></div>
      </dl>
      <div class="subgraph-definition-dependencies">
        <span>Nested definitions ({props.entry.dependencies.length})</span>
        <Show when={props.entry.dependencies.length > 0} fallback={<span class="subgraph-definition-none">None</span>}>
          <ul aria-label={`Nested definitions used by ${props.entry.name}`}>
            <For each={props.entry.dependencies}>{(id) => <li>
              <strong>{props.definition(id)?.name ?? id}</strong><code>{id}</code>
            </li>}</For>
          </ul>
        </Show>
      </div>
    </li>
  )
}

export function SubgraphDefinitionsDialog(props: { readonly app: AppState }) {
  const tab = props.app.activeTab()
  const document = tab === undefined ? undefined : useSignal(tab.store.document)
  const plan = createMemo(() => document === undefined ? undefined : planSubgraphDefinitionCleanup(document()))
  const removableNodeCount = () => plan()?.removable.reduce((total, entry) => total + entry.nodeCount, 0) ?? 0
  const removableRelatedItemCount = () => plan()?.removable.reduce((total, entry) => total + entry.relatedItemCount, 0) ?? 0
  const removeUnused = (): void => {
    const current = plan()
    const activeTab = props.app.activeTab()
    if (activeTab === undefined || current === undefined || current.removable.length === 0) return
    const outcome = props.app.dispatchTo(activeTab, {
      command: 'subgraph.removeUnusedDefinitions',
      params: {
        definitionIds: current.removable.map((entry) => entry.id),
        fingerprint: current.fingerprint,
      },
    })
    if (!outcome.ok) return
    props.app.modalPanel.set('')
    props.app.showTransientStatus(
      `Removed ${current.removable.length} unused subgraph definition${current.removable.length === 1 ? '' : 's'}`,
    )
  }

  return (
    <div class="subgraph-definitions" data-testid="subgraph-definitions">
      <Show when={plan()} fallback={
        <div class="subgraph-cleanup-state" data-state="unavailable">
          <strong>No editable workflow</strong>
          <span>Open an editable workflow to review its subgraph definitions.</span>
        </div>
      }>
        {(current) => {
          const definition = (id: string) => [...current().removable, ...current().retained]
            .find((entry) => entry.id === id)
          return <>
          <section class="subgraph-cleanup-summary" aria-labelledby="subgraph-cleanup-heading">
            <h2 id="subgraph-cleanup-heading">Unused definitions</h2>
            <Show when={current().removable.length > 0} fallback={
              <div class="subgraph-cleanup-state" data-state="empty">
                <strong>No unused definitions</strong>
                <span>Every subgraph definition is reachable from the workflow root.</span>
              </div>
            }>
              <p class="subgraph-cleanup-intro">
                These definitions cannot be reached from the workflow root. Removing them also removes their saved
                layout and core-owned bookmarks, app controls, net positions, and mode-panel bindings.
              </p>
              <Show when={current().removable.length > 2}>
                <p id="subgraph-unused-scroll-hint" class="subgraph-definition-list-hint">
                  {current().removable.length} definitions are in this cleanup set. Scroll to review every row.
                </p>
              </Show>
              <ul
                class="subgraph-definition-list"
                data-testid="unused-subgraph-list"
                aria-label={`${current().removable.length} unreachable subgraph definition${current().removable.length === 1 ? '' : 's'}`}
                aria-describedby={current().removable.length > 2 ? 'subgraph-unused-scroll-hint' : undefined}
                tabIndex={0}
              >
                <For each={current().removable}>{(entry) =>
                  <DefinitionRow entry={entry} state="unreachable" definition={definition} />
                }</For>
              </ul>
              <ProductActionFooter status={<span>
                {current().removable.length} definition{current().removable.length === 1 ? '' : 's'}, {removableNodeCount()} body node{removableNodeCount() === 1 ? '' : 's'}, and {removableRelatedItemCount()} related saved item{removableRelatedItemCount() === 1 ? '' : 's'} will be removed.
              </span>}>
                <button type="button" class="danger" data-testid="confirm-subgraph-cleanup" onClick={removeUnused}>
                  Remove {current().removable.length} unused definition{current().removable.length === 1 ? '' : 's'}
                </button>
              </ProductActionFooter>
            </Show>
          </section>
          <details class="subgraph-retained-definitions">
            <summary>Retained definitions ({current().retained.length})</summary>
            <Show when={current().retained.length > 0} fallback={
              <p class="subgraph-retained-empty">No reusable subgraph definitions are reachable from the workflow root.</p>
            }>
              <Show when={current().retained.length > 2}>
                <p id="subgraph-retained-scroll-hint" class="subgraph-definition-list-hint">
                  {current().retained.length} definitions are retained. Scroll to review every row.
                </p>
              </Show>
              <ul
                class="subgraph-definition-list"
                aria-label={`${current().retained.length} retained subgraph definition${current().retained.length === 1 ? '' : 's'}`}
                aria-describedby={current().retained.length > 2 ? 'subgraph-retained-scroll-hint' : undefined}
                tabIndex={0}
              >
                <For each={current().retained}>{(entry) =>
                  <DefinitionRow entry={entry} state="reachable" definition={definition} />
                }</For>
              </ul>
            </Show>
          </details>
        </>}}
      </Show>
    </div>
  )
}
