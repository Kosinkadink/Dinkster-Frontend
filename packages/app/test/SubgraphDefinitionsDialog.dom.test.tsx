// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowDocument } from '@dinkster/core'
import { AppState } from '../src/app-state.js'
import { SubgraphDefinitionsDialog } from '../src/SubgraphDefinitionsDialog.js'

const documentWithUnusedDefinitions = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'subgraph-cleanup-dialog' as never,
  root: 'root' as never,
  graphs: {
    root: {
      id: 'root' as never,
      name: 'Root',
      nodes: { used: { id: 'used' as never, type: '#used', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
    },
    used: {
      id: 'used' as never,
      name: 'Shared controls',
      nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
    },
    orphan: {
      id: 'orphan' as never,
      name: 'Old experiment',
      nodes: {
        body: { id: 'body' as never, type: 'Plain', values: {} },
        nested: { id: 'nested' as never, type: '#orphanChild', values: {} },
      },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
    },
    orphanChild: {
      id: 'orphanChild' as never,
      name: 'Old detail',
      nodes: { leaf: { id: 'leaf' as never, type: 'Plain', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
    },
  },
  view: {
    graphs: {
      root: { nodes: { used: { position: { x: 0, y: 0 } } } },
      used: { nodes: {} },
      orphan: { nodes: { body: { position: { x: 10, y: 20 } }, nested: { position: { x: 40, y: 20 } } } },
      orphanChild: { nodes: { leaf: { position: { x: 10, y: 20 } } } },
    },
  },
  ext: {
    'dinkster.exposed': [{ graphId: 'orphanChild', nodeId: 'leaf', inputId: 'value' }],
  },
})

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
})

describe('SubgraphDefinitionsDialog', () => {
  it('presents the complete cleanup impact and removes it only after destructive activation', () => {
    const app = new AppState()
    expect(app.openDocument(documentWithUnusedDefinitions(), 'Cleanup')).toEqual([])
    app.modalPanel.set('subgraph-definitions')
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <SubgraphDefinitionsDialog app={app} />, root)

    const unusedList = root.querySelector<HTMLUListElement>('[data-testid="unused-subgraph-list"]')!
    const orphan = root.querySelector<HTMLElement>('[data-definition-id="orphan"]')!
    const facts = new Map([...orphan.querySelectorAll('.subgraph-definition-facts > div')].map((fact) => [
      fact.querySelector('dt')!.textContent,
      fact.querySelector('dd')!.textContent,
    ]))
    expect(unusedList.getAttribute('aria-label')).toBe('2 unreachable subgraph definitions')
    expect(unusedList.getAttribute('aria-describedby')).toBeNull()
    expect(unusedList.tabIndex).toBe(0)
    expect(orphan.querySelector('.subgraph-definition-header')?.tagName).toBe('DIV')
    expect(orphan.querySelector('[data-state="unreachable"]')?.textContent).toBe('Unreachable')
    expect(orphan.textContent).toContain('Old experiment')
    expect(orphan.querySelector('[aria-label="Nested definitions used by Old experiment"]')?.textContent).toContain('Old detail')
    expect(orphan.querySelector('[aria-label="Nested definitions used by Old experiment"]')?.textContent).toContain('orphanChild')
    expect(facts).toEqual(new Map([
      ['Body nodes', '2'],
      ['Occurrences', '0'],
      ['Related saved items', '0'],
    ]))
    const childFacts = root.querySelector<HTMLElement>('[data-definition-id="orphanChild"] .subgraph-definition-facts')!
    expect(childFacts.textContent).toContain('Occurrences1')
    expect(childFacts.textContent).toContain('Related saved items1')
    expect(root.querySelector('.product-action-status')?.textContent).toContain('2 definitions, 3 body nodes, and 1 related saved item will be removed.')
    expect(root.querySelector('[data-testid="confirm-subgraph-cleanup"]')?.textContent).toContain('Remove 2 unused definitions')
    expect(app.activeTab()!.store.doc.graphs.orphan).toBeDefined()
    expect(app.activeTab()!.store.doc.graphs.orphanChild).toBeDefined()

    root.querySelector<HTMLButtonElement>('[data-testid="confirm-subgraph-cleanup"]')!.click()
    expect(app.activeTab()!.store.doc.graphs.orphan).toBeUndefined()
    expect(app.activeTab()!.store.doc.graphs.orphanChild).toBeUndefined()
    expect(app.activeTab()!.store.doc.graphs.used).toBeDefined()
    expect(app.modalPanel.get()).toBe('')
    expect(app.transientStatus.get()).toBe('Removed 2 unused subgraph definitions')
    dispose()
  })

  it('shows an empty state and never offers deletion when all definitions are reachable', () => {
    const app = new AppState()
    const doc = documentWithUnusedDefinitions() as any
    doc.graphs.root.nodes.orphan = { id: 'orphan', type: '#orphan', values: {} }
    doc.view.graphs.root.nodes.orphan = { position: { x: 100, y: 0 } }
    expect(app.openDocument(doc, 'No cleanup')).toEqual([])
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <SubgraphDefinitionsDialog app={app} />, root)

    expect(root.querySelector('[data-state="empty"] strong')?.textContent).toBe('No unused definitions')
    expect(root.textContent).toContain('Every subgraph definition is reachable')
    expect(root.querySelector('[data-testid="confirm-subgraph-cleanup"]')).toBeNull()
    root.querySelector<HTMLDetailsElement>('.subgraph-retained-definitions')!.open = true
    const retained = root.querySelector('[aria-label="3 retained subgraph definitions"]')
    expect(retained?.getAttribute('aria-describedby')).toBe('subgraph-retained-scroll-hint')
    expect(root.querySelector('#subgraph-retained-scroll-hint')?.textContent)
      .toContain('3 definitions are retained. Scroll to review every row.')
    expect(root.querySelector('[data-definition-id="used"] [data-state="reachable"]')?.textContent).toBe('Reachable')
    dispose()
  })

  it('explains the unavailable state without exposing cleanup actions', () => {
    const app = new AppState()
    for (const tab of app.tabs.get()) app.closeTab(tab.id)
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <SubgraphDefinitionsDialog app={app} />, root)

    expect(root.querySelector('[data-state="unavailable"] strong')?.textContent).toBe('No editable workflow')
    expect(root.textContent).toContain('Open an editable workflow')
    expect(root.querySelector('[data-testid="confirm-subgraph-cleanup"]')).toBeNull()
    dispose()
  })
})
