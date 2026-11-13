import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { importLitegraph, resolveImportedAssetLiterals } from '../src/format/import-litegraph.js'
import { asConnectionId, asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
import { parseDinksterNodes, parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

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

  it.each(['positional', 'keyed'] as const)('omits only empty optional file widgets during %s import', (form) => {
    const descriptor = { digest: `blake3:${'a'.repeat(64)}`, name: 'paint.png', size: 17, mediaType: 'image/png', virtualPath: 'mounts/input/paint.png' }
    for (const [required, filename] of [[false, ''], [true, ''], [false, 'paint.png'], [false, 'missing.png'], [false, ' ']] as const) {
      const parsed = parseDinksterSchema('Paint', { interface: [
        { role: 'input', id: 'mask', required, type: concrete('ASSET'), widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image', allowUpload: true }, sourceFilename: { kind: 'media/image', category: 'input' } },
        { role: 'input', id: 'width', required: true, type: concrete('INT'), widget: { type: 'INT' } },
        { role: 'input', id: 'label', required: false, type: concrete('STRING'), widget: { type: 'STRING', multiline: false } },
      ] })
      expect(parsed.diagnostics).toEqual([])
      const schema = parsed.schema!
      const resolve = () => schema
      const imported = importLitegraph({ nodes: [{ id: 1, type: 'Paint', widgets_values: form === 'positional' ? [filename, 768, ''] : { mask: filename, width: 768, label: '' } }], links: [] }, resolve)
      expect(imported.document).toBeDefined()
      const omitted = !required && filename === ''
      expect(imported.document!.graphs.g0!.nodes.n1!.values).toEqual({ width: 768, label: '', ...(omitted ? {} : { mask: filename }) })
      const resolved = resolveImportedAssetLiterals(imported.document!, resolve, (name) => name === 'paint.png' ? descriptor : undefined)
      expect(resolved.unresolved).toEqual(omitted || filename === 'paint.png' ? [] : [{ graphId: 'g0', nodeId: 'n1', inputId: 'mask', name: filename }])
      expect(resolved.document.graphs.g0!.nodes.n1!.values).toEqual({ width: 768, label: '', ...(omitted ? {} : { mask: filename === 'paint.png' ? descriptor : filename }) })
    }
  })

  it('compiles required initial family positions without requiring an authored tail', () => {
    const source = parseDinksterSchema('Source', { interface: [
      { role: 'output', id: 'out0', type: concrete('IMAGE') },
    ] }).schema!
    const target = parseDinksterSchema('Positional', { outputNode: true, interface: [{
      role: 'inputFamily', id: 'images', minMembers: 2, maxMembers: 4,
      memberPrefix: 'image', optionalAfterMinimum: true,
      template: [{ role: 'input', id: 'value', type: concrete('IMAGE'), required: true }],
    }] }).schema!
    const resolve = (type: string) => type === 'Source' ? source : type === 'Positional' ? target : undefined
    for (const missingFirst of [false, true]) {
      const imported = importLitegraph({ nodes: [
        { id: 1, type: 'Source', outputs: [{ name: 'out0', type: 'IMAGE', links: [1, 2] }] },
        { id: 2, type: 'Positional', inputs: Array.from({ length: 4 }, (_, index) => ({
          name: `images.image${index}`, type: 'IMAGE',
          link: index === (missingFirst ? 2 : 0) ? 1 : index === (missingFirst ? 3 : 1) ? 2 : null,
        })) },
      ], links: [
        [1, 1, 0, 2, missingFirst ? 2 : 0, 'IMAGE'],
        [2, 1, 0, 2, missingFirst ? 3 : 1, 'IMAGE'],
      ] }, resolve)
      expect(imported.document).toBeDefined()
      const result = compile({ document: imported.document!, revision: 0, resolve,
        scope: { kind: 'full' }, connection: asConnectionId('positional'), schemaHash: 'positional' })
      expect(result.ok, JSON.stringify(result.ok ? result.artifact.diagnostics : result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.diagnostics.some((diagnostic) => diagnostic.blocksExecution)).toBe(missingFirst)
        expect(Object.keys(result.artifact.prompt.n2!.inputs)).toEqual(missingFirst
          ? ['images.image2', 'images.image3'] : ['images.image0', 'images.image1'])
      }
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
    const schema = parseDinksterSchema('StringCombo', { outputNode: true, interface: [
      { role: 'input', id: 'depth', type: concrete('COMBO'), widget: { type: 'COMBO', options: ['8', { value: 'enabled', label: 'Enabled' }] } },
    ] }).schema!
    for (const value of [8, 'Enabled']) {
      const imported = importLitegraph({ nodes: [{ id: 1, type: 'StringCombo', widgets_values: [value] }], links: [] }, () => schema)
      expect(imported.document!.graphs.g0!.nodes.n1!.values.depth).toBe(value)
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

  it('isolates a real catalog error from an additive widget warning', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/dinkster-nodes.json', import.meta.url), 'utf8'))
    const valid = { interface: [{ role: 'input', id: 'image', type: concrete('ASSET'), required: true,
      widget: { type: 'ASSET', accept: [], futureHint: true } }] }
    const warningOnly = parseDinksterNodes({ ...fixture, nodes: { Additive: valid } })
    expect([...warningOnly.schemas.keys()]).toEqual(['Additive'])
    expect(warningOnly.diagnostics.map(({ severity, code }) => ({ severity, code }))).toEqual([
      { severity: 'warning', code: 'schema.widget.unknownField' },
    ])
    expect(warningOnly.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    const mixed = parseDinksterNodes({ ...fixture, nodes: { Additive: valid, Invalid: {
      interface: [{ role: 'input', id: 'image', type: concrete('ASSET'), required: true, widget: { type: 'ASSET' } }],
    } } })
    expect([...mixed.schemas.keys()]).toEqual(['Additive'])
    expect(mixed.diagnostics.map(({ severity, code }) => ({ severity, code }))).toEqual([
      { severity: 'warning', code: 'schema.widget.unknownField' },
      { severity: 'error', code: 'schema.parse.threw' },
    ])
    expect(mixed.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(1)
  })

  it('preserves source selection names through import and stamps only the VAE union arm', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/dinkster-nodes.json', import.meta.url), 'utf8'))
    const file = { digest: `blake3:${'a'.repeat(64)}`, name: 'vae.safetensors', size: 4,
      mediaType: 'application/octet-stream', virtualPath: 'mount/vae.safetensors' }
    for (const [kind, value] of [
      ['model/vae', 'pixel_space'], ['model/vae', 'taesd'], ['model/vae', file],
      ['model/diffusers', 'vendor/model'], ['directory/input', 'train/set'], ['directory/dataset', 'dataset'],
    ] as const) {
      const parsed = parseDinksterSchema('Loader', fixture.nodes[`test.selection_${kind.replace('/', '_')}`])
      expect(parsed.diagnostics).toEqual([])
      expect(inputsOf(parsed.schema!)[0]!.widget).toMatchObject({ widgetType: 'ASSET', selection: true, kind })
      const resolve = (type: string) => type === 'Loader' ? parsed.schema : undefined
      const imported = importLitegraph({ version: 0.4, nodes: [{ id: 1, type: 'Loader', widgets_values: [value] }], links: [] }, resolve)
      expect(imported.document).toBeDefined()
      const preserved = resolveImportedAssetLiterals(imported.document!, resolve, () => file)
      expect(preserved.unresolved).toEqual([])
      const compiled = compile({ document: preserved.document, revision: 1, resolve, scope: { kind: 'full' },
        connection: asConnectionId('selection'), schemaHash: 'selection', graphFeatures: ['typedLiteral'] })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('selection compilation failed')
      expect(compiled.artifact.prompt.n1!.inputs['name']).toEqual(kind === 'model/vae'
        ? { $typed: { type: typeof value === 'string' ? 'COMBO' : 'ASSET', value } } : value)
    }
  })

  it('preserves COLOR and STRING color-widget sockets through decoding, import, and compilation', () => {
    for (const socket of ['COLOR', 'STRING']) {
      for (const represented of [false, true]) {
        const widget = represented ? {
          type: 'REPRESENTATIONS', default: 'color', userSwitchable: false,
          representations: [{ id: 'color', widget: { type: 'COLOR' } }],
        } : { type: 'COLOR' }
        const decoded = parseDinksterSchema('ColorToRGBInt', {
          schemaVersion: 1, outputNode: true,
          interface: [{ role: 'input', id: 'color', type: concrete(socket), required: true, default: '#ffffff', widget }],
        })
        expect(decoded.diagnostics).toEqual([])
        expect(inputsOf(decoded.schema!)[0]).toMatchObject({
          type: { kind: 'concrete', name: socket },
          widget: { widgetType: 'COLOR', default: '#ffffff' },
        })
        const resolve = (type: string) => type === 'ColorToRGBInt' ? decoded.schema : undefined
        const imported = importLitegraph({ version: 0.4, nodes: [{ id: 1, type: 'ColorToRGBInt', widgets_values: ['#12345678'] }], links: [] }, resolve)
        expect(imported.diagnostics).toEqual([])
        const compiled = compile({ document: imported.document!, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('color'), schemaHash: 'color' })
        expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('color compilation failed')
        expect(compiled.artifact.prompt.n1!.inputs).toEqual({ color: '#12345678' })
      }
    }
    for (const type of [
      concrete('INT'), concrete('OtherColor'),
      { kind: 'list', element: concrete('COLOR') },
      { kind: 'union', types: ['COLOR', 'STRING'] },
    ]) {
      const rejected = parseDinksterSchema('InvalidColor', {
        schemaVersion: 1,
        interface: [{ role: 'input', id: 'color', type, required: true, widget: { type: 'COLOR' } }],
      })
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
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

  it('keeps hidden dynamic choices and selected literals in compiled prompts', () => {
    for (const hidden of [undefined, false, true]) {
      const parsed = parseDinksterSchema('HiddenChoice', {
        schemaVersion: 1, outputNode: true,
        interface: [{ role: 'dynamicCombo', id: 'codec', required: false, hidden, options: [
          { key: 'h264', inputs: [{ role: 'input', id: 'crf', type: concrete('INT'), required: false }] },
          { key: 'vp9', inputs: [] },
        ] }],
      })
      expect(parsed.diagnostics).toEqual([])
      expect(inputsOf(parsed.schema!)[0]?.hidden).toBe(hidden === true ? true : undefined)
      const result = compile({
        document: { format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('hidden-choice'), root: asGraphDefId('g0'), graphs: {
          g0: { id: asGraphDefId('g0'), name: 'root', nodes: {
            n0: { id: asNodeId('n0'), type: 'HiddenChoice', values: { 'codec.crf': 23 }, dynamic: { codec: { selected: 'h264' } } },
          }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
        }, view: { graphs: {} } },
        revision: 0, resolve: () => parsed.schema!, scope: { kind: 'full' },
        connection: asConnectionId('hidden-choice'), schemaHash: 'hidden-choice',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt.n0).toMatchObject({ inputs: { 'codec.crf': 23 }, slotVariants: { codec: 'h264' } })
      }
    }
    const invalid = parseDinksterSchema('InvalidHidden', {
      interface: [{ role: 'dynamicCombo', id: 'codec', hidden: 'true', options: [{ key: 'auto', inputs: [] }] }],
    })
    expect(invalid.schema).toBeUndefined()
    expect(invalid.diagnostics[0]?.message).toContain('hidden')
  })
})
