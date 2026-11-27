// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { describe, expect, it, vi } from 'vitest'
import { asPromptId, type WorkflowDocument } from '@dinkster/core'
import { AppView } from '../src/AppView.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

describe('App View occurrence fields', () => {
  it('requests a choice selector visibility dependency without requesting inactive retained fields', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/api/lookups')) return new Response('{}', { status: 503 })
      const call = JSON.parse(String(init?.body)) as { function: string; args: number[] }
      requests.push(call.function)
      return new Response(JSON.stringify({ answer: call.args[0]! * 2 }), { headers: { 'content-type': 'application/json' } })
    })
    const field = (id: string) => ({ kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'INT' },
      optional: false, widget: { widgetType: 'INT', options: {}, default: 5 } })
    const app = createWorkflowApp([{
      type: 'Choices', displayName: 'Choices', category: 'test', source: 'v3', isOutputNode: true,
      body: [field('seed'), { ...field('gate'), hidden: true, automatic: { lookup: 'gate_for', args: ['seed'] } },
        { kind: 'choice', id: 'pick', required: false, shared: [], visible: { formula: 'gate > 10' },
          displayName: { formula: '"Pick " + str(gate)' }, options: [{ key: 'a', rows: [] }, { key: 'b', rows: [] }] },
        { kind: 'choice', id: 'mode', required: true, shared: [], options: [{ key: 'a', rows: [] }, { key: 'b', rows: [
          { ...field('dormant'), widget: { widgetType: 'INT', options: {}, default: 5,
            looked: { min: { lookup: 'inactive_for', args: ['1'] } } } },
        ] }] }],
    }, { type: 'IntSink', displayName: 'Sink', category: 'test', source: 'v3', isOutputNode: true, body: [field('value')] }])
    app.settings.set('features.appView.enabled', true)
    await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'cold-choice', root: 'root', graphs: {
      root: { id: 'root', name: 'root', nodes: {
        choice: { id: 'choice', type: 'Choices', values: { seed: 21 }, dynamic: { mode: { selected: 'a' } } },
        sink: { id: 'sink', type: 'IntSink', values: {} },
      }, links: { tap: { id: 'tap', from: { node: 'choice', port: 'mode.dormant' }, to: { node: 'sink', port: 'value' } } },
      nets: {}, reroutes: {}, nextOrdinal: 20 },
    }, view: { graphs: {} }, ext: { 'dinkster.exposed': ['pick', 'mode.dormant'].map((inputId) => ({ graphId: 'root', nodeId: 'choice', inputId })) } }, 'Cold selector')
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AppView app={app} />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('Pick 42'))
      expect(requests).toEqual(['gate_for'])
      expect(app.activeTab()!.store.dispatch({ command: 'node.setValue', params: {
        graphId: 'root', nodeId: 'choice', inputId: 'seed', value: 3,
      } }).ok).toBe(true)
      await vi.waitFor(() => expect(requests).toEqual(['gate_for', 'gate_for']))
      await vi.waitFor(() => expect(root.textContent).not.toContain('Pick '))
      expect(app.activeTab()!.store.dispatch({ command: 'node.setValue', params: {
        graphId: 'root', nodeId: 'choice', inputId: 'seed', value: 31,
      } }).ok).toBe(true)
      await vi.waitFor(() => expect(root.textContent).toContain('Pick 62'))
      expect(requests).toEqual(['gate_for', 'gate_for', 'gate_for'])
    } finally {
      dispose()
      root.remove()
      app.dispose()
      vi.unstubAllGlobals()
    }
  })

  it.each([0, 1, 2])('requests cold automatic values and hidden presentation dependencies at depth %s', async (depth) => {
    const requests: { function: string; args: number[]; nodeType: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/api/lookups')) return new Response('{}', { status: 503 })
      const call = JSON.parse(String(init?.body)) as typeof requests[number]
      requests.push(call)
      return new Response(JSON.stringify({ answer: call.args[0]! * 2 }), { headers: { 'content-type': 'application/json' } })
    })
    const field = (id: string) => ({ kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'INT' },
      optional: false, widget: { widgetType: 'INT', options: {}, default: 5 } })
    const app = createWorkflowApp([{
      type: 'Calculated', displayName: 'Calculated', category: 'test', source: 'v3', isOutputNode: true,
      body: [field('seed'), { ...field('hidden'), hidden: true, automatic: { lookup: 'hidden_for', args: ['seed'] } },
        { ...field('direct'), automatic: { lookup: 'total_for', args: ['seed'] } },
        { ...field('dependent'), automatic: { formula: 'hidden * 2' }, visible: { formula: 'hidden > 10' } },
        { ...field('unused'), automatic: { lookup: 'unused_for', args: ['seed'] } }],
    }])
    app.settings.set('features.appView.enabled', true)
    const bind = (id: string, node: string, port: string) => ({ kind: 'input', id, promoted: true, binds: { kind: 'port', node, port } })
    const graph = (id: string, nodes: unknown, body?: unknown) => ({ id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 20,
      ...(body === undefined ? {} : { boundary: { body } }) })
    const seed = depth === 0 ? 'seed' : depth === 1 ? 'start' : 'control'
    const direct = depth === 0 ? 'direct' : depth === 1 ? 'total' : 'result'
    const dependent = depth === 0 ? 'dependent' : depth === 1 ? 'calculated' : 'shown'
    const document = { format: 'dinkster-workflow', formatVersion: 1, lineage: `cold-app-${depth}`, root: 'root', graphs: {
      root: graph('root', Object.fromEntries([['first', 21], ['second', 13]].map(([id, value]) => [id, {
        id, type: depth === 0 ? 'Calculated' : depth === 1 ? '#detail' : '#portrait', values: { [seed]: value },
      }]))),
      ...(depth > 0 ? { detail: graph('detail', { sample: { id: 'sample', type: 'Calculated', values: { seed: 3 } } },
        [bind('start', 'sample', 'seed'), bind('total', 'sample', 'direct'), bind('calculated', 'sample', 'dependent')]) } : {}),
      ...(depth === 2 ? { portrait: graph('portrait', { detail: { id: 'detail', type: '#detail', values: { start: 7 } } },
        [bind('control', 'detail', 'start'), bind('result', 'detail', 'total'), bind('shown', 'detail', 'calculated')]) } : {}),
    }, view: { graphs: {} }, ext: { 'dinkster.exposed': ['first', 'second'].flatMap((nodeId) => [direct, dependent].map((inputId) => ({
      graphId: 'root', nodeId, inputId, label: `${nodeId} ${inputId}`,
    }))) } } as unknown as WorkflowDocument
    await app.openDocument(document, 'Cold calculations')
    const root = window.document.createElement('div')
    window.document.body.append(root)
    const dispose = render(() => <AppView app={app} />, root)
    try {
      const values = () => [...root.querySelectorAll<HTMLInputElement>('[data-testid="app-view-row"] input')].map((input) => input.value)
      await vi.waitFor(() => expect(values()).toEqual(['42', '84', '26', '52']))
      expect(requests.map((call) => [call.nodeType, call.function, call.args]).sort()).toEqual([
        ['Calculated', 'hidden_for', [13]], ['Calculated', 'hidden_for', [21]],
        ['Calculated', 'total_for', [13]], ['Calculated', 'total_for', [21]],
      ].sort())
      const store = app.activeTab()!.store
      expect(store.doc).toEqual(document)
      expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: seed, value: 3 } }).ok).toBe(true)
      await vi.waitFor(() => expect(values()).toEqual(['6', '26', '52']))
      expect(requests.some((call) => call.function === 'hidden_for' && call.args[0] === 3)).toBe(true)
      expect(store.doc.graphs.detail).toEqual(document.graphs.detail)
      expect(store.doc.graphs.portrait).toEqual(document.graphs.portrait)
      expect(store.undo()).toBe(true)
      await vi.waitFor(() => expect(values()).toEqual(['42', '84', '26', '52']))
      expect(store.doc).toEqual(document)
      const tab = app.activeTab()!
      const compiled = app.compileTab(tab)
      expect(compiled?.ok).toBe(true)
      if (!compiled?.ok) throw new Error('cold App View document did not compile')
      const backend = app.backendForTab(tab)
      const ref = { connection: backend.id, prompt: asPromptId(`cold-frozen-${depth}`) }
      app.store.register(ref, compiled.artifact, 1)
      expect(await app.openExecutionView(ref)).toBe(true)
      backend.lookups.invalidate()
      for (let i = 0; i < 30; i += 1) await Promise.resolve()
      expect(root.querySelectorAll('[data-testid="app-view-row"] input')).toHaveLength(0)
      expect(requests).toHaveLength(6)
    } finally {
      dispose()
      root.remove()
      app.dispose()
      vi.unstubAllGlobals()
    }
  })

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
      const editable = rows()[0]!.querySelector('input')!
      editable.value = '19'
      editable.dispatchEvent(new Event('input', { bubbles: true }))
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await vi.waitFor(() => expect(store.doc.graphs.root!.nodes.first!.values).toEqual({ [seed]: 21, [total]: 19 }))
      expect(store.doc.graphs.root!.nodes.second!.values).toEqual({ [seed]: 13 })
      expect(store.doc.graphs.detail).toEqual(document.graphs.detail)
      expect(store.doc.graphs.portrait).toEqual(document.graphs.portrait)
      expect(store.undo()).toBe(true)
      await Promise.resolve()
      expect(store.doc).toEqual(document)
      const draft = rows()[0]!.querySelector('input')!
      draft.value = '99'
      draft.dispatchEvent(new Event('input', { bubbles: true }))
      expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: seed, value: 13 } }).ok).toBe(true)
      draft.dispatchEvent(new Event('change', { bubbles: true }))
      draft.dispatchEvent(new Event('blur'))
      await Promise.resolve()
      expect(rows()[0]!.querySelector('input')).toBeNull()
      expect(store.doc.graphs.root!.nodes.first!.values).toEqual({ [seed]: 13 })
      expect(store.undo()).toBe(true)
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
