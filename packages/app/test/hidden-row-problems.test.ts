import { describe, expect, it } from 'vitest'
import { loadDocument, parseDinksterSchema, type Json } from '@dinkster/core'
import { buildScene, defaultTokens } from '@dinkster/canvas'
import { AppState } from '../src/app-state.js'
import { storedValueProblems } from '../src/CanvasHost.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

describe('a hidden row with a problem', () => {
  it('shows while its stored value is out of range, and hides again once it is fixed', () => {
    const int = { kind: 'concrete', types: ['INT'] }
    const schema = parseDinksterSchema('Sized', {
      schemaVersion: 2,
      nodeType: 'Sized',
      body: [
        { kind: 'input', id: 'w', type: int, required: true, default: 3, widget: { type: 'NUMBER', min: 0, max: 10 } },
        { kind: 'input', id: 'extra', type: int, required: true, default: 2, widget: { type: 'NUMBER', min: 0, max: 10 }, visible: { formula: 'w > 5' } },
      ],
    } as never).schema!
    expect(schema).toBeDefined()
    const registry = new AppState().widgetRegistry
    const fieldRows = (values: Record<string, Json>) => {
      const document = loadDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'hidden-row-problems', root: 'g',
        graphs: { g: { id: 'g', name: 'Root', nextOrdinal: 1, nodes: { n: { id: 'n', type: 'Sized', values } }, links: {}, nets: {}, reroutes: {} } },
        view: { graphs: { g: { nodes: { n: { position: { x: 0, y: 0 } } } } } },
      }).document!
      const scene = buildScene({
        document,
        graphId: 'g',
        resolve: () => schema,
        tokens: defaultTokens,
        measure: (text) => text.length * 7,
        widgetMeasure: () => ({ viewId: 'core.number', rows: 1 }),
        storedValueProblem: (row, value) => storedValueProblems(registry, 'g', row, value).some((d) => d.severity !== 'info'),
      })
      return scene.nodes[0]!.layout.rows.flatMap((row) => row.kind === 'widget' ? [row.valueKey] : [])
    }
    expect(fieldRows({ w: 3, extra: 4 })).toEqual(['w'])
    expect(fieldRows({ w: 3, extra: 50 })).toEqual(['w', 'extra'])
    expect(fieldRows({ w: 3, extra: 10 })).toEqual(['w'])
    expect(fieldRows({ w: 7, extra: 4 })).toEqual(['w', 'extra'])
  })
})
