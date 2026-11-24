import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { importLitegraph, resolveImportedAssetLiterals } from '../src/format/import-litegraph.js'
import { asConnectionId, asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
import { DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterNodes, parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'
import { elabInputsOf, elaborateInterface } from '../src/schema/elaborate.js'

const concrete = (name: string) => ({ kind: 'concrete', types: [name] })
const SELECTION_DEFAULTS: Record<string, string> = {
  'model/vae': 'pixel_space', 'model/diffusers': 'vendor/model', 'directory/input': 'train/set', 'directory/dataset': 'dataset',
}

describe('Dinkster schema wire', () => {

  it('decodes a Switch selector as its pick and group of branches, and refuses the two-branch form', () => {
    // The engine's schema_to_wire output for a Switch.
    const body = [
      { kind: 'input', id: 'pick', type: { kind: 'union', types: ['INT', 'BOOLEAN'] }, required: false },
      { kind: 'group', id: 'branch', value: { kind: 'input', id: 'branch', type: { kind: 'concrete', types: ['IMAGE'] }, required: false, lazy: true },
        keys: { numbered: { prefix: 'branch', start: 1, pad: 0 } }, grows: 'button', minMembers: 1 },
      { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['IMAGE'] } },
    ]
    const { schema, diagnostics } = parseDinksterSchema('Switch', { body, selector: { input: 'pick', group: 'branch' } } as never)
    expect(diagnostics).toEqual([])
    expect(schema!.selector).toEqual({ input: 'pick', group: 'branch' })
    const old = parseDinksterSchema('Switch', { body, selector: { input: 'pick', branches: { false: 'a', true: 'b' } } } as never)
    expect(old.schema).toBeUndefined()
  })

  it('decodes a Switch that picks by name only with a text pick and a hidden names list', () => {
    const textPick = { kind: 'input', id: 'pick', type: { kind: 'union', types: ['INT', 'BOOLEAN', 'STRING', 'COMBO'] }, required: false }
    const names = { kind: 'input', id: 'names', type: { kind: 'list', element: { kind: 'concrete', types: ['STRING'] } }, required: false, hidden: true }
    const rest = [
      { kind: 'group', id: 'branch', value: { kind: 'input', id: 'branch', type: concrete('IMAGE'), required: false, lazy: true },
        keys: { numbered: { prefix: 'branch', start: 1, pad: 0 } }, grows: 'button', minMembers: 1 },
      { kind: 'output', id: 'out', type: concrete('IMAGE') },
    ]
    const decode = (body: unknown[], selector: Record<string, string>) => parseDinksterSchema('Switch', { body, selector } as never)
    const named = decode([textPick, names, ...rest], { input: 'pick', group: 'branch', names: 'names' })
    expect(named.diagnostics).toEqual([])
    expect(named.schema!.selector).toEqual({ input: 'pick', group: 'branch', names: 'names' })
    // Text needs names; names need text; the names input is hidden and not required.
    expect(decode([textPick, names, ...rest], { input: 'pick', group: 'branch' }).schema).toBeUndefined()
    expect(decode([{ ...textPick, type: { kind: 'union', types: ['INT', 'BOOLEAN'] } }, names, ...rest], { input: 'pick', group: 'branch', names: 'names' }).schema).toBeUndefined()
    expect(decode([textPick, { ...names, hidden: false }, ...rest], { input: 'pick', group: 'branch', names: 'names' }).schema).toBeUndefined()
    expect(decode([textPick, { ...names, required: true }, ...rest], { input: 'pick', group: 'branch', names: 'names' }).schema).toBeUndefined()
  })

  it('keeps formula labels and visible on inputs and outputs as declared', () => {
    const { schema, diagnostics } = parseDinksterSchema('Labels', { body: [
      { kind: 'input', id: 'count', type: concrete('INT'), label: { formula: 'mode' }, visible: { formula: 'count > 1' } },
      { kind: 'input', id: 'plain', type: concrete('INT'), label: 'Plain', visible: false },
      { kind: 'output', id: 'out', type: concrete('INT'), label: { formula: 'mode' }, visible: false },
    ] } as never)
    expect(diagnostics).toEqual([])
    const [count, plain, out] = schema!.body as unknown as Record<string, unknown>[]
    expect(count).toMatchObject({ labelFormula: { formula: 'mode' }, visible: { formula: 'count > 1' } })
    expect(count!['displayName']).toBeUndefined()
    expect(plain).toMatchObject({ displayName: 'Plain', visible: false })
    expect(out).toMatchObject({ labelFormula: { formula: 'mode' }, visible: false })
  })

  it.each([
    ['COMBO', 'COMBO', true],
    ['COMBO', 'STRING', true],
    ['INT', 'INT', true],
    ['COMBO', 'INT', false],
    ['STRING', 'COMBO', false],
    ['INT', 'FLOAT', false],
  ] as const)('accepts a known value from a %s input for a %s output: %s', (inputType, outputType, accepted) => {
    const { schema, diagnostics } = parseDinksterSchema('Known', { body: [
      { kind: 'input', id: 'value', type: concrete(inputType),
        ...(inputType === 'COMBO' ? { widget: { type: 'COMBO', options: ['a', 'b'] } } : {}) },
      { kind: 'output', id: 'out', type: concrete(outputType), knownValue: { input: 'value' } },
    ] } as never)
    if (accepted) {
      expect(diagnostics).toEqual([])
      expect(schema!.body[1]).toMatchObject({ knownValue: { input: 'value' } })
    } else {
      expect(schema).toBeUndefined()
      expect(diagnostics.map((d) => d.message).join()).toContain('knownValue must name an input')
    }
  })

  it('accepts a known value from an input typed by the output\'s type variable, and no other variable', () => {
    const variable = (templateId: string) => ({ kind: 'variable', templateId })
    const parse = (outputVariable: string) => parseDinksterSchema('KnownVariable', { body: [
      { kind: 'input', id: 'value', type: variable('value') },
      { kind: 'output', id: 'out', type: variable(outputVariable), knownValue: { input: 'value' } },
    ] } as never)
    const same = parse('value')
    expect(same.diagnostics).toEqual([])
    expect(same.schema!.body[1]).toMatchObject({ knownValue: { input: 'value' } })
    const other = parse('other')
    expect(other.schema).toBeUndefined()
    expect(other.diagnostics.map((d) => d.message).join()).toContain('knownValue must name an input')
  })

  it('keeps an editor row and the rows a widget writes and reads, apart from its params', () => {
    const { schema, diagnostics } = parseDinksterSchema('Viewport', { body: [
      { kind: 'input', id: 'model_file', type: concrete('STRING'),
        widget: { type: 'load3d.viewport', height: 320, writes: { camera: 'camera' }, reads: { model: 'model_file' } } },
      { kind: 'state', id: 'camera', type: concrete('STRING'), partOfRun: true },
      { kind: 'editor', id: 'view', widget: { type: 'COMPOSITOR', reads: { layers: 'model_file' } }, visible: false },
    ] } as never)
    expect(diagnostics).toEqual([])
    const [input, , editor] = schema!.body as unknown as Record<string, Record<string, unknown>>[]
    expect(input!['widget']).toMatchObject({
      widgetType: 'load3d.viewport', options: { height: 320 },
      writes: { camera: 'camera' }, reads: { model: 'model_file' },
    })
    expect(input!['widget']!['options']).not.toHaveProperty('writes')
    expect(editor).toEqual({ kind: 'editor', id: 'view', visible: false,
      widget: { widgetType: 'COMPOSITOR', options: {}, reads: { layers: 'model_file' } } })
    const unnamed = parseDinksterSchema('Unnamed', { body: [
      { kind: 'editor', id: 'view', widget: { type: 'load3d.viewport' } },
    ] } as never)
    expect(unnamed.schema).toBeUndefined()
    expect(unnamed.diagnostics.map((d) => d.message).join()).toContain('must name at least one row')
  })

  it('places a shared row by Use inside a section under an option', () => {
    const { schema, diagnostics } = parseDinksterSchema('SaveAdvanced', { body: [{
      kind: 'choice', id: 'format', default: 'png', shared: [{ kind: 'input', id: 'quality', type: concrete('INT'), default: 90 }],
      options: [
        { key: 'png', rows: [] },
        { key: 'webp', rows: [{ kind: 'section', id: 'advanced', rows: [{ kind: 'use', id: 'quality', default: 75 }] }] },
      ],
    }] } as never)
    expect(diagnostics).toEqual([])
    const elaborated = elaborateInterface(schema!, { values: {}, dynamic: { format: { selected: 'webp' } } })
    expect(elabInputsOf(elaborated).filter((input) => input.origin.kind !== 'selector')
      .map((input) => [input.spec.id, input.spec.widget?.default, input.spec.section])).toEqual([['format.quality', 75, 'format.advanced']])
  })

  it('decodes a Use field override against the type of the shared row it places', () => {
    const { schema, diagnostics } = parseDinksterSchema('SaveVideo', { body: [{
      kind: 'choice', id: 'codec', default: 'h264',
      shared: [
        { kind: 'input', id: 'crf', type: concrete('INT'), default: 23, widget: { type: 'NUMBER', min: 0, max: 51, step: 1 } },
        { kind: 'input', id: 'preset', type: concrete('COMBO'), default: 'medium', widget: { type: 'COMBO', options: ['fast', 'medium'] } },
      ],
      options: [
        { key: 'h264', rows: [{ kind: 'use', id: 'crf' }, { kind: 'use', id: 'preset' }] },
        { key: 'av1', rows: [
          { kind: 'use', id: 'crf', default: 31, widget: { type: 'NUMBER', min: 0, max: 63, step: 1 } },
          { kind: 'use', id: 'preset', default: 'p4', widget: { type: 'COMBO', options: ['p4', 'p7'] } },
        ] },
      ],
    }] } as never)
    expect(diagnostics).toEqual([])
    const fields = (selected: string) => elabInputsOf(elaborateInterface(schema!, { values: {}, dynamic: { codec: { selected } } }))
      .filter((input) => input.origin.kind !== 'selector')
      .map((input) => [input.spec.id, input.spec.widget?.default, input.spec.widget?.options['max'] ?? input.spec.widget?.options['options']])
    expect(fields('av1')).toEqual([['codec.crf', 31, 63], ['codec.preset', 'p4', ['p4', 'p7']]])
    expect(fields('h264')).toEqual([['codec.crf', 23, 51], ['codec.preset', 'medium', ['fast', 'medium']]])
  })

  it('preserves native asset-selection schemas and imported source names', () => {
    for (const kind of ['model/vae', 'model/diffusers', 'directory/input', 'directory/dataset']) {
      const types = [concrete('COMBO'), ...(kind === 'model/vae' ? [{ kind: 'union', types: ['COMBO', 'ASSET'] }] : [])]
      const source = kind === 'model/vae' ? 'pixel_space' : 'nested/source'
      for (const type of types) {
        const result = parseDinksterSchema('SourceSelection', { body: [
          { kind: 'input', id: 'source', type, widget: { type: 'ASSET', accept: [], kind, selection: true } },
          { kind: 'input', id: 'file', type: concrete('ASSET'), widget: { type: 'ASSET', accept: [] } },
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
      const parsed = parseDinksterSchema('Paint', { body: [
        { kind: 'input', id: 'mask', required, type: concrete('ASSET'), widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image', allowUpload: true }, sourceFilename: { kind: 'media/image', category: 'input' } },
        { kind: 'input', id: 'width', required: true, type: concrete('INT'), widget: { type: 'INT' } },
        { kind: 'input', id: 'label', required: false, type: concrete('STRING'), widget: { type: 'STRING', multiline: false } },
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
    const source = parseDinksterSchema('Source', { body: [
      { kind: 'output', id: 'out0', type: concrete('IMAGE') },
    ] }).schema!
    const target = parseDinksterSchema('Positional', { outputNode: true, body: [{
      kind: 'group', id: 'images', minMembers: 2, maxMembers: 4,
      keys: { numbered: { prefix: 'image', start: 0, pad: 0 } }, optionalAfterMinimum: true,
      value: { kind: 'input', id: 'image', type: concrete('IMAGE'), required: true },
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
        expect(imported.document!.graphs.g0!.nodes.n2!.dynamic?.['images']?.members).toEqual(missingFirst
          ? ['image2', 'image3'] : ['image0', 'image1'])
        expect(result.artifact.diagnostics.some((diagnostic) => diagnostic.blocksExecution)).toBe(false)
        expect(Object.keys(result.artifact.prompt.n2!.inputs)).toEqual(missingFirst
          ? ['images.image2', 'images.image3'] : ['images.image0', 'images.image1'])
      }
    }
  })

  it('keeps hidden DynamicCombo selectors presentation-only through import and compile', () => {
    for (const hidden of [undefined, false, true]) {
      const result = parseDinksterSchema('HiddenSelector', {
        outputNode: true,
        body: [{ kind: 'choice', id: 'codec', hidden, options: [
          { key: 'auto', rows: [{ kind: 'use', id: 'quality', default: 7 }] },
          { key: 'custom', rows: [{ kind: 'use', id: 'quality', default: 13 }] },
        ], shared: [{ kind: 'input', id: 'quality', type: concrete('INT') }] }],
      })
      expect(result.diagnostics).toEqual([])
      expect(result.schema!.body[0]).toMatchObject({ kind: 'choice', id: 'codec' })
      expect((result.schema!.body[0] as { hidden?: true }).hidden).toBe(hidden === true ? true : undefined)
      const resolve = (type: string) => type === 'HiddenSelector' ? result.schema : undefined
      const imported = importLitegraph({ nodes: [{ id: 1, type: 'HiddenSelector', widgets_values: ['custom', 29] }], links: [] }, resolve)
      const node = imported.document!.graphs.g0!.nodes.n1!
      expect(node.dynamic?.codec?.selected).toBe('custom')
      expect(node.values['codec.quality']).toBe(29)
      const before = JSON.stringify(imported.document)
      const compiled = compile({ document: imported.document!, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('hidden-selector'), schemaHash: 'hidden-selector' })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('hidden selector compilation failed')
      expect(compiled.artifact.prompt.n1!.inputs).toEqual({ 'codec.quality': 29 })
      expect(compiled.artifact.prompt.n1!.slotVariants).toEqual({ codec: 'custom' })
      expect(JSON.stringify(imported.document)).toBe(before)
    }
    for (const hidden of [null, 0, 'true', {}]) {
      const result = parseDinksterSchema('InvalidHiddenSelector', { body: [
        { kind: 'choice', id: 'codec', hidden, options: [{ key: 'auto', rows: [] }] },
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
        body: [{ kind: 'input', id: 'depth', type: concrete('COMBO'), default: value,
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
    const schema = parseDinksterSchema('StringCombo', { outputNode: true, body: [
      { kind: 'input', id: 'depth', type: concrete('COMBO'), widget: { type: 'COMBO', options: ['8', { value: 'enabled', label: 'Enabled' }] } },
    ] }).schema!
    for (const value of [8, 'Enabled']) {
      const imported = importLitegraph({ nodes: [{ id: 1, type: 'StringCombo', widgets_values: [value] }], links: [] }, () => schema)
      expect(imported.document!.graphs.g0!.nodes.n1!.values.depth).toBe(value)
    }
  })

  it('submits an editable choice\'s authored options to the input its optionsInput names', () => {
    const optionsInput = { kind: 'input', id: 'options', type: { kind: 'list', element: concrete('STRING') }, required: false, hidden: true }
    const result = parseDinksterSchema('AuthoredCombo', { outputNode: true, body: [
      { kind: 'input', id: 'choice', type: concrete('COMBO'), widget: { type: 'COMBO', editableOptions: true, optionsInput: 'options' } },
      optionsInput,
    ] } as never)
    expect(result.diagnostics).toEqual([])
    const resolve = (type: string) => type === 'AuthoredCombo' ? result.schema : undefined
    const imported = importLitegraph({ nodes: [{ id: 1, type: 'AuthoredCombo', widgets_values: ['Detailed'] }], links: [] }, resolve)
    const graph = imported.document!.graphs.g0!
    const node = graph.nodes.n1!
    const compileWith = (dynamic: object | undefined, values: object = node.values) => {
      const document = { ...imported.document!, graphs: { ...imported.document!.graphs, g0: { ...graph,
        nodes: { n1: { ...node, values, ...(dynamic === undefined ? {} : { dynamic }) } } } } }
      const compiled = compile({ document: document as never, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('authored'), schemaHash: 'authored' })
      expect(compiled.ok, compiled.ok ? undefined : JSON.stringify(compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('authored options compilation failed')
      return compiled.artifact.prompt.n1!.inputs
    }
    expect(compileWith({ choice: { options: ['Quick', 'Detailed', 3] } })).toEqual({ choice: 'Detailed', options: ['Quick', 'Detailed', '3'] })
    expect(compileWith({ choice: { options: ['Detailed', true, false] } }).options).toEqual(['Detailed', 'true', 'false'])
    expect(compileWith(undefined)).toEqual({ choice: 'Detailed', options: [] })
    // A stored value on the options input never stands in for the authored options.
    expect(compileWith({ choice: { options: ['Only'] } }, { ...node.values, options: ['Stale'] }).options).toEqual(['Only'])

    // Each subgraph node's own authored options reach its inner choice's options input.
    const inner = { ...node, id: asNodeId('inner'), dynamic: { choice: { options: ['Inner'] } } }
    const instance = (id: string, options: readonly string[]) =>
      ({ id: asNodeId(id), type: '#soften', values: { choice: 'Detailed' }, dynamic: { choice: { options } } })
    const nested = { ...imported.document!, graphs: {
      g0: { ...graph, nodes: { a: instance('a', ['Detailed', 'Quick']), b: instance('b', ['Fine', 'Detailed']) } },
      soften: { ...graph, id: asGraphDefId('soften'), name: 'soften', nodes: { inner }, boundary: {
        inputs: [{ id: 'choice', binds: { kind: 'port', node: 'inner', port: 'choice' }, promoted: true }], outputs: [],
      } },
    } }
    const compiledNested = compile({ document: nested as never, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('authored'), schemaHash: 'authored' })
    expect(compiledNested.ok, compiledNested.ok ? undefined : JSON.stringify(compiledNested.diagnostics)).toBe(true)
    if (!compiledNested.ok) throw new Error('nested authored options compilation failed')
    expect(compiledNested.artifact.prompt['a.inner']!.inputs.options).toEqual(['Detailed', 'Quick'])
    expect(compiledNested.artifact.prompt['b.inner']!.inputs.options).toEqual(['Fine', 'Detailed'])

    for (const [widget, target, message] of [
      [{ type: 'COMBO', options: ['a'], optionsInput: 'options' }, optionsInput, 'optionsInput requires editableOptions'],
      [{ type: 'COMBO', editableOptions: true, optionsInput: 'options' }, { ...optionsInput, hidden: undefined }, "optionsInput 'options' must name"],
      [{ type: 'COMBO', editableOptions: true, optionsInput: 'options' }, { ...optionsInput, required: true }, "optionsInput 'options' must name"],
      [{ type: 'COMBO', editableOptions: true, optionsInput: 'options' }, { ...optionsInput, type: concrete('STRING') }, "optionsInput 'options' must name"],
      [{ type: 'COMBO', editableOptions: true, optionsInput: 'options' }, { ...optionsInput, widget: { type: 'STRING', multiline: true } }, "optionsInput 'options' must name"],
      [{ type: 'COMBO', editableOptions: true, optionsInput: 'missing' }, optionsInput, "optionsInput 'missing' must name"],
      [{ type: 'COMBO', editableOptions: true, optionsInput: 'options' }, {
        kind: 'group', id: 'extra', keys: { numbered: { prefix: '', start: 0, pad: 0 } }, value: optionsInput,
      }, "optionsInput 'options' must name"],
    ] as const) {
      const refused = parseDinksterSchema('AuthoredCombo', { body: [
        { kind: 'input', id: 'choice', type: concrete('COMBO'), widget }, target,
      ] } as never)
      expect(refused.schema).toBeUndefined()
      expect(refused.diagnostics.map((d) => d.message).join()).toContain(message)
    }
  })

  it('keeps socketless widget values positional and compilable in direct and nested inputs', () => {
    const fields = [
      { kind: 'input', id: 'color', type: concrete('STRING'), default: '#123456', pin: false, widget: { type: 'COLOR' } },
      { kind: 'input', id: 'amount', type: concrete('INT'), default: 7 },
    ]
    for (const nested of [false, true]) {
      const result = parseDinksterSchema('SocketlessFixture', {
        outputNode: true,
        body: nested ? [{ kind: 'choice', id: 'style', options: [{ key: 'solid', rows: fields }] }] : fields,
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
        expect(compiled.artifact.prompt.n1!.inputs).toEqual(nested ? { 'style.color': color, 'style.amount': amount } : { color, amount })
        expect(compiled.artifact.prompt.n1!.slotVariants).toEqual(nested ? { style: 'solid' } : undefined)
      }
    }
  })

  it('isolates a real catalog error from an additive widget warning', () => {
    const header = { schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION }
    const valid = { body: [{ kind: 'input', id: 'image', type: concrete('ASSET'), required: true,
      widget: { type: 'ASSET', accept: [], futureHint: true } }] }
    const warningOnly = parseDinksterNodes({ ...header, nodes: { Additive: valid } })
    expect([...warningOnly.schemas.keys()]).toEqual(['Additive'])
    expect(warningOnly.diagnostics.map(({ severity, code }) => ({ severity, code }))).toEqual([
      { severity: 'warning', code: 'schema.widget.unknownField' },
    ])
    expect(warningOnly.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    const mixed = parseDinksterNodes({ ...header, nodes: { Additive: valid, Invalid: {
      body: [{ kind: 'input', id: 'image', type: concrete('ASSET'), required: true, widget: { type: 'ASSET' } }],
    } } })
    expect([...mixed.schemas.keys()]).toEqual(['Additive'])
    expect(mixed.diagnostics.map(({ severity, code }) => ({ severity, code }))).toEqual([
      { severity: 'warning', code: 'schema.widget.unknownField' },
      { severity: 'error', code: 'schema.parse.threw' },
    ])
    expect(mixed.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(1)
  })

  it.each([
    ['COMBO', 'COMBO', { options: [{ value: 'a', futureHint: true }] }, { options: [{ value: 3, label: false }] }],
    ['COMBO', 'COMBO', { remote: { route: '/api/choices/models', futureHint: true } }, { remote: { route: false } }],
    ['MULTI_COMBO', 'COMBO', { options: [{ value: 'a', futureHint: true }] }, { options: [{ value: false }] }],
    ['MULTI_COMBO', 'COMBO', { remote: { route: '/api/choices/models', futureHint: true } }, { remote: { route: false } }],
    ['STRING', 'STRING', { completions: { items: [{ value: 'name' }], futureHint: true } }, { completions: { items: false } }],
    ['STRING', 'STRING', { completions: { items: [{ value: 'name', futureHint: true }] } }, { completions: { items: [{ value: false }] } }],
  ])('keeps %s widgets with additive nested fields but refuses malformed known fields', (kind, type, additive, malformed) => {
    const parse = (fields: object) => parseDinksterSchema('Additive', { body: [{
      kind: 'input', id: 'choice', type: kind === 'MULTI_COMBO'
        ? { kind: 'list', element: concrete(type) } : concrete(type),
      required: true, widget: { type: kind, ...fields },
    }] })
    const accepted = parse(additive)
    expect(accepted.schema).toBeDefined()
    expect(accepted.diagnostics).toHaveLength(1)
    expect(accepted.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'schema.widget.unknownField' })
    expect(accepted.diagnostics[0]!.message).toContain('Additive.choice')
    expect(accepted.diagnostics[0]!.message).toContain('futureHint')
    expect(JSON.stringify(accepted.schema)).not.toContain('futureHint')
    const rejected = parse(malformed)
    expect(rejected.schema).toBeUndefined()
    expect(rejected.diagnostics.some((item) => item.severity === 'error')).toBe(true)
  })

  it('preserves source selection names through import and stamps only the VAE union arm', () => {
    const file = { digest: `blake3:${'a'.repeat(64)}`, name: 'vae.safetensors', size: 4,
      mediaType: 'application/octet-stream', virtualPath: 'mount/vae.safetensors' }
    for (const [kind, value] of [
      ['model/vae', 'pixel_space'], ['model/vae', 'taesd'], ['model/vae', file],
      ['model/diffusers', 'vendor/model'], ['directory/input', 'train/set'], ['directory/dataset', 'dataset'],
    ] as const) {
      const parsed = parseDinksterSchema('Loader', { outputNode: true, body: [{
        kind: 'input', id: 'name', required: true, default: SELECTION_DEFAULTS[kind],
        type: kind === 'model/vae' ? { kind: 'union', types: ['COMBO', 'ASSET'] } : concrete('COMBO'),
        widget: { type: 'ASSET', accept: [], kind, selection: true },
      }] })
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
          schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, outputNode: true,
          body: [{ kind: 'input', id: 'color', type: concrete(socket), required: true, default: '#ffffff', widget }],
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
        schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
        body: [{ kind: 'input', id: 'color', type, required: true, widget: { type: 'COLOR' } }],
      })
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('carries a number field\'s step offset, special values and reason to the schema model', () => {
    const decoded = parseDinksterSchema('Frames', {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      body: [
        {
          kind: 'input', id: 'frames', type: concrete('INT'), required: true, default: 0,
          widget: { type: 'NUMBER', min: 1, step: 4, offset: 1, special: [[-1, 'all'], [0, 'off'], ['18446744073709551615', 'top']], reason: 'Up to 8' },
        },
        { kind: 'input', id: 'plain', type: concrete('INT'), required: true, default: 0, widget: { type: 'NUMBER', min: 0 } },
      ],
    })
    expect(decoded.diagnostics).toEqual([])
    const [frames, plain] = inputsOf(decoded.schema!)
    expect(frames!.widget!.options).toEqual({
      min: 1, step: 4, offset: 1, reason: 'Up to 8',
      special: [{ value: -1, label: 'all' }, { value: 0, label: 'off' }, { value: '18446744073709551615', label: 'top' }],
    })
    expect(plain!.widget!.options).toEqual({ min: 0 })
    for (const widget of [
      { type: 'NUMBER', special: { 0: 'off' } },
      { type: 'NUMBER', special: [[0, '']] },
      { type: 'NUMBER', reason: 7 },
    ]) {
      const rejected = parseDinksterSchema('BadFrames', {
        schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
        body: [{ kind: 'input', id: 'frames', type: concrete('INT'), required: true, widget }],
      })
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('carries a color field that uses opacity to the schema model, and only that field', () => {
    const decoded = parseDinksterSchema('Colors', {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      body: [
        { kind: 'input', id: 'fill', type: concrete('STRING'), required: true, default: '#33669980', widget: { type: 'COLOR', alpha: true } },
        { kind: 'input', id: 'line', type: concrete('COLOR'), required: true, default: '#336699', widget: { type: 'COLOR' } },
      ],
    })
    expect(decoded.diagnostics).toEqual([])
    const [fill, line] = inputsOf(decoded.schema!)
    expect(fill!.widget).toMatchObject({ widgetType: 'COLOR', options: { alpha: true } })
    expect(line!.widget!.options).toEqual({})
    const rejected = parseDinksterSchema('BadColor', {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      body: [{ kind: 'input', id: 'fill', type: concrete('STRING'), required: true, widget: { type: 'COLOR', alpha: 'yes' } }],
    })
    expect(rejected.schema).toBeUndefined()
    expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('alpha must be a boolean') })])
  })

  it('carries the input a curve names as its histogram to its widget options', () => {
    const curve = (id: string, widget: Record<string, unknown>) =>
      ({ kind: 'input', id, type: concrete('CURVE'), required: true, widget: { type: 'CURVE', ...widget } })
    const decoded = parseDinksterSchema('Curves', {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      body: [curve('tied', { histogram: 'bins' }), curve('plain', {}), { kind: 'input', id: 'bins', type: concrete('HISTOGRAM'), required: false }],
    })
    expect(decoded.diagnostics).toEqual([])
    const [tied, plain] = inputsOf(decoded.schema!)
    expect(tied!.widget!.options).toEqual({ histogram: 'bins' })
    expect(plain!.widget!.options).toEqual({})
    for (const bad of ['', 3]) {
      const rejected = parseDinksterSchema('BadCurve', { schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, body: [curve('c', { histogram: bad })] })
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('histogram must name an input') })])
    }
  })

  it('renders numeric-only unions as FLOAT without changing imported numeric values or socket types', () => {
    const widget = { type: 'NUMBER', min: 1, max: 1000, step: 0.01, round: false, display: 'number' }
    for (const types of [['FLOAT', 'INT'], ['INT', 'FLOAT']]) {
      const decoded = parseDinksterSchema('NumericUnion', {
        schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
        outputNode: true,
        body: [{ kind: 'input', id: 'frame_rate', type: { kind: 'union', types }, required: true, default: 25, widget }],
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
        schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
        body: [{ kind: 'input', id: 'frame_rate', type: { kind: 'union', types }, required: true, widget: {
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
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      outputNode: true,
      body: [
        { kind: 'input', id: 'texts', type: { kind: 'list', element: concrete('STRING') }, required: true, widget: { type: 'STRING', multiline: false } },
        { kind: 'input', id: 'tail', type: concrete('INT'), required: true, widget: { type: 'NUMBER', min: 0 } },
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
        schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, outputNode: true,
        body: [{ kind: 'choice', id: 'codec', required: false, hidden, options: [
          { key: 'h264', rows: [{ kind: 'input', id: 'crf', type: concrete('INT'), required: false }] },
          { key: 'vp9', rows: [] },
        ] }],
      })
      expect(parsed.diagnostics).toEqual([])
      expect((parsed.schema!.body[0] as { hidden?: true }).hidden).toBe(hidden === true ? true : undefined)
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
      body: [{ kind: 'choice', id: 'codec', hidden: 'true', options: [{ key: 'auto', rows: [] }] }],
    })
    expect(invalid.schema).toBeUndefined()
    expect(invalid.diagnostics[0]?.message).toContain('hidden')
  })
})
