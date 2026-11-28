import { describe, expect, it } from 'vitest'
import { asConnectionId, compile, loadDocument, parseDinksterSchema, type Json } from '@dinkster/core'
import { buildScene, defaultTokens } from '@dinkster/canvas'
import { AppState, diagnosticFocusPlan } from '../src/app-state.js'
import { storedValueProblems } from '../src/CanvasHost.js'
import { deriveProblemProjection } from '../src/problem-display.js'
import { problemBoxLines, problemBoxRows } from '../src/problem-box.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

describe('a hidden row with a problem', () => {
  it('names saved-value problems by their drawn row and node, not their storage address', () => {
    const registry = new AppState().widgetRegistry
    const cases = [
      { spec: { widgetType: 'INT', options: {} }, value: 'old text', message: 'The saved value does not fit this field.' },
      { spec: { widgetType: 'missing.kind', options: {} }, value: 7, message: 'This kind of field is not available; its saved value is shown as text.' },
      { spec: { widgetType: 'INT', options: { max: 6 } }, value: 7, message: '7 > max 6' },
      { spec: { widgetType: 'ASSET', options: {} }, value: 'input/missing.png', message: 'imported file "missing.png" is unavailable' },
    ]
    for (const { spec, value, message } of cases) {
      const diagnostics = storedValueProblems(registry, 'g', {
        nodeId: 'internal-node', inputId: 'internal-port', valueKey: 'private-storage-key',
        nodeTitle: 'Make capture.settings', label: 'seed', spec,
      }, value)
      expect(diagnostics).toHaveLength(1)
      const diagnostic = diagnostics[0]!
      expect(diagnostic.message).toBe(`Make capture.settings: seed: ${message}`)
      const projection = deriveProblemProjection({ diagnostics, graphId: 'g', instancePath: [] })
      const lines = problemBoxLines(projection.nodes['internal-node']!, [
        { key: 'private-storage-key', name: 'seed', field: true },
      ], () => 'seed')
      expect(lines).toMatchObject([{ message: `seed: ${message}` }])
      expect(projection.rows['internal-node']).toEqual({ 'private-storage-key': spec.widgetType === 'ASSET' ? 'error' : 'warning' })
      expect(diagnostic.refs?.[0]?.valueKey).toBe('private-storage-key')
    }
  })

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

  it('shows while a run needs a value it has none for, and hides again once one is stored', () => {
    const int = { kind: 'concrete', types: ['INT'] }
    const asset = { kind: 'concrete', types: ['ASSET'] }
    const image = { type: 'ASSET', accept: ['image/png'], kind: 'media/image' }
    const hiddenUnlessWide = { formula: 'w > 5' }
    const schema = parseDinksterSchema('Picky', {
      schemaVersion: 2,
      nodeType: 'Picky',
      body: [
        { kind: 'input', id: 'w', type: int, required: true, default: 3, widget: { type: 'NUMBER', min: 0, max: 10 } },
        { kind: 'input', id: 'image', type: asset, required: true, widget: image, visible: hiddenUnlessWide },
        { kind: 'input', id: 'model', type: { kind: 'concrete', types: ['COMBO'] }, required: true, widget: { type: 'COMBO', remote: { route: '/api/choices/models' } }, visible: hiddenUnlessWide },
        { kind: 'section', id: 'more', visible: hiddenUnlessWide, rows: [
          { kind: 'input', id: 'mask', type: asset, required: true, widget: image },
        ] },
        // A run sends these something without the user, so they stay hidden.
        { kind: 'input', id: 'steps', type: int, required: true, widget: { type: 'NUMBER', min: 1 }, visible: hiddenUnlessWide },
        { kind: 'input', id: 'extra', type: asset, required: false, widget: image, visible: hiddenUnlessWide },
        { kind: 'input', id: 'token', type: asset, required: true, hidden: true, widget: image },
        { kind: 'input', id: 'latest', type: asset, required: true, widget: image, default: 'latest', automatic: { lookup: 'files.latest', args: [] }, visible: hiddenUnlessWide },
      ],
    } as never).schema!
    expect(schema).toBeDefined()
    const registry = new AppState().widgetRegistry
    const fieldRows = (values: Record<string, Json>, mode?: 'muted' | 'bypassed') => {
      const document = loadDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'hidden-row-problems', root: 'g',
        graphs: { g: { id: 'g', name: 'Root', nextOrdinal: 1, nodes: { n: { id: 'n', type: 'Picky', values, ...(mode === undefined ? {} : { mode }) } }, links: {}, nets: {}, reroutes: {} } },
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
    const png = { digest: `blake3:${'a'.repeat(64)}`, name: 'cat.png', size: 10, mediaType: 'image/png', virtualPath: 'input/cat.png' }
    expect(fieldRows({ w: 3 })).toEqual(['w', 'image', 'model', 'mask'])
    expect(fieldRows({ w: 3, image: png, mask: png })).toEqual(['w', 'model'])
    expect(fieldRows({ w: 3, image: png, mask: png, model: 'sd15.safetensors' })).toEqual(['w'])
    // A muted or bypassed node does not run, so nothing is missing for it.
    expect(fieldRows({ w: 3 }, 'muted')).toEqual(['w'])
    expect(fieldRows({ w: 3 }, 'bypassed')).toEqual(['w'])
  })

  it('explains a declaration-hidden required field at the node, but still reveals a visible-hidden field', () => {
    for (const [hidden, duplicate] of [[true, true], [true, false], [false, true], [false, false]]) {
      const parsed = parseDinksterSchema('HiddenImage', {
        schemaVersion: 2, nodeType: 'HiddenImage', displayName: 'Describe image', outputNode: true,
        body: [{ kind: 'choice', id: 'source', required: true, ...(hidden ? { hidden: true } : { visible: { formula: '0 > 1' } }),
          options: [{ key: 'image', rows: [{ kind: 'section', id: 'details', rows: [
            { kind: 'input', id: 'image', label: 'Image', type: { kind: 'concrete', types: ['ASSET'] }, required: true,
              widget: { type: 'ASSET', accept: ['image/png'] } },
            { kind: 'input', id: 'mask', label: duplicate ? 'Image' : 'Mask', type: { kind: 'concrete', types: ['ASSET'] }, required: true,
              widget: { type: 'ASSET', accept: ['image/png'] } },
          ] }] }],
        }],
      } as never)
      expect(parsed.schema, JSON.stringify(parsed.diagnostics)).toBeDefined()
      const schema = parsed.schema!
      const document = loadDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'hidden-required', root: 'g',
        graphs: { g: { id: 'g', name: 'Root', nextOrdinal: 1, nodes: {
          n: { id: 'n', type: 'HiddenImage', values: {}, dynamic: { source: { selected: 'image' } } },
        }, links: {}, nets: {}, reroutes: {} } }, view: { graphs: {} },
      }).document!
      const resolve = () => schema
      const result = compile({ document, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test' })
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (!result.ok) continue
      const problems = result.artifact.diagnostics.filter((d) => d.code === 'compile.input.missing')
      expect(problems).toHaveLength(2)
      const diagnostic = problems[0]!
      expect(diagnostic.blocksExecution).toBe(true)
      expect(diagnostic.anchor?.port?.port).toBe(hidden ? undefined : 'source.image')
      expect(diagnosticFocusPlan(document, diagnostic.anchor)?.nodeId).toBe('n')
      const scene = buildScene({ document, graphId: 'g', resolve, tokens: defaultTokens,
        measure: (text) => text.length * 7, widgetMeasure: () => ({ viewId: 'core.asset', rows: 1 }),
      })
      expect(scene.nodes[0]!.layout.rows.some((row) => row.kind === 'widget' && row.valueKey === 'source.image')).toBe(!hidden)
      const projection = deriveProblemProjection({ diagnostics: problems, document, graphId: 'g', instancePath: [] })
      const lines = problemBoxLines(projection.nodes['n']!, problemBoxRows(scene.nodes[0]!), (row) => row)
      expect(lines).toHaveLength(2)
      expect(lines.map((line) => line.actions)).toEqual(hidden ? [[], []] : [['edit-field'], ['edit-field']])
      if (hidden) {
        const names = duplicate ? ['Image (source.image)', 'Image (source.mask)'] : ['Image', 'Mask']
        expect(lines.map((line) => line.rowName)).toEqual(names)
        expect(lines.map((line) => line.row)).toEqual([undefined, undefined])
        expect(lines.map((line) => line.message)).toEqual(names.map((name) =>
          `Describe image requires ${name} but hides it, so it cannot be set. The node's author has to fix this.`))
      }
    }
  })

  it('refuses a cleared required image and reveals it on a plain node and a whole-choice subgraph node', () => {
    const png = { digest: `blake3:${'a'.repeat(64)}`, name: 'cat.png', size: 10, mediaType: 'image/png', virtualPath: 'input/cat.png' }
    const schema = parseDinksterSchema('Images', {
      schemaVersion: 2, nodeType: 'Images', outputNode: true,
      body: [{ kind: 'choice', id: 'mode', required: true, options: [{ key: 'image', rows: [
        { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['ASSET'] }, required: true,
          widget: { type: 'ASSET', accept: ['image/png'] }, visible: { formula: '0 > 1' } },
        { kind: 'input', id: 'defaulted', type: { kind: 'concrete', types: ['ASSET'] }, required: true, default: png,
          widget: { type: 'ASSET', accept: ['image/png'] }, visible: { formula: '0 > 1' } },
        { kind: 'input', id: 'optional', type: { kind: 'concrete', types: ['ASSET'] }, required: false,
          widget: { type: 'ASSET', accept: ['image/png'] }, visible: { formula: '0 > 1' } },
      ] }] }],
    } as never).schema!
    const registry = new AppState().widgetRegistry
    for (const subgraph of [false, true]) for (const value of [null, png]) {
      const values = { 'mode.image': value, 'mode.defaulted': value, 'mode.optional': null }
      const node = { id: 'n', type: 'Images', values, dynamic: { mode: { selected: 'image' } } }
      const document = loadDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'cleared-image', root: 'g',
        graphs: {
          g: { id: 'g', name: 'Root', nextOrdinal: 1, nodes: {
            n: subgraph ? { id: 'n', type: '#body', values: {}, dynamic: { shown: { selected: 'image' } } } : node,
          }, links: {}, nets: {}, reroutes: {} },
          ...(subgraph ? { body: { id: 'body', name: 'Body', nextOrdinal: 1, nodes: { n: node }, links: {}, nets: {}, reroutes: {},
            boundary: { body: [{ kind: 'input', id: 'shown', binds: { kind: 'construct', node: 'n', port: 'mode' } }] },
          } } : {}),
        }, view: { graphs: {} },
      }).document!
      const resolve = (type: string) => type === 'Images' ? schema : undefined
      const result = compile({ document, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test' })
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (!result.ok) continue
      const problems = result.artifact.diagnostics.filter((problem) => problem.code === 'compile.input.missing')
      expect(problems.map((problem) => [problem.anchor?.port?.port, problem.blocksExecution])).toEqual(
        value === null ? [['mode.image', true], ['mode.defaulted', true]] : [],
      )
      expect(result.artifact.prompt[subgraph ? 'n.n' : 'n']!.inputs['mode.optional']).toBeNull()
      const scene = buildScene({
        document, graphId: document.root, resolve, tokens: defaultTokens,
        measure: (text) => text.length * 7, widgetMeasure: () => ({ viewId: 'core.asset', rows: 1 }),
        storedValueProblem: (row, stored) => storedValueProblems(registry, 'g', row, stored).some((problem) => problem.severity !== 'info'),
      })
      const prefix = subgraph ? 'shown' : 'mode'
      expect(scene.nodes[0]!.layout.rows.flatMap((row) => row.kind === 'widget' && row.valueKey !== prefix ? [row.valueKey] : []))
        .toEqual(value === null ? [`${prefix}.image`, `${prefix}.defaulted`] : [])
    }
  })
})
