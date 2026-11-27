// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { NodeSchema, WidgetSpec } from '@dinkster/core'
import { AppView } from '../src/AppView.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('shows each product value once and keeps canvas-only values out of read-only text', async () => {
  const specs: Record<string, WidgetSpec> = {
    text: { widgetType: 'STRING', options: {}, default: 'A quiet lake' },
    multiline: { widgetType: 'STRING', options: { multiline: true }, default: 'First line\nSecond line' },
    integer: { widgetType: 'INT', options: {}, default: 17 },
    floating: { widgetType: 'FLOAT', options: {}, default: 0.25 },
    list: { widgetType: 'LIST', options: {}, element: { widgetType: 'STRING', options: {} }, default: ['alpha', 'beta'] },
    boolean: { widgetType: 'BOOLEAN', options: {}, default: true },
    color: { widgetType: 'COLOR', options: {}, default: '#32e6c5' },
    combo: { widgetType: 'COMBO', options: { options: ['wide', 'square'] }, default: 'wide' },
    video: { widgetType: 'VIDEO_EDIT', options: {}, default: {} },
  }
  const schema: NodeSchema = {
    type: 'Controls', displayName: 'Controls', category: 'test', source: 'v3', isOutputNode: false,
    body: Object.entries(specs).map(([id, widget]) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widget.widgetType }, optional: false, widget,
    })),
  }
  const app = createWorkflowApp([schema, {
    type: 'Source', displayName: 'Source', category: 'test', source: 'v3', isOutputNode: false,
    body: Object.entries(specs).map(([id, widget]) => ({ kind: 'output', id, type: { kind: 'concrete', name: widget.widgetType } })),
  }])
  app.settings.set('features.appView.enabled', true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  await app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'single-values', root: 'root',
    graphs: { root: {
      id: 'root', name: 'Workflow', nextOrdinal: 30, nets: {}, reroutes: {},
      nodes: {
        editable: { id: 'editable', type: 'Controls', values: {} },
        connected: { id: 'connected', type: 'Controls', values: {} },
        source: { id: 'source', type: 'Source', values: {} },
      },
      links: Object.fromEntries(Object.keys(specs).map((id) => [id, { id, from: { node: 'source', port: id }, to: { node: 'connected', port: id } }])),
    } },
    view: { graphs: {} },
    ext: { 'dinkster.exposed': ['editable', 'connected'].flatMap((nodeId) => Object.keys(specs).map((inputId) => ({ graphId: 'root', nodeId, inputId, label: `${nodeId} ${inputId}` }))) },
  }, 'Single values')
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <AppView app={app} />, root)
  try {
    const rows = [...root.querySelectorAll('[data-testid="app-view-row"]')]
    expect(rows).toHaveLength(18)
    for (const [index, id] of Object.keys(specs).entries()) {
      const editable = rows[index]!
      const connected = rows[index + 9]!
      const readonly = connected.querySelector('[data-testid="app-view-readonly"]')!
      expect(readonly.textContent).toContain('Driven by a link - edit on the canvas')
      if (id === 'video') {
        expect(editable.querySelector('canvas')).not.toBeNull()
        expect(editable.querySelector('button')?.textContent).toContain('Edit')
        expect(connected.querySelector('canvas')).not.toBeNull()
        expect(readonly.textContent).not.toContain('{}')
        expect(readonly.getAttribute('aria-label')).toContain('connected video')
      } else {
        expect(editable.querySelector('canvas')).toBeNull()
        expect(connected.querySelector('canvas')).toBeNull()
        expect(editable.querySelector('input, textarea, button')).not.toBeNull()
        if (id === 'boolean') {
          const checkbox = readonly.querySelector<HTMLButtonElement>('[role="checkbox"]')!
          expect(checkbox.disabled).toBe(true)
          expect(checkbox.getAttribute('aria-checked')).toBe('true')
          expect(readonly.textContent).not.toContain('true')
          checkbox.click()
          expect(checkbox.getAttribute('aria-checked')).toBe('true')
        } else {
          expect(readonly.textContent).toContain(typeof specs[id]!.default === 'string' ? specs[id]!.default : JSON.stringify(specs[id]!.default))
        }
      }
    }
  } finally {
    dispose()
    app.dispose()
  }
})
