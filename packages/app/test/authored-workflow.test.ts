import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asNodeId } from '@dinkster/core'
import type { CommandOutcome, DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { historicalRegistry } from './historical-schemas.js'
import { AppState } from '../src/app-state.js'
import seedBasic from '../../core/fixtures/workflows/seed-basic.json'
import seedSubgraph from '../../core/fixtures/workflows/seed-subgraph.json'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

let app: AppState

beforeEach(() => {
  app = new AppState()
  const blank = app.activeTab()!
  app.openDocument(seedBasic, 'Basic')
  app.openDocument(seedSubgraph, 'Subgraph')
  app.closeTab(blank.id)
})

const nativePayload: DinksterNodesPayload = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'authored-workflow-test', schemaWire: 1 },
  packs: {},
  nodes: {
    EmptyImage: {
      schemaVersion: 1, nodeType: 'EmptyImage', displayName: 'Empty Image', category: 'image',
      interface: [
        ...['width', 'height', 'batch_size', 'color'].map((id, index) => ({
          role: 'input' as const, id, type: { kind: 'concrete' as const, types: ['INT'] },
          required: false, default: [512, 512, 1, 0][index]!,
        })),
        { role: 'output', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } },
      ],
    },
    PreviewImage: {
      schemaVersion: 1, nodeType: 'PreviewImage', displayName: 'Preview Image', category: 'image',
      outputNode: true,
      interface: [{ role: 'input', id: 'images', type: { kind: 'concrete', types: ['IMAGE'] }, required: true }],
    },
  },
}

const loadNativeSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, nativePayload))
}

const docJson = (type: string, count = 1): unknown => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'authored-workflow', root: 'g0',
  graphs: { g0: {
    id: 'g0', name: 'root',
    nodes: Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `n${index}`, { id: `n${index}`, type, values: { width: 61, height: 29 } },
    ])),
    links: {}, nets: {}, reroutes: {}, nextOrdinal: count,
  } },
  view: { graphs: { g0: { nodes: {} } } },
})

const imageWorkflow = {
  version: 0.4,
  nodes: [
    { id: 1, type: 'EmptyImage', pos: [0, 0], outputs: [{ name: 'IMAGE', links: [1] }], widgets_values: [61, 29, 2, 7] },
    { id: 2, type: 'PreviewImage', pos: [300, 50], inputs: [{ name: 'images', link: 1 }] },
  ],
  links: [[1, 1, 0, 2, 0, 'IMAGE']],
}

