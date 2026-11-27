// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import type { WorkflowDocument } from '@dinkster/core'
import { AppView } from '../src/AppView.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

describe('App View occurrence fields', () => {
  it.each([0, 1, 2])('honors calculated read-only, disabled and visible fields at depth %s', async (depth) => {
    const app = createWorkflowApp([{
      type: 'Controlled', displayName: 'Controlled', category: 'test', source: 'v3', isOutputNode: true,
      body: [
        { kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: { widgetType: 'INT', options: {}, default: 5 } },
        { kind: 'input', id: 'total', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: { widgetType: 'INT', options: {}, default: 5 }, automatic: { formula: 'seed * 2' },
          readOnly: { formula: 'seed >= 10 and seed < 15' }, disabled: { formula: 'seed < 10' },
          disabledReason: { formula: '"Seed " + str(seed)' }, visible: { formula: 'seed > 0' } },
      ],
    }])
    app.settings.set('features.appView.enabled', true)
    const bind = (id: string, node: string, port: string) => ({
      kind: 'input', id, promoted: true, binds: { kind: 'port', node, port },
    })
    const graph = (id: string, nodes: unknown, body?: unknown) => ({
      id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 20,
      ...(body === undefined ? {} : { boundary: { body } }),
    })
    const seed = depth === 0 ? 'seed' : depth === 1 ? 'start' : 'control'
    const total = depth === 0 ? 'total' : depth === 1 ? 'amount' : 'result'
    const document = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: `field-flags-${depth}`, root: 'root',
      graphs: {
        root: graph('root', Object.fromEntries([['first', 21], ['second', 13], ['third', 8]].map(([id, value]) => [id, {
          id, type: depth === 0 ? 'Controlled' : depth === 1 ? '#detail' : '#portrait', values: { [seed]: value },
        }]))),
        ...(depth > 0 ? { detail: graph('detail', { sample: { id: 'sample', type: 'Controlled', values: { seed: 3 } } },
          [bind('start', 'sample', 'seed'), bind('amount', 'sample', 'total')]) } : {}),
        ...(depth === 2 ? { portrait: graph('portrait', { detail: { id: 'detail', type: '#detail', values: { start: 7 } } },
          [bind('control', 'detail', 'start'), bind('result', 'detail', 'amount')]) } : {}),
      }, view: { graphs: {} }, ext: { 'dinkster.exposed': ['first', 'second', 'third'].map((nodeId) => ({
        graphId: 'root', nodeId, inputId: total, label: nodeId,
      })) },
    } as unknown as WorkflowDocument
    await app.openDocument(document, 'Field flags')
    const root = window.document.createElement('div')
    window.document.body.append(root)
    const dispose = render(() => <AppView app={app} />, root)
    try {
      const rows = () => [...root.querySelectorAll<HTMLElement>('[data-testid="app-view-row"]')]
      expect(rows()).toHaveLength(3)
      expect(rows()[0]!.querySelector('input')?.value).toBe('42')
      expect(rows()[1]!.querySelector('input')).toBeNull()
      expect(rows()[1]!.textContent).toContain('26')
      expect(rows()[2]!.querySelector('input')).toBeNull()
      expect(rows()[2]!.textContent).toContain('Seed 8')
      const store = app.activeTab()!.store
      expect(store.doc).toEqual(document)
      expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'second', inputId: seed, value: 18 } }).ok).toBe(true)
      await Promise.resolve()
      expect(rows()[1]!.querySelector('input')?.value).toBe('36')
      expect(store.doc.graphs.root!.nodes.first!.values).toEqual({ [seed]: 21 })
      expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'third', inputId: seed, value: 0 } }).ok).toBe(true)
      await Promise.resolve()
      expect(rows()).toHaveLength(2)
      expect(store.undo()).toBe(true)
      expect(store.undo()).toBe(true)
      await Promise.resolve()
      expect(store.doc).toEqual(document)
      expect(rows()).toHaveLength(3)
      expect(rows()[1]!.querySelector('input')).toBeNull()
    } finally {
      dispose()
      root.remove()
      app.dispose()
    }
  })
})
