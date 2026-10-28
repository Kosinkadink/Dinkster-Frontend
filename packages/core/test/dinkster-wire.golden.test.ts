import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { importLitegraph, resolveImportedAssetLiterals } from '../src/format/import-litegraph.js'
import { asConnectionId } from '../src/ids.js'
import {
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchema,
} from '../src/schema/dinkster-wire.js'
import { inputsOf, outputsOf } from '../src/schema/model.js'

const concrete = (name: string) => ({ kind: 'concrete', types: [name] })

describe('Dinkster schema wire', () => {
  it('preserves native asset-selection schemas and imported source names', () => {
    for (const kind of ['model/vae', 'model/diffusers', 'directory/input', 'directory/dataset']) {
      const types = [concrete('COMBO'), ...(kind === 'model/vae' ? [{ kind: 'union', types: ['COMBO', 'ASSET'] }] : [])]
      const source = kind === 'model/vae' ? 'pixel_space' : 'nested/source'
      for (const type of types) {
        const result = parseDinksterSchema('SourceSelection', { interface: [
          { role: 'input', id: 'source', type, widget: { type: 'ASSET', accept: [], kind, selection: true } },
          { role: 'input', id: 'file', type: concrete('ASSET'), widget: { type: 'ASSET', accept: [] } },
        ] })
        expect(result.diagnostics).toEqual([])
        expect(inputsOf(result.schema!)[0]!.widget).toMatchObject({ widgetType: 'ASSET', kind, selection: true })
        const resolve = () => result.schema
        const imported = importLitegraph({ nodes: [{ id: 1, type: 'SourceSelection', widgets_values: [source, 'ordinary.vae'] }], links: [] }, resolve)
        const descriptor = { digest: `blake3:${'a'.repeat(64)}`, name: 'ordinary.vae', size: 17, mediaType: 'application/octet-stream', virtualPath: 'mounts/vae/ordinary.vae' }
        const resolved = resolveImportedAssetLiterals(imported.document!, resolve, () => descriptor)
        expect(resolved.unresolved).toEqual([])
        expect(resolved.document.graphs.g0!.nodes.n1!.values).toEqual({ source, file: descriptor })
        const linked = importLitegraph({ nodes: [
          { id: 1, type: 'SourceSelection', inputs: [{ name: 'source', type: 'COMBO', link: 7 }], widgets_values: [source, 'ordinary.vae'] },
          { id: 2, type: 'PrimitiveNode', outputs: [{ name: 'COMBO', type: 'COMBO', links: [7] }], widgets_values: [source] },
        ], links: [[7, 2, 0, 1, 0, 'COMBO']] }, (nodeType) => nodeType === 'SourceSelection' ? result.schema : undefined)
        expect(linked.document).toBeDefined()
        const linkedResolved = resolveImportedAssetLiterals(linked.document!, resolve, () => descriptor)
        expect(linkedResolved.unresolved).toEqual([])
        expect(Object.values(linkedResolved.document.graphs.g0!.valueSources!)[0]!.value).toBe(source)
      }
    }
  })

  it('rejects invalid native asset-selection contracts without widening ordinary assets', () => {
    const union = { kind: 'union', types: ['COMBO', 'ASSET'] }
    for (const [type, widget] of [
      [concrete('COMBO'), { kind: 'media/image', selection: true }],
      [concrete('COMBO'), { kind: 'model/vae', selection: 'true' }],
      [concrete('COMBO'), { kind: 'model/vae', selection: true, allowUpload: true }],
      [concrete('ASSET'), { kind: 'model/vae', selection: true }],
      [union, { kind: 'model/diffusers', selection: true }],
      [union, { kind: 'model/vae', selection: false }],
    ]) {
      const result = parseDinksterSchema('InvalidSelection', { interface: [
        { role: 'input', id: 'source', type, widget: { type: 'ASSET', accept: [], ...widget } },
      ] })
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
    }
  })

  it('binds color pickers to native COLOR or STRING without rewriting socket types', () => {
    for (const socket of ['COLOR', 'STRING']) {
      const result = parseDinksterSchema('ColorPicker', { interface: [
        { role: 'input', id: 'color', type: concrete(socket), default: '#12ab34cd', widget: { type: 'COLOR' } },
        { role: 'output', id: 'hex', type: concrete(socket) },
      ] })
      expect(result.diagnostics).toEqual([])
      expect(inputsOf(result.schema!)[0]).toMatchObject({
        type: { kind: 'concrete', name: socket },
        widget: { widgetType: 'COLOR', default: '#12ab34cd' },
      })
      expect(outputsOf(result.schema!)[0]!.type).toEqual({ kind: 'concrete', name: socket })
    }
    for (const type of [concrete('INT'), concrete('COMBO'), { kind: 'list', element: concrete('COLOR') }]) {
      const result = parseDinksterSchema('InvalidColorPicker', { interface: [
        { role: 'input', id: 'color', type, widget: { type: 'COLOR' } },
      ] })
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
    }
  })

  it('decodes historical input-family templates and rejects malformed declarations without losing the node', () => {
    const rule = (sourceTemplate: unknown) => ({
      from: 'OldNode', cases: [{ to: 'NewNode', inputFamilies: { values: {
        kind: 'copy', sourceFamily: 'operands', sourceTemplate,
        inputs: { value: { kind: 'copy', input: 'right' } },
      } } }],
    })
    for (const sourceTemplate of [
      { inputs: ['left', 'right'] },
      { inputs: ['right'], memberPort: 'operands.item' },
    ]) {
      const replacement = rule(sourceTemplate)
      const parsed = parseDinksterSchema('NewNode', { interface: [], replacements: [replacement] })
      expect(parsed.diagnostics).toEqual([])
      expect(parsed.schema?.replacements).toEqual([replacement])
    }
    for (const sourceTemplate of [
      null, [], {}, { inputs: [] }, { inputs: ['right', 'right'] },
      { inputs: ['left'] }, { inputs: ['bad.path', 'right'] },
      { inputs: ['right'], unknown: true }, { inputs: ['right'], memberPort: null },
      { inputs: ['right'], memberPort: '' }, { inputs: ['right'], memberPort: 'bad..path' },
      { inputs: ['left', 'right'], memberPort: 'operands.item' },
    ]) {
      const parsed = parseDinksterSchema('NewNode', { interface: [], replacements: [rule(sourceTemplate)] })
      expect(parsed.schema?.type).toBe('NewNode')
      expect(parsed.schema?.replacements).toBeUndefined()
      expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: 'schema.dinkster.badReplacements' }))
    }
  })

  it('keeps hidden DynamicCombo selectors presentation-only through import and compile', () => {
    for (const hidden of [undefined, false, true]) {
      const result = parseDinksterSchema('HiddenSelector', {
        outputNode: true,
        interface: [{ role: 'dynamicCombo', id: 'codec', hidden, options: [
          { key: 'auto', inputs: [{ role: 'input', id: 'quality', type: concrete('INT'), default: 7 }] },
          { key: 'custom', inputs: [{ role: 'input', id: 'quality', type: concrete('INT'), default: 13 }] },
        ] }],
      })
      expect(result.diagnostics).toEqual([])
      expect(inputsOf(result.schema!)[0]!.hidden).toBe(hidden === true ? true : undefined)
      const resolve = (type: string) => type === 'HiddenSelector' ? result.schema : undefined
      const imported = importLitegraph({ nodes: [{ id: 1, type: 'HiddenSelector', widgets_values: ['custom', 29] }], links: [] }, resolve)
      const node = imported.document!.graphs.g0!.nodes.n1!
      expect(node.dynamic?.codec?.selected).toBe('custom')
      expect(node.values['codec.quality']).toBe(29)
      const before = JSON.stringify(imported.document)
      const compiled = compile({ document: imported.document!, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('hidden-selector'), schemaHash: 'hidden-selector' })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('hidden selector compilation failed')
      expect(compiled.artifact.prompt.n1!.inputs).toEqual({ codec: 'custom', 'codec.quality': 29 })
      expect(JSON.stringify(imported.document)).toBe(before)
    }
    for (const hidden of [null, 0, 'true', {}]) {
      const result = parseDinksterSchema('InvalidHiddenSelector', { interface: [
        { role: 'dynamicCombo', id: 'codec', hidden, options: [{ key: 'auto', inputs: [] }] },
      ] })
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics[0]?.message).toContain('hidden')
    }
  })

  it('decodes native replacement rules without applying them during ComfyUI import', () => {
    const wire = {
      outputNode: true,
      deprecation: { message: 'Use the current node', replacement: 'CurrentNode' },
      searchVisibility: 'deprecated',
      interface: [{ role: 'input', id: 'value', type: concrete('INT'), default: 7 }],
      replacements: [{ from: 'AuthoredNode', cases: [{ to: 'OtherNode' }] }],
    }
    const result = parseDinksterSchema('AuthoredNode', wire)
    expect(result.diagnostics).toEqual([])
    expect(result.schema).toMatchObject({
      type: 'AuthoredNode', deprecation: wire.deprecation, searchVisibility: 'deprecated',
    })
    expect(result.schema?.replacements).toEqual(wire.replacements)
    const imported = importLitegraph({ nodes: [{ id: 1, type: 'AuthoredNode', widgets_values: [19] }], links: [] },
      (type) => type === 'AuthoredNode' ? result.schema : undefined)
    expect(imported.document!.graphs.g0!.nodes.n1).toMatchObject({ type: 'AuthoredNode', values: { value: 19 } })
  })

  it('keeps current nodes available when migration advice is malformed', () => {
    const valid = { from: 'OldNode', cases: [{ to: 'CurrentNode' }] }
    for (const replacements of [false, [null, valid, { from: 'OldNode', cases: [] }]]) {
      const result = parseDinksterSchema('CurrentNode', {
        interface: [{ role: 'input', id: 'value', type: concrete('INT'), default: 7 }],
        replacements,
      })
      expect(result.schema?.type).toBe('CurrentNode')
      expect(inputsOf(result.schema!)[0]?.widget?.default).toBe(7)
      expect(result.schema?.replacements).toEqual(Array.isArray(replacements) ? [valid] : undefined)
      expect(result.diagnostics.map(({ severity, code }) => ({ severity, code }))).toEqual(
        Array.from({ length: Array.isArray(replacements) ? 2 : 1 }, () => ({
          severity: 'warning', code: 'schema.dinkster.badReplacements',
        })),
      )
    }
  })

  it('preserves mixed COMBO scalar identity through defaults, import, and compile', () => {
    const values = ['auto', 8, 10, '8', true, 1, false, 1.25, ''] as const
    for (const value of values) {
      const result = parseDinksterSchema('ScalarCombo', {
        outputNode: true,
        interface: [{ role: 'input', id: 'depth', type: concrete('COMBO'), default: value,
          widget: { type: 'COMBO', options: ['auto', 8, 10, { value: '8', label: 'String eight' }, { value: true, label: 'Enabled' }, 1, false, 1.25, ''] } }],
      })
      expect(result.diagnostics).toEqual([])
      expect(result.schema).toBeDefined()
      const resolve = (type: string) => type === 'ScalarCombo' ? result.schema : undefined
      for (const widgets_values of [[], [value], { depth: value }]) {
        const imported = importLitegraph({ nodes: [{ id: 1, type: 'ScalarCombo', widgets_values }], links: [] }, resolve)
        const compiled = compile({ document: imported.document!, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('scalars'), schemaHash: 'scalars' })
        expect(compiled.ok, compiled.ok ? undefined : JSON.stringify(compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('scalar compilation failed')
        expect(compiled.artifact.prompt.n1!.inputs.depth).toBe(value)
        expect(JSON.parse(JSON.stringify(compiled.artifact.prompt)).n1.inputs.depth).toBe(value)
      }
    }
    // Even a mismatched option vocabulary must never coerce an authored scalar.
    const schema = parseDinksterSchema('StringCombo', { outputNode: true, interface: [
      { role: 'input', id: 'depth', type: concrete('COMBO'), widget: { type: 'COMBO', options: ['8', { value: 'enabled', label: 'Enabled' }] } },
    ] }).schema!
    for (const value of [8, 'Enabled']) {
      const imported = importLitegraph({ nodes: [{ id: 1, type: 'StringCombo', widgets_values: [value] }], links: [] }, () => schema)
      expect(imported.document!.graphs.g0!.nodes.n1!.values.depth).toBe(value)
    }
  })

  it('rejects non-scalar COMBO options without widening MULTI_COMBO or dynamic keys', () => {
    for (const value of [null, [], {}, Number.NaN, Infinity, -Infinity]) {
      for (const option of [value, { value, label: 'Invalid' }]) {
        expect(parseDinksterSchema('InvalidCombo', { interface: [
          { role: 'input', id: 'depth', type: concrete('COMBO'), widget: { type: 'COMBO', options: [option] } },
        ] }).schema).toBeUndefined()
      }
    }
    for (const value of [8, true]) {
      expect(parseDinksterSchema('InvalidMulti', { interface: [
        { role: 'input', id: 'depth', type: { kind: 'list', element: concrete('COMBO') }, widget: { type: 'MULTI_COMBO', options: [value] } },
      ] }).schema).toBeUndefined()
      expect(parseDinksterSchema('InvalidDynamic', { interface: [
        { role: 'dynamicCombo', id: 'depth', options: [{ key: value, inputs: [] }] },
      ] }).schema).toBeUndefined()
    }
  })

  it('keeps socketless widget values positional and compilable in direct and nested inputs', () => {
    const fields = [
      { role: 'input', id: 'color', type: concrete('STRING'), default: '#123456', socketless: true, widget: { type: 'COLOR' } },
      { role: 'input', id: 'amount', type: concrete('INT'), default: 7 },
    ]
    for (const nested of [false, true]) {
      const result = parseDinksterSchema('SocketlessFixture', {
        outputNode: true,
        interface: nested ? [{ role: 'dynamicCombo', id: 'style', options: [{ key: 'solid', inputs: fields }] }] : fields,
      })
      expect(result.diagnostics).toEqual([])
      const resolve = (type: string) => type === 'SocketlessFixture' ? result.schema : undefined
      for (const [widgets, color, amount] of [
        [[], '#123456', 7], [['#abcdef', 19], '#abcdef', 19],
      ] as const) {
        const imported = importLitegraph({ nodes: [{ id: 1, type: 'SocketlessFixture', widgets_values: nested ? ['solid', ...widgets] : widgets }], links: [] }, resolve)
        const compiled = compile({ document: imported.document!, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('socketless'), schemaHash: 'socketless' })
        expect(compiled.ok, compiled.ok ? undefined : JSON.stringify(compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('socketless compilation failed')
        expect(compiled.artifact.prompt.n1!.inputs).toEqual(nested ? { style: 'solid', 'style.color': color, 'style.amount': amount } : { color, amount })
      }
    }
  })

  it('validates socketless flags in every ordinary input scope', () => {
    const scopes = [
      (inputs: unknown[]) => inputs,
      (inputs: unknown[]) => [{ role: 'dynamicCombo', id: 'style', options: [{ key: 'solid', inputs }] }],
      (inputs: unknown[]) => [{ role: 'inputFamily', id: 'colors', memberPrefix: 'color', template: inputs }],
    ]
    const field = { role: 'input', id: 'color', type: concrete('STRING'), default: '#123456', widget: { type: 'COLOR' } }
    for (const scope of scopes) {
      for (const socketless of [undefined, false, true]) {
        const result = parseDinksterSchema('SocketlessFixture', { interface: scope([{ ...field, socketless }]) })
        expect(result.diagnostics).toEqual([])
        expect(result.schema).toBeDefined()
      }
      for (const invalid of [
        ...[null, 0, 1, 'true', [], {}].map((socketless) => ({ ...field, socketless })),
        { ...field, socketless: true, forceInput: true },
      ]) {
        const result = parseDinksterSchema('InvalidSocketless', { interface: scope([invalid]) })
        expect(result.schema).toBeUndefined()
        expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
      }
    }
  })

  it('keeps an appended mount separate from its adjacent prefix and original positional inputs', () => {
    const result = parseDinksterSchema('SaveFixture', {
      schemaVersion: 1,
      outputNode: true,
      interface: [
        { role: 'input', id: 'filename_prefix', type: concrete('STRING'), default: 'output' },
        { role: 'input', id: 'quality', type: concrete('INT'), default: 85 },
        { role: 'input', id: 'mount', type: concrete('STRING'), required: false, default: null, widget: { type: 'MOUNT' }, adjacentTo: 'filename_prefix' },
      ],
    })
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!).map((input) => input.id)).toEqual(['filename_prefix', 'quality', 'mount'])
    expect(inputsOf(result.schema!)[0]).not.toHaveProperty('adjacentTo')
    expect(inputsOf(result.schema!)[2]).toMatchObject({
      adjacentTo: 'filename_prefix', optional: true,
      type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'MOUNT', options: {}, default: null },
    })
    const resolve = (type: string) => type === 'SaveFixture' ? result.schema : undefined
    for (const [widgets_values, expected] of [
      [['frames/day', 73], { filename_prefix: 'frames/day', quality: 73, mount: null }],
      [['frames/default', 42, null], { filename_prefix: 'frames/default', quality: 42, mount: null }],
      [['frames/night', 61, 'archive'], { filename_prefix: 'frames/night', quality: 61, mount: 'archive' }],
    ] as const) {
      const imported = importLitegraph({ nodes: [{ id: 1, type: 'SaveFixture', widgets_values }], links: [] }, resolve)
      expect(imported.diagnostics.map((item) => item.code)).toEqual(widgets_values.length === 2 ? ['import.widgets.missing'] : [])
      const compiled = compile({ document: imported.document!, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('mount-test'), schemaHash: 'mount-test' })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('mount fixture compilation failed')
      expect(compiled.artifact.prompt.n1!.inputs).toEqual(expected)
    }
  })

  it('rejects invalid mount descriptors and non-sibling adjacency references', () => {
    const prefix = { role: 'input', id: 'prefix', type: concrete('STRING') }
    const mount = { role: 'input', id: 'mount', type: concrete('STRING'), required: false, widget: { type: 'MOUNT' }, adjacentTo: 'prefix' }
    for (const invalid of [
      { ...mount, widget: { type: 'MOUNT', options: ['archive'] } },
      { ...mount, type: concrete('INT') },
      ...['', 'missing', 'mount', null, 4].map((adjacentTo) => ({ ...mount, adjacentTo })),
    ]) {
      const result = parseDinksterSchema('BadMount', { interface: [prefix, invalid] })
      expect(result.schema, JSON.stringify(invalid)).toBeUndefined()
      expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
    }
  })

  it('rejects adjacency cycles in each sibling scope without rejecting acyclic chains', () => {
    const field = (id: string, adjacentTo?: string) => ({ role: 'input', id, type: concrete('STRING'), ...(adjacentTo === undefined ? {} : { adjacentTo }) })
    const scopes = [
      (inputs: unknown[]) => inputs,
      (inputs: unknown[]) => [{ role: 'inputFamily', id: 'files', memberPrefix: 'file', template: inputs }],
      (inputs: unknown[]) => [{ role: 'dynamicCombo', id: 'mode', options: [{ key: 'save', inputs }] }],
    ]
    for (const scope of scopes) {
      for (const inputs of [
        [field('a', 'b'), field('b', 'a')],
        [field('a', 'b'), field('b', 'c'), field('c', 'a')],
      ]) {
        const result = parseDinksterSchema('CycleFixture', { interface: scope(inputs) })
        expect(result.schema).toBeUndefined()
        expect(result.diagnostics.some((item) => item.message.includes('adjacentTo cycle'))).toBe(true)
      }
      const valid = parseDinksterSchema('ChainFixture', { interface: scope([field('a'), field('b', 'a'), field('c', 'b')]) })
      expect(valid.diagnostics).toEqual([])
      expect(valid.schema).toBeDefined()
    }
  })

  it('renders numeric-only unions as FLOAT without changing imported numeric values or socket types', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/dinkster-nodes.json', import.meta.url), 'utf8'))
    const production = parseDinksterSchema('test.numeric_union', fixture.nodes['test.numeric_union'])
    expect(production.diagnostics).toEqual([])
    expect(inputsOf(production.schema!)[0]).toMatchObject({
      type: { kind: 'union', names: ['FLOAT', 'INT'] },
      widget: { widgetType: 'FLOAT', default: 25, options: { min: 1, max: 1000, step: 0.01, display: 'number' } },
    })
    const widget = { type: 'NUMBER', min: 1, max: 1000, step: 0.01, round: false, display: 'number' }
    for (const types of [['FLOAT', 'INT'], ['INT', 'FLOAT']]) {
      const decoded = parseDinksterSchema('NumericUnion', {
        schemaVersion: 1,
        outputNode: true,
        interface: [{ role: 'input', id: 'frame_rate', type: { kind: 'union', types }, required: true, default: 25, widget }],
      })
      expect(decoded.diagnostics).toEqual([])
      expect(inputsOf(decoded.schema!)[0]).toMatchObject({
        type: { kind: 'union', names: types },
        widget: { widgetType: 'FLOAT', default: 25, options: { min: 1, max: 1000, step: 0.01, round: false, display: 'number' } },
      })
      const resolve = (type: string) => type === 'NumericUnion' ? decoded.schema : undefined
      for (const value of [24, 23.976]) {
        for (const widgets_values of [[value], { frame_rate: value }]) {
          const imported = importLitegraph({ version: 0.4, nodes: [{ id: 1, type: 'NumericUnion', widgets_values }], links: [] }, resolve)
          expect(imported.diagnostics).toEqual([])
          const compiled = compile({ document: imported.document!, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('numeric-union'), schemaHash: 'numeric-union' })
          expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
          if (!compiled.ok) throw new Error('numeric union compilation failed')
          expect(compiled.artifact.prompt.n1!.inputs).toEqual({ frame_rate: value })
        }
      }
      const represented = parseDinksterSchema('NumericUnion', {
        schemaVersion: 1,
        interface: [{ role: 'input', id: 'frame_rate', type: { kind: 'union', types }, required: true, widget: {
          type: 'REPRESENTATIONS', default: 'number', userSwitchable: false,
          representations: [{ id: 'number', widget: { ...widget, round: 0.01 } }],
        } }],
      })
      expect(represented.diagnostics).toEqual([])
      expect(inputsOf(represented.schema!)[0]!.widget).toMatchObject({ widgetType: 'FLOAT', options: { round: 0.01 } })
    }
  })

  it('preserves forced FLOATS sockets with numeric presentation and rejects unforced or list substitutes', () => {
    const widget = { type: 'NUMBER', min: -1, step: 0.001 }
    const representations = { type: 'REPRESENTATIONS', default: 'number', userSwitchable: false,
      representations: [{ id: 'number', widget }] }
    for (const descriptor of [widget, representations]) {
      const entry = { role: 'input', id: 'strengths', type: concrete('FLOATS'), forceInput: true, default: -1, widget: descriptor }
      const decoded = parseDinksterSchema('ForcedFloats', { interface: [entry] })
      expect(decoded.diagnostics).toEqual([])
      expect(inputsOf(decoded.schema!)[0]).toMatchObject({
        type: { kind: 'concrete', name: 'FLOATS' }, forceInput: true,
        widget: { widgetType: 'FLOAT', default: -1, options: { min: -1, step: 0.001 } },
      })
      for (const invalid of [
        { ...entry, forceInput: false },
        { ...entry, forceInput: undefined },
        { ...entry, type: { kind: 'list', element: concrete('FLOATS') } },
      ]) {
        const rejected = parseDinksterSchema('BadFloatsPresentation', { interface: [invalid] })
        expect(rejected.schema).toBeUndefined()
        expect(rejected.diagnostics.some((item) => item.severity === 'error')).toBe(true)
      }
    }
  })

  it('keeps numeric union widget support closed to the INT/FLOAT scalar domain', () => {
    for (const type of [
      { kind: 'union', types: ['FLOAT', 'STRING'] },
      { kind: 'union', types: ['FLOAT', 'INT', 'BOOLEAN'] },
      { kind: 'union', types: ['INT', 'BOOLEAN'] },
      { kind: 'list', element: { kind: 'union', types: ['INT', 'FLOAT'] } },
      { kind: 'wildcard' },
    ]) {
      const decoded = parseDinksterSchema('BadNumericUnion', {
        schemaVersion: 1,
        interface: [{ role: 'input', id: 'value', type, required: true, widget: { type: 'NUMBER', min: 1, step: 0.01 } }],
      })
      expect(decoded.schema).toBeUndefined()
      expect(decoded.diagnostics.some((item) => item.severity === 'error')).toBe(true)
    }
  })

  it('binds primitive list widgets without changing their socket or scalar output', () => {
    for (const [name, widget] of [
      ['STRING', { type: 'STRING', multiline: false }],
      ['INT', { type: 'NUMBER', min: -7, max: 19 }],
      ['FLOAT', { type: 'NUMBER', round: false }],
    ] as const) {
      const result = parseDinksterSchema('ListConsumer', {
        schemaVersion: 1,
        interface: [
          { role: 'input', id: 'values', type: { kind: 'list', element: concrete(name) }, required: true, widget },
          { role: 'output', id: 'result', type: concrete(name) },
        ],
      })
      expect(result.diagnostics).toEqual([])
      const input = inputsOf(result.schema!)[0]!
      expect(input.type).toEqual({ kind: 'list', element: { kind: 'concrete', name } })
      expect(input.widget).toEqual({
        widgetType: 'LIST', options: {},
        element: { widgetType: name, options: name === 'STRING' ? { multiline: false } : name === 'INT' ? { min: -7, max: 19 } : { round: false } },
      })
      expect(outputsOf(result.schema!)[0]!.type).toEqual({ kind: 'concrete', name })
    }
  })

  it('preserves list widget arrays through positional and keyed workflow import and compilation', () => {
    const decoded = parseDinksterSchema('ListConsumer', {
      schemaVersion: 1,
      outputNode: true,
      interface: [
        { role: 'input', id: 'texts', type: { kind: 'list', element: concrete('STRING') }, required: true, widget: { type: 'STRING', multiline: false } },
        { role: 'input', id: 'tail', type: concrete('INT'), required: true, widget: { type: 'NUMBER', min: 0 } },
      ],
    })
    expect(decoded.diagnostics).toEqual([])
    const resolve = (type: string) => type === 'ListConsumer' ? decoded.schema : undefined
    const texts = ['one,two', '', 'line\nnext']
    for (const widgets_values of [[texts, 17], { texts, tail: 17 }]) {
      const imported = importLitegraph({
        version: 0.4,
        nodes: [{ id: 1, type: 'ListConsumer', widgets_values }],
        links: [],
      }, resolve)
      expect(imported.diagnostics).toEqual([])
      expect(imported.document!.graphs.g0!.nodes.n1!.values).toEqual({ texts, tail: 17 })
      const compiled = compile({
        document: imported.document!, revision: 1, resolve, scope: { kind: 'full' },
        connection: asConnectionId('list-test'), schemaHash: 'list-test',
      })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('list workflow compilation failed')
      expect(compiled.artifact.prompt.n1!.inputs).toEqual({ texts, tail: 17 })
    }
  })

  it('rejects mismatched and nested primitive-list widget bindings', () => {
    for (const element of [concrete('INT'), { kind: 'list', element: concrete('STRING') }]) {
      const result = parseDinksterSchema('BadList', {
        schemaVersion: 1,
        interface: [{ role: 'input', id: 'values', type: { kind: 'list', element }, required: true, widget: { type: 'STRING', multiline: false } }],
      })
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
    }
  })

  it('accepts only wire version 1 at the envelope and entry boundaries', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(1)

    const current = parseDinksterNodes({
      schemaVersion: 1,
      nodes: { Current: { schemaVersion: 1, interface: [] } },
    })
    expect(current.diagnostics).toEqual([])
    expect([...current.schemas.keys()]).toEqual(['Current'])

    for (const schemaVersion of [0, 2, 44]) {
      const envelope = parseDinksterNodes({ schemaVersion, nodes: {} })
      expect(envelope.schemas.size).toBe(0)
      expect(envelope.diagnostics).toEqual([
        expect.objectContaining({ severity: 'error', code: 'schema.dinkster.wireVersion' }),
      ])
    }

    const entry = parseDinksterNodes({
      schemaVersion: 1,
      nodes: {
        Current: { schemaVersion: 1, interface: [] },
        Stale: { schemaVersion: 2, interface: [] },
      },
    })
    expect([...entry.schemas.keys()]).toEqual(['Current'])
    expect(entry.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.dinkster.wireVersion' }),
    ])
  })

  it('decodes every current widget descriptor through the single parser', () => {
    const result = parseDinksterSchema('WidgetCatalog', {
      schemaVersion: 1,
      editorRole: 'custom-editor',
      mayExpandGraph: true,
      interface: [
        { role: 'input', id: 'asset', type: concrete('ASSET'), required: true, widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image' } },
        { role: 'input', id: 'mount', type: concrete('STRING'), required: false, default: null, widget: { type: 'MOUNT' } },
        { role: 'input', id: 'combo', type: concrete('COMBO'), required: true, default: 'a', widget: { type: 'COMBO', options: ['a'] } },
        { role: 'input', id: 'multi', type: { kind: 'list', element: concrete('COMBO') }, required: true, default: ['a'], widget: { type: 'MULTI_COMBO', options: ['a'] } },
        { role: 'input', id: 'boolean', type: concrete('BOOLEAN'), required: true, default: true, widget: { type: 'BOOLEAN', labelOn: 'On' } },
        { role: 'input', id: 'number', type: concrete('FLOAT'), required: true, default: 0.5, widget: { type: 'NUMBER', min: 0, max: 1 } },
        { role: 'input', id: 'string', type: concrete('STRING'), required: true, default: '', widget: { type: 'STRING', multiline: true } },
        { role: 'input', id: 'color', type: concrete('STRING'), required: true, default: '#000000', widget: { type: 'COLOR' } },
        { role: 'input', id: 'curve', type: concrete('CURVE'), required: true, widget: { type: 'CURVE' } },
        { role: 'input', id: 'compositor', type: concrete('COMPOSITOR'), required: true, widget: { type: 'COMPOSITOR' } },
        {
          role: 'input',
          id: 'representations',
          type: concrete('STRING'),
          required: true,
          default: '',
          widget: {
            type: 'REPRESENTATIONS',
            default: 'text',
            userSwitchable: true,
            representations: [
              { id: 'text', displayName: 'Text', widget: { type: 'STRING', multiline: true } },
              { id: 'color', displayName: 'Color', widget: { type: 'COLOR' } },
            ],
          },
        },
        { role: 'input', id: 'custom', type: concrete('extension.value'), required: false, widget: { type: 'extension.widget', nested: { enabled: true, values: [1, null, 'two'] } } },
      ],
    })

    expect(result.diagnostics).toEqual([])
    expect(result.schema?.editorRole).toBe('custom-editor')
    expect(result.schema?.mayExpandGraph).toBe(true)
    expect(inputsOf(result.schema!).map((input) => input.widget?.widgetType)).toEqual([
      'ASSET',
      'MOUNT',
      'COMBO',
      'MULTI_COMBO',
      'BOOLEAN',
      'FLOAT',
      'STRING',
      'COLOR',
      'CURVE',
      'COMPOSITOR',
      'STRING',
      'extension.widget',
    ])
    expect(inputsOf(result.schema!)[10]!.widget?.representations).toEqual({
      default: 'text',
      userSwitchable: true,
      representations: [
        expect.objectContaining({
          id: 'text',
          displayName: 'Text',
          widget: expect.objectContaining({ widgetType: 'STRING' }),
        }),
        expect.objectContaining({
          id: 'color',
          displayName: 'Color',
          widget: expect.objectContaining({ widgetType: 'COLOR' }),
        }),
      ],
    })
    expect(inputsOf(result.schema!).at(-1)?.widget?.options).toEqual({ nested: { enabled: true, values: [1, null, 'two'] } })
  })

  it('preserves exact integer constraints and rejects widgets on a different scalar domain', () => {
    const parse = (socket: string, widget: object) => parseDinksterSchema('Scalar', {
      schemaVersion: 1,
      interface: [{ role: 'input', id: 'value', type: concrete(socket), required: true, widget }],
    })
    const integer = parse('INT', { type: 'NUMBER', min: '-9223372036854775808', max: '18446744073709551615', step: 1 })
    expect(integer.diagnostics).toEqual([])
    expect(inputsOf(integer.schema!)[0]?.widget).toMatchObject({
      widgetType: 'INT', options: { min: '-9223372036854775808', max: '18446744073709551615', step: 1 },
    })
    for (const [socket, widget] of [
      ['STRING', { type: 'NUMBER' }],
      ['FLOAT', { type: 'NUMBER', min: '-9223372036854775808' }],
      ['STRING', { type: 'COMBO', options: ['a'] }],
      ['COMBO', { type: 'STRING' }],
      ['INT', { type: 'BOOLEAN', labelOn: 'On' }],
      ['INT', { type: 'NUMBER' }],
    ] as const) {
      const rejected = parse(socket, widget)
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('preserves finite FLOAT constraints beyond the safe integer range without relaxing INT', () => {
    const parse = (socket: string, constraints: object) => parseDinksterSchema('PrimitiveFloat', {
      schemaVersion: 1,
      interface: [{ role: 'input', id: 'value', type: concrete(socket), required: true, widget: { type: 'NUMBER', ...constraints } }],
    })
    const constraints = { min: -9223372036854776000, max: 1e20, step: 1e16 }
    const result = parse('FLOAT', constraints)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]?.widget).toMatchObject({ widgetType: 'FLOAT', options: constraints })

    for (const [socket, invalid] of [
      ['INT', constraints],
      ['INT', { max: 1e20 }],
      ['INT', { step: 1e16 }],
      ['INT', { min: 0.5 }],
      ['FLOAT', { min: '-9223372036854775808' }],
      ['FLOAT', { max: '18446744073709551615' }],
      ['FLOAT', { step: '9007199254740992' }],
      ['FLOAT', { min: Number.NEGATIVE_INFINITY }],
      ['FLOAT', { max: Number.POSITIVE_INFINITY }],
      ['FLOAT', { step: Number.NaN }],
      ['FLOAT', { min: 1e20, max: 1e19 }],
      ['FLOAT', { step: 0 }],
      ['FLOAT', { step: -1e16 }],
    ] as const) {
      const rejected = parse(socket, invalid)
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('preserves disabled FLOAT rounding and rejects invalid precisions or INT rounding', () => {
    const parse = (socket: string, round: unknown) => parseDinksterSchema('Precision', {
      schemaVersion: 1,
      interface: [{ role: 'input', id: 'value', type: concrete(socket), required: true, widget: { type: 'NUMBER', round } }],
    })
    for (const round of [false, 0.001]) {
      const result = parse('FLOAT', round)
      expect(result.diagnostics).toEqual([])
      expect(inputsOf(result.schema!)[0]?.widget).toMatchObject({ widgetType: 'FLOAT', options: { round } })
    }
    for (const [socket, round] of [
      ['FLOAT', true], ['FLOAT', null], ['FLOAT', 0], ['FLOAT', -0.001],
      ['FLOAT', 'false'], ['FLOAT', '0.001'], ['FLOAT', Number.NaN],
      ['FLOAT', Number.POSITIVE_INFINITY], ['FLOAT', Number.NEGATIVE_INFINITY],
      ['INT', false], ['INT', 0.001],
    ] as const) {
      const result = parse(socket, round)
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('rejects nested and mixed-domain widget representations', () => {
    const parse = (representations: readonly unknown[]) => parseDinksterSchema('Representations', {
      schemaVersion: 1,
      interface: [{
        role: 'input',
        id: 'value',
        type: concrete('STRING'),
        required: true,
        widget: {
          type: 'REPRESENTATIONS',
          default: 'first',
          userSwitchable: true,
          representations,
        },
      }],
    })

    const nested = parse([{
      id: 'first',
      displayName: 'Nested',
      widget: {
        type: 'REPRESENTATIONS',
        default: 'text',
        userSwitchable: true,
        representations: [
          { id: 'text', displayName: 'Text', widget: { type: 'STRING' } },
        ],
      },
    }])
    expect(nested.schema).toBeUndefined()
    expect(nested.diagnostics[0]?.message).toContain('nested widget representations are forbidden')

    const mixed = parse([
      { id: 'first', displayName: 'Text', widget: { type: 'STRING', multiline: true } },
      { id: 'second', displayName: 'Custom', widget: { type: 'pack.custom' } },
    ])
    expect(mixed.schema).toBeUndefined()
    expect(mixed.diagnostics[0]?.message).toContain('representations must share one canonical value domain')
  })

  it('decodes current structural entries and rejects malformed current schemas', () => {
    const result = parseDinksterSchema('Structural', {
      schemaVersion: 1,
      interface: [
        { role: 'inputFamily', id: 'values', memberPrefix: 'value', minMembers: 1, template: [
          { role: 'input', id: 'value', type: concrete('FLOAT'), required: false },
        ] },
        { role: 'dynamicCombo', id: 'mode', default: 'on', options: [
          { key: 'on', inputs: [{ role: 'input', id: 'strength', type: concrete('FLOAT'), required: false }] },
        ] },
        { role: 'dynamicSlot', id: 'source', required: false, slotType: concrete('IMAGE'), inputs: [] },
        { role: 'outputFamily', id: 'outputs', type: concrete('IMAGE'), minMembers: 0 },
      ],
    })
    expect(result.diagnostics).toEqual([])
    expect(result.schema?.items.map((item) => item.id)).toEqual(['values', 'mode', 'source', 'outputs'])

    const malformed = parseDinksterSchema('Malformed', {
      schemaVersion: 1,
      interface: [{ role: 'input', id: 'value', type: { kind: 'future' }, required: true }],
    })
    expect(malformed.schema).toBeUndefined()
    expect(malformed.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
  })
})