describe('authored workflows on a native backend', () => {
  it('resolves promoted instance assets without replacing sibling overrides or definition defaults', async () => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, {
      schemaVersion: 1,
      nodes: { ModelFile: { outputNode: true, interface: [
        { role: 'input', id: 'file', type: { kind: 'concrete', types: ['ASSET'] }, required: true,
          widget: { type: 'ASSET', accept: [] } },
        { role: 'output', id: 'MODEL', type: { kind: 'concrete', types: ['MODEL'] } },
      ] } },
    }))
    const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'turbo.safetensors', held: true,
      confidence: 'other' as const, virtualPath: 'models/turbo.safetensors', size: 17,
      mediaType: 'application/octet-stream' }
    vi.spyOn(backend.connection, 'guessAssets').mockImplementation(async (names) => names.map((query) => ({
      query, candidates: query === 'turbo.safetensors' ? [asset] : [],
    })))
    const instance = (id: number, name: string) => ({ id, type: 'model-body',
      inputs: [{ name: 'file', type: 'ASSET', widget: { name: 'file' } }],
      outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: [name] })
    expect(app.openDocument({ version: 0.4,
      nodes: [instance(1, 'turbo.safetensors'), instance(2, 'sibling.safetensors')], links: [],
      definitions: { subgraphs: [{ id: 'model-body', name: 'Model', version: 1,
        nodes: [{ id: 3, type: 'ModelFile', inputs: [{ name: 'file', widget: { name: 'file' }, link: 1 }],
          outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: ['base.safetensors'] }],
        inputs: [{ id: 'file-boundary', name: 'file', type: 'ASSET', linkIds: [1] }],
        outputs: [{ id: 'model-boundary', name: 'MODEL', type: 'MODEL', linkIds: [2] }],
        links: [
          { id: 1, origin_id: -10, origin_slot: 0, target_id: 3, target_slot: 0, type: 'ASSET' },
          { id: 2, origin_id: 3, origin_slot: 0, target_id: -20, target_slot: 0, type: 'MODEL' },
        ],
      }] },
    }, 'Promoted models')).toEqual([])
    const tab = app.activeTab()!
    const before = structuredClone(tab.store.doc)
    await vi.waitFor(() => expect(app.importAssetResolution.get()?.matches.map((match) => match.query).sort()).toEqual([
      'base.safetensors', 'sibling.safetensors', 'turbo.safetensors',
    ]))
    expect(tab.store.doc).toEqual(before)
    expect(tab.store.canUndo).toBe(false)
    await app.importAssetResolution.get()!.accept(new Map([['turbo.safetensors', asset]]))
    const accepted = { digest: asset.digest, name: asset.name, virtualPath: asset.virtualPath,
      size: asset.size, mediaType: asset.mediaType }
    expect(tab.store.doc.graphs.g0!.nodes.n1!.values['file-boundary']).toEqual(accepted)
    expect(tab.store.doc.graphs.g0!.nodes.n2!.values['file-boundary']).toBe('sibling.safetensors')
    expect(tab.store.doc.graphs['model-body']!.nodes.n3!.values.file).toBe('base.safetensors')
    const compiled = app.compileTab(tab, { kind: 'partial', targets: [{ instancePath: [asNodeId('n1')], node: asNodeId('n3') }] })
    expect(compiled?.ok, JSON.stringify(compiled)).toBe(true)
    if (compiled?.ok) expect(Object.values(compiled.artifact.prompt).map((node) => node.inputs.file)).toEqual([accepted])
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc).toEqual(before)
    expect(tab.store.canUndo).toBe(false)
  })

  it.each(['accepted', 'refused', 'closed', 'replaced', 'newer dialog'])('awaits asset autoresolution before provenance and leftover prompts: %s', async (completion) => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, {
      schemaVersion: 1,
      nodes: { AssetLoader: { interface: [
        { role: 'input', id: 'file', type: { kind: 'concrete', types: ['ASSET'] }, widget: { type: 'ASSET', accept: [] } },
      ] } },
    }))
    const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'known.png', held: true,
      confidence: 'path' as const, virtualPath: 'imports/known.png', size: 17, mediaType: 'image/png' }
    vi.spyOn(backend.connection, 'guessAssets').mockImplementation(async (names) => names.map((query) => ({
      query, candidates: query === asset.name ? [asset] : [],
    })))
    const dispatch = app.dispatchTo.bind(app)
    let finish: (() => void) | undefined
    let delivered!: Promise<CommandOutcome>
    vi.spyOn(app, 'dispatchTo').mockImplementation((owner, invocation) => {
      delivered = new Promise<CommandOutcome>((resolve) => {
        finish = () => resolve(completion === 'refused' ? { ok: false, diagnostics: [] } : dispatch(owner, invocation))
      })
      return delivered as unknown as CommandOutcome
    })
    app.openDocument({ version: 0.4, nodes: [
      { id: 1, type: 'AssetLoader', pos: [100, 100], widgets_values: ['known.png'] },
      { id: 2, type: 'AssetLoader', pos: [400, 100], widgets_values: ['missing.png'] },
    ], links: [] }, 'Imported assets')
    const tab = app.activeTab()!
    const original = structuredClone(tab.store.doc)
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(tab.store.doc).toEqual(original)
    expect(app.importAssetResolution.get()).toBeUndefined()
    expect(app.problems.get().some((entry) => entry.code === 'import.assets.autoResolved')).toBe(false)
    if (completion === 'closed') app.closeTab(tab.id)
    if (completion === 'replaced') app.openDocument(original, 'Replacement')
    const newer = { matches: [], reasons: {}, accept: () => {}, cancel: () => {} }
    if (completion === 'newer dialog') app.importAssetResolution.set(newer)
    finish!()
    await delivered
    await Promise.resolve()
    if (completion === 'accepted' || completion === 'refused') {
      expect(app.importAssetResolution.get()?.matches.map((match) => match.query)).toEqual(
        completion === 'accepted' ? ['missing.png'] : ['known.png', 'missing.png'])
      expect(app.problems.get().some((entry) => entry.code === 'import.assets.autoResolved')).toBe(completion === 'accepted')
      expect(tab.store.doc.graphs.g0!.nodes.n1!.values.file).toEqual(completion === 'accepted'
        ? { digest: asset.digest, name: asset.name, virtualPath: asset.virtualPath, size: asset.size, mediaType: asset.mediaType }
        : 'known.png')
      if (completion === 'accepted') { expect(tab.store.undo()).toBe(true); expect(tab.store.doc).toEqual(original) }
    } else if (completion === 'newer dialog') expect(app.importAssetResolution.get()).toBe(newer)
    else {
      expect(app.importAssetResolution.get()).toBeUndefined()
      expect(app.problems.get().some((entry) => entry.code === 'import.assets.autoResolved')).toBe(false)
      if (completion === 'replaced') expect(app.activeTab()!.store.doc).toEqual(original)
    }
  })

  it('imports exact native classes and links without inserting or rewriting nodes', () => {
    loadNativeSchemas()
    expect(app.openDocument(imageWorkflow, 'Image workflow')).toEqual([])
    const tab = app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    expect(Object.values(graph.nodes).map((node) => [node.id, node.type])).toEqual([
      ['n1', 'EmptyImage'], ['n2', 'PreviewImage'],
    ])
    expect(graph.nodes.n1!.values).toEqual({ width: 61, height: 29, batch_size: 2, color: 7 })
    expect(graph.links.l1).toEqual({ id: 'l1', from: { node: 'n1', port: 'image' }, to: { node: 'n2', port: 'images' } })
    expect(tab.store.doc.view.graphs.g0!.nodes.n2!.position).toEqual({ x: 300, y: 50 })
    expect(tab.store.revision).toBe(0)
    expect(tab.store.canUndo).toBe(false)
    const compiled = app.compileTab(tab)
    expect(compiled?.ok, JSON.stringify(compiled)).toBe(true)
    if (compiled?.ok) {
      expect(compiled.artifact.prompt.n1!.class_type).toBe('EmptyImage')
      expect(compiled.artifact.prompt.n1!.inputs).toEqual({ width: 61, height: 29, batch_size: 2, color: 7 })
      expect(compiled.artifact.prompt.n2!.inputs.images).toEqual(['n1', 0])
    }
  })

  it('refuses LiteGraph import before schemas without changing the active document', () => {
    const tab = app.activeTab()!
    const authored = structuredClone(tab.store.doc)
    expect(app.openDocument(imageWorkflow, 'Image chain')).toContainEqual(expect.objectContaining({ code: 'import.registryMissing' }))
    expect(app.activeTab()).toBe(tab)
    expect(tab.store.doc).toEqual(authored)
    expect(tab.store.canUndo).toBe(false)
  })

  it.each([false, true])('keeps a native document intact when schemas are initially available=%s', (available) => {
    if (available) loadNativeSchemas()
    expect(app.openDocument(seedBasic, 'Image chain')).toEqual([])
    const tab = app.activeTab()!
    const authored = structuredClone(tab.store.doc)
    loadNativeSchemas()
    expect(tab.store.doc).toEqual(authored)
    expect(tab.store.revision).toBe(0)
    expect(tab.store.canUndo).toBe(false)
    expect(tab.store.doc.graphs.g0!.links.l2!.from).toEqual({ node: 'n0', port: 'out0' })
    expect(app.compileTab(tab)?.ok).toBe(false)
  })

  it('retains every authored node and edge of an unregistered processing chain', () => {
    loadNativeSchemas()
    const types = ['EmptyImage', 'ImageTileSplit', 'ImageScaleBy', 'ImageTileMerge', 'PreviewImage']
    const workflow = {
      nodes: types.map((type, index) => ({
        id: index + 1, type, pos: [index * 150, index * 20],
        inputs: index === 0 ? [] : [{ name: 'images', link: index }],
        outputs: index === types.length - 1 ? [] : [{ name: 'IMAGE', links: [index + 1] }],
        widgets_values: index === 0 ? [61, 29, 2, 7] : [],
      })),
      links: types.slice(1).map((_, index) => [index + 1, index + 1, 0, index + 2, 0, 'IMAGE']),
    }
    expect(app.openDocument(workflow, 'Processing chain')).toEqual([])
    const tab = app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    expect(Object.values(graph.nodes).map((node) => node.type)).toEqual(types)
    expect(Object.values(graph.links).map((link) => [link.from, link.to])).toEqual([
      [{ node: 'n1', port: 'image' }, { node: 'n2', port: 'images' }],
      [{ node: 'n2', port: 'IMAGE' }, { node: 'n3', port: 'images' }],
      [{ node: 'n3', port: 'IMAGE' }, { node: 'n4', port: 'images' }],
      [{ node: 'n4', port: 'IMAGE' }, { node: 'n5', port: 'images' }],
    ])
    expect(tab.store.doc.view.graphs.g0!.nodes.n4!.position).toEqual({ x: 450, y: 60 })
    expect(tab.store.canUndo).toBe(false)
    for (const type of types.slice(1, 4)) expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'schema.unresolvedType', message: expect.stringContaining(type),
    }))
  })

  it('preserves native document output identities instead of repairing them from a schema', () => {
    loadNativeSchemas()
    const document = structuredClone(app.tabs.get()[0]!.store.doc)
    const authored = document.graphs[document.root]!.links
    expect(app.openDocument(document, 'Native document')).toEqual([])
    const tab = app.activeTab()!
    expect(tab.store.doc.graphs[document.root]!.links).toEqual(authored)
    expect(tab.store.doc).toEqual(document)
    expect(tab.store.revision).toBe(0)
  })

  it('does not rewrite seed identities or create an undo step on schema arrival', () => {
    const documents = app.tabs.get().map((tab) => structuredClone(tab.store.doc))
    loadNativeSchemas()
    for (const [index, tab] of app.tabs.get().entries()) {
      expect(tab.store.doc).toEqual(documents[index])
      expect(tab.store.canUndo).toBe(false)
    }
  })

  it('retargets an authored document without modifying it', () => {
    const tab = app.tabs.get()[0]!
    const backend = app.backends.get()[0]!
    backend.registry.set(historicalRegistry(backend.id))
    const document = structuredClone(tab.store.doc)
    const native = app.addBackend('http://native.test', 'native', false, 'dinkster')!
    native.registry.set(buildDinksterRegistry(native.id, nativePayload))
    app.setTabTarget(tab.id, native.id)
    expect(tab.store.doc).toEqual(document)
    expect(tab.store.canUndo).toBe(false)
  })

  it('preserves edits made before schemas arrive and keeps their undo history', () => {
    const tab = app.tabs.get()[0]!
    expect(tab.store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'width', value: 128,
    } }).ok).toBe(true)
    const document = structuredClone(tab.store.doc)
    const revision = tab.store.revision
    loadNativeSchemas()
    expect(tab.store.doc).toEqual(document)
    expect(tab.store.revision).toBe(revision)
    expect(tab.store.canUndo).toBe(true)
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.n0!.values.width).toBe(64)
  })

  it('retains authored identities when persisted documents reopen with a different registry', () => {
    const global = globalThis as { localStorage?: Storage }
    const entries = new Map<string, string>()
    global.localStorage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key), clear: () => entries.clear(),
      key: (index: number) => [...entries.keys()][index] ?? null,
      get length() { return entries.size },
    } as Storage
    try {
      const first = new AppState()
      const blank = first.activeTab()!
      first.openDocument(seedBasic, 'Basic')
      first.closeTab(blank.id)
      const backend = first.backends.get()[0]!
      backend.registry.set(historicalRegistry(backend.id))
      const authored = structuredClone(first.activeTab()!.store.doc)
      first.flushPersistTabs()
      const second = new AppState()
      const restoredBackend = second.backends.get()[0]!
      restoredBackend.registry.set(buildDinksterRegistry(restoredBackend.id, nativePayload))
      expect(second.activeTab()!.store.doc).toEqual(authored)
      expect(second.activeTab()!.store.canUndo).toBe(false)
    } finally { delete global.localStorage }
  })
})

describe('unresolved-type reporting', () => {
  it('reports schema arrival without rewriting unresolved documents', () => {
    expect(app.openDocument(docJson('NoSuchNode'), 'Missing')).toEqual([])
    const tab = app.activeTab()!
    const authored = structuredClone(tab.store.doc)
    expect(app.problems.get().some((entry) => entry.code === 'schema.unresolvedType')).toBe(false)
    loadNativeSchemas()
    expect(tab.store.doc).toEqual(authored)
    expect(tab.store.revision).toBe(0)
    expect(tab.store.canUndo).toBe(false)
    expect(app.problems.get()).toContainEqual(expect.objectContaining({ code: 'schema.unresolvedType', message: expect.stringContaining('NoSuchNode') }))
  })

  it('names the missing type and count without claiming the whole workflow cannot run', () => {
    loadNativeSchemas()
    expect(app.openDocument(docJson('NoSuchNode', 2), 'Missing')).toEqual([])
    const found = app.problems.get().find((entry) => entry.code === 'schema.unresolvedType' && entry.message.includes('NoSuchNode'))
    expect(found).toBeDefined()
    expect(found!.severity).toBe('warning')
    expect(found!.message).toContain('NoSuchNode (2)')
    expect(found!.message).toContain(`not available on backend ${app.backends.get()[0]!.label}`)
    expect(found!.message).not.toContain('cannot run')
  })

  it('reports once per open rather than again on later backend ticks', () => {
    loadNativeSchemas()
    expect(app.openDocument(docJson('NoSuchNode'), 'Missing')).toEqual([])
    const count = () => app.problems.get().filter((entry) => entry.code === 'schema.unresolvedType' && entry.message.includes('NoSuchNode')).length
    expect(count()).toBe(1)
    app.backendsTick.update((value) => value + 1)
    expect(count()).toBe(1)
  })

  it('recognizes only the exact registered identity, including prefixes', () => {
    loadNativeSchemas()
    const before = app.problems.get().filter((entry) => entry.code === 'schema.unresolvedType')
    expect(app.openDocument(docJson('EmptyImage'), 'Registered')).toEqual([])
    expect(app.problems.get().filter((entry) => entry.code === 'schema.unresolvedType')).toEqual(before)
    expect(app.openDocument(docJson('comfy.EmptyImage'), 'Different identity')).toEqual([])
    expect(app.problems.get()).toContainEqual(expect.objectContaining({ code: 'schema.unresolvedType', message: expect.stringContaining('comfy.EmptyImage') }))
  })
})
