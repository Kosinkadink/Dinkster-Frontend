/**
 * EditorRegistry (editors.ts): the center-region editor seam. A tab is
 * conceptually (document, editorKind); the shell resolves the active tab's
 * kind through this registry, so future editor kinds are descriptors, not
 * shell rewrites.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JSX } from 'solid-js'
import { asConnectionId, asPromptId, EMPTY_COMPOSITOR_RECIPE, type DinksterNodesPayload, type ExecutionRef } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { APP_EDITOR_KIND, CURVE_EDITOR_KIND, EditorRegistry, GLSL_EDITOR_KIND, GRAPH_EDITOR_KIND, IMAGE_EDITOR_KIND } from '../src/editors.js'
import { AppState } from '../src/app-state.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/dinkster-nodes-comfy.json'), 'utf8'),
) as DinksterNodesPayload

/** Minimal in-memory localStorage for the node test env. */
const makeStorage = (): Storage => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

const TABS_KEY = 'dinkster.openTabs'

const compositorPayload = (): DinksterNodesPayload => ({
  schemaVersion: 1,
  nodes: {
    Compositor: {
      schemaVersion: 1,
      displayName: 'Create Layered Image',
      category: 'image/compositing',
      idempotent: false,
      interface: [
        {
          role: 'input', id: 'recipe', required: false,
          type: { kind: 'concrete', types: ['dinkster.compositor'] },
          default: EMPTY_COMPOSITOR_RECIPE,
          widget: { type: 'COMPOSITOR' },
        },
        { role: 'output', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } },
      ],
    },
    Source: {
      schemaVersion: 1,
      displayName: 'Source',
      category: 'test',
      idempotent: true,
      interface: [
        { role: 'output', id: 'out', type: { kind: 'concrete', types: ['dinkster.compositor'] } },
      ],
    },
  },
}) as unknown as DinksterNodesPayload

const curveFollowPayload = (): DinksterNodesPayload => ({
  schemaVersion: 1,
  nodes: {
    AudioSource: {
      schemaVersion: 1, displayName: 'Audio source', category: 'test', idempotent: true,
      interface: [{ role: 'output', id: 'audio', type: { kind: 'concrete', types: ['comfy.AUDIO'] } }],
    },
    'dinkster.audio.envelope': {
      schemaVersion: 1, displayName: 'Audio envelope', category: 'audio', idempotent: true,
      interface: [
        { role: 'input', id: 'audio', required: true, type: { kind: 'concrete', types: ['comfy.AUDIO'] } },
        { role: 'output', id: 'curve', type: { kind: 'concrete', types: ['dinkster.curve'] } },
      ],
    },
    'dinkster.curve.editor': {
      schemaVersion: 1, displayName: 'Curve editor', category: 'curve', idempotent: true,
      interface: [
        {
          role: 'input', id: 'curve', required: false,
          type: { kind: 'concrete', types: ['dinkster.curve'] }, widget: { type: 'CURVE' },
          default: { interpolation: 'linear', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] },
        },
        { role: 'output', id: 'curve', type: { kind: 'concrete', types: ['dinkster.curve'] } },
      ],
    },
    OtherCurve: {
      schemaVersion: 1, displayName: 'Other curve', category: 'test', idempotent: true,
      interface: [{ role: 'output', id: 'curve', type: { kind: 'concrete', types: ['dinkster.curve'] } }],
    },
  },
}) as unknown as DinksterNodesPayload

const glslPayload = (): DinksterNodesPayload => ({
  schemaVersion: 1,
  nodes: {
    'dinkster.image.glsl_shader': {
      schemaVersion: 1,
      displayName: 'GLSL Shader',
      category: 'image/shader',
      idempotent: false,
      interface: [
        {
          role: 'input', id: 'fragment_shader', required: false,
          type: { kind: 'concrete', types: ['core.string'] },
          default: '#version 300 es\nvoid main() {}',
          widget: { type: 'STRING', multiline: true },
        },
        { role: 'output', id: 'image0', type: { kind: 'concrete', types: ['dinkster.image'] } },
      ],
    },
  },
}) as unknown as DinksterNodesPayload

const maskPaintPayload = (): DinksterNodesPayload => ({
  schemaVersion: 1,
  nodes: {
    'dinkster.load_image': {
      schemaVersion: 1, displayName: 'Load Image', category: 'image', idempotent: true,
      interface: [
        { role: 'input', id: 'image', required: true, type: { kind: 'asset', element: { kind: 'concrete', types: ['dinkster.image'] } }, widget: { type: 'ASSET', accept: ['image/png'] } },
        { role: 'output', id: 'image', type: { kind: 'concrete', types: ['dinkster.image'] } },
        { role: 'output', id: 'mask', type: { kind: 'concrete', types: ['dinkster.mask'] } },
      ],
    },
    'dinkster.mask.paint': {
      schemaVersion: 1, displayName: 'Paint Mask', category: 'image', idempotent: true,
      interface: [
        { role: 'input', id: 'source', required: true, type: { kind: 'asset', element: { kind: 'concrete', types: ['dinkster.image'] } }, widget: { type: 'ASSET', accept: ['image/png'] } },
        { role: 'input', id: 'operations', required: true, type: { kind: 'concrete', types: ['core.string'] }, widget: { type: 'STRING', multiline: true } },
        { role: 'output', id: 'mask', type: { kind: 'concrete', types: ['dinkster.mask'] } },
      ],
    },
  },
}) as unknown as DinksterNodesPayload

const desc = (id: string) => ({
  id,
  title: `Editor ${id}`,
  component: () => null as unknown as JSX.Element,
})

describe('EditorRegistry', () => {
  it('registers, resolves, lists, and unregisters editor kinds', () => {
    const reg = new EditorRegistry()
    const un = reg.register(desc('graph'))
    reg.register(desc('compositor'))
    expect(reg.get('graph')?.title).toBe('Editor graph')
    expect(reg.kinds().map((e) => e.id)).toEqual(['graph', 'compositor'])
    un()
    expect(reg.get('graph')).toBeUndefined()
    expect(reg.kinds().map((e) => e.id)).toEqual(['compositor'])
  })

  it('refuses duplicate kind ids loudly', () => {
    const reg = new EditorRegistry()
    reg.register(desc('graph'))
    expect(() => reg.register(desc('graph'))).toThrow(/already registered/)
  })

  it('bumps changed on register and unregister', () => {
    const reg = new EditorRegistry()
    const before = reg.changed.get()
    const un = reg.register(desc('graph'))
    expect(reg.changed.get()).toBe(before + 1)
    un()
    expect(reg.changed.get()).toBe(before + 2)
  })

  it('returns the SAME descriptor object across lookups (keyed hosts never remount)', () => {
    const reg = new EditorRegistry()
    reg.register(desc('graph'))
    expect(reg.get('graph')).toBe(reg.get('graph'))
  })
})

describe('Tab editorKind', () => {
  // AppState builds its WS url from the page origin; give the node env one.
  const g = globalThis as { location?: unknown; localStorage?: Storage }
  beforeEach(() => {
    vi.useFakeTimers()
    g.location = { protocol: 'http:', host: 'test' }
  })
  afterEach(() => {
    vi.useRealTimers()
    delete g.localStorage
  })

  it('every tab STARTS as a graph-editor tab, and the app exposes the registry', () => {
    const app = new AppState()
    expect(app.tabs.get().length).toBeGreaterThan(0)
    for (const tab of app.tabs.get()) expect(tab.editorKind).toBe(GRAPH_EDITOR_KIND)
    // The registry itself is empty until the shell registers core kinds
    // (App.tsx registers the graph and app editors on mount).
    expect(app.editors.kinds()).toEqual([])
  })

  it('opens a synthetic pack editor through its binding and registers its panel', () => {
    const app = new AppState()
    const provider = () => ({ version: 1 as const, root: { kind: 'text' as const, key: 'proof', text: 'Pack surface' } })
    const unregisterCoreBinding = app.frontendDoors.editorBinding('builtin.synthetic-node', {
      editor: GRAPH_EDITOR_KIND, match: { nodeId: 'synthetic.node' }, priority: 100,
    })
    const diagnostics = app.extensions.register({
      id: 'synthetic',
      contributions: [
        { id: 'synthetic.editor', category: 'editor' },
        { id: 'synthetic.binding', category: 'editorBinding' },
        { id: 'synthetic.panel.right', category: 'panel' },
        { id: 'synthetic.panel.left', category: 'panel' },
        { id: 'synthetic.panel.bottom', category: 'panel' },
        { id: 'synthetic.panel.toolbar', category: 'panel' },
      ],
    }, (api) => {
      api.editor('synthetic.editor', { id: 'synthetic.editor', title: 'Synthetic editor', provider })
      api.editorBinding('synthetic.binding', {
        id: 'synthetic.binding', editor: 'synthetic.editor', match: { nodeId: 'synthetic.node' }, priority: 10,
      })
      api.panel('synthetic.panel.right', 'sidebar.right', provider, 12, 'Synthetic panel')
      api.panel('synthetic.panel.left', 'sidebar.left', provider)
      api.panel('synthetic.panel.bottom', 'panel.bottom', provider)
      api.panel('synthetic.panel.toolbar', 'toolbar.canvas', provider)
    })
    expect(diagnostics).toEqual([])
    const tab = app.tabs.get()[0]!
    expect(app.openEditorForBinding(tab.id, { nodeId: 'synthetic.node' })).toBe(true)
    expect(app.tabs.get()[0]!.editorKind).toBe('synthetic.editor')
    expect(app.editors.get('synthetic.editor')?.title).toBe('Synthetic editor')
    expect(app.panels.get('synthetic.panel.right')).toMatchObject({ title: 'Synthetic panel', placement: 'rail' })
    expect(app.panels.get('synthetic.panel.left')?.placement).toBe('dock')
    expect(app.panels.get('synthetic.panel.bottom')?.placement).toBe('bottom')
    expect(app.extensionToolbarPanels.get().map((panel) => panel.id)).toEqual(['synthetic.panel.toolbar'])
    app.extensions.unregister('synthetic')
    expect(app.editors.get('synthetic.editor')).toBeUndefined()
    expect(app.panels.get('synthetic.panel.right')).toBeUndefined()
    expect(app.panels.get('synthetic.panel.left')).toBeUndefined()
    expect(app.panels.get('synthetic.panel.bottom')).toBeUndefined()
    expect(app.extensionToolbarPanels.get()).toEqual([])
    unregisterCoreBinding()
    app.dispose()
  })

  it('setTabEditorKind swaps the projection but keeps id, session, and view state', () => {
    const app = new AppState()
    const tab = app.tabs.get()[0]!
    app.setTabEditorKind(tab.id, APP_EDITOR_KIND)
    const swapped = app.tabs.get().find((t) => t.id === tab.id)!
    expect(swapped.editorKind).toBe(APP_EDITOR_KIND)
    // Same document under a different projection: the session object and
    // per-tab view-state signals survive the swap untouched.
    expect(swapped.store).toBe(tab.store)
    expect(swapped.graphStack).toBe(tab.graphStack)
    expect(swapped.title).toBe(tab.title)
    // Other tabs are untouched.
    for (const other of app.tabs.get()) {
      if (other.id !== tab.id) expect(other.editorKind).toBe(GRAPH_EDITOR_KIND)
    }
    // And back.
    app.setTabEditorKind(tab.id, GRAPH_EDITOR_KIND)
    expect(app.tabs.get().find((t) => t.id === tab.id)!.editorKind).toBe(GRAPH_EDITOR_KIND)
  })

  it('same-kind and unknown-tab switches are no-ops (no tab replacement)', () => {
    const app = new AppState()
    const before = app.tabs.get()
    app.setTabEditorKind(before[0]!.id, GRAPH_EDITOR_KIND) // already graph
    app.setTabEditorKind('no-such-tab', APP_EDITOR_KIND)
    expect(app.tabs.get()).toBe(before) // signal never updated
  })

  it('frozen execution tabs refuse editor-kind switches', () => {
    const app = new AppState()
    const basic = app.tabs.get()[0]!
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), nodesPayload))
    const result = app.compileTab(basic)
    if (!result?.ok) throw new Error('compile failed')
    const ref: ExecutionRef = { connection: asConnectionId('local'), prompt: asPromptId('p0') }
    app.registerRun(basic, ref, result.artifact)
    expect(app.openExecutionView(ref)).toBe(true)
    const frozen = app.tabs.get().find((t) => t.execution)!
    app.setTabEditorKind(frozen.id, APP_EDITOR_KIND)
    expect(app.tabs.get().find((t) => t.execution)!.editorKind).toBe(GRAPH_EDITOR_KIND)
  })

  it('setTabAppArrange toggles per tab, keeps the session, and never persists', () => {
    g.localStorage = makeStorage()
    const app = new AppState()
    const [tab, other] = app.tabs.get()
    if (!tab || !other) throw new Error('fixture needs two tabs')
    expect(tab.appArrange).toBeUndefined()
    app.setTabAppArrange(tab.id, true)
    const arranged = app.tabs.get().find((t) => t.id === tab.id)!
    expect(arranged.appArrange).toBe(true)
    // Same document under the same projection: only the flag changed.
    expect(arranged.store).toBe(tab.store)
    expect(arranged.editorKind).toBe(tab.editorKind)
    // Other tabs are untouched.
    expect(app.tabs.get().find((t) => t.id === other.id)!.appArrange).toBeUndefined()
    // Same-state and unknown-tab writes are no-ops (no tab replacement).
    const before = app.tabs.get()
    app.setTabAppArrange(tab.id, true)
    app.setTabAppArrange('no-such-tab', true)
    expect(app.tabs.get()).toBe(before)
    // Transient UI state: the persisted tab records never carry the flag,
    // flushed while it is set.
    expect(app.tabs.get().find((t) => t.id === tab.id)!.appArrange).toBe(true)
    app.flushPersistTabs()
    const stored = JSON.parse(globalThis.localStorage!.getItem(TABS_KEY)!) as { tabs: Record<string, unknown>[] }
    for (const record of stored.tabs) expect('appArrange' in record).toBe(false)
    app.setTabAppArrange(tab.id, false)
    expect(app.tabs.get().find((t) => t.id === tab.id)!.appArrange).toBe(false)
  })

  it('frozen execution tabs refuse arrange mode', () => {
    const app = new AppState()
    const basic = app.tabs.get()[0]!
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), nodesPayload))
    const result = app.compileTab(basic)
    if (!result?.ok) throw new Error('compile failed')
    const ref: ExecutionRef = { connection: asConnectionId('local'), prompt: asPromptId('p1') }
    app.registerRun(basic, ref, result.artifact)
    expect(app.openExecutionView(ref)).toBe(true)
    const frozen = app.tabs.get().find((t) => t.execution)!
    app.setTabAppArrange(frozen.id, true)
    expect(app.tabs.get().find((t) => t.execution)!.appArrange).toBeUndefined()
  })

  it('admits only an unchanged, undriven COMPOSITOR input into image-editor mode', () => {
    const app = new AppState()
    const tab = app.tabs.get()[0]!
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), compositorPayload()))
    const graphId = tab.store.doc.root
    const before = new Set(Object.keys(tab.store.doc.graphs[graphId]!.nodes))
    expect(app.dispatchTo(tab, {
      command: 'node.add',
      params: { graphId, type: 'Compositor', position: { x: 40, y: 50 } },
    }).ok).toBe(true)
    const nodeId = Object.keys(tab.store.doc.graphs[graphId]!.nodes).find((id) => !before.has(id))!
    const target = app.compositorTargetForInput(tab, graphId, nodeId, 'recipe')
    expect(target).toEqual({
      mode: 'compositor', tabId: tab.id, graphId, nodeId, inputId: 'recipe',
      instancePath: [], openedStoredValue: undefined,
    })
    expect(app.openCompositorEditor(target!)).toBe(true)
    expect(app.imageEditorTarget.get()).toEqual(target)
    expect(app.tabs.get().find((candidate) => candidate.id === tab.id)?.editorKind).toBe(IMAGE_EDITOR_KIND)

    expect(app.dispatchTo(tab, {
      command: 'node.move', params: { graphId, positions: { [nodeId]: { x: 45, y: 57 } } },
    }).ok).toBe(true)
    expect(app.validateCompositorTarget(target!)).toEqual(target)

    const recipe = {
      version: 2,
      documentDigest: `blake3:${'a'.repeat(64)}`,
      commands: [{ op: 'layer', id: 'layer-0', changes: { visible: false } }],
    }
    expect(app.dispatchTo(tab, {
      command: 'node.setValue', params: { graphId, nodeId, inputId: 'recipe', value: recipe },
    }).ok).toBe(true)
    expect(app.validateCompositorTarget(target!)).toBeUndefined()
    const current = app.compositorTargetForInput(tab, graphId, nodeId, 'recipe')
    expect(current?.openedStoredValue).toEqual(recipe)
    app.closeImageEditor(target!)
    expect(app.imageEditorTarget.get()).toEqual(target)
    app.closeImageEditor(app.imageEditorTarget.get()!)
    expect(app.imageEditorTarget.get()).toBeUndefined()
    expect(app.tabs.get().find((candidate) => candidate.id === tab.id)?.editorKind).toBe(GRAPH_EDITOR_KIND)
  })

  it.each(['link', 'net'] as const)('admits only the exact envelope/audio provenance through a %s', (topology) => {
    const app = new AppState()
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), curveFollowPayload()))
    const curveEdge = { from: { node: 'envelope', port: 'curve' }, to: { node: 'editor', port: 'curve' } }
    expect(app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: `curve-follow-${topology}`, root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          audio: { id: 'audio', type: 'AudioSource', values: {} },
          envelope: { id: 'envelope', type: 'dinkster.audio.envelope', values: {} },
          editor: { id: 'editor', type: 'dinkster.curve.editor', values: {} },
          invalidEditor: { id: 'invalidEditor', type: 'dinkster.curve.editor', values: {} },
          other: { id: 'other', type: 'OtherCurve', values: {} },
        },
        links: {
          audioLink: { id: 'audioLink', from: { node: 'audio', port: 'audio' }, to: { node: 'envelope', port: 'audio' } },
          ...(topology === 'link' ? {
            curve: { id: 'curve', ...curveEdge },
            invalidCurve: { id: 'invalidCurve', from: { node: 'other', port: 'curve' }, to: { node: 'invalidEditor', port: 'curve' } },
          } : {}),
        },
        nets: topology === 'net' ? {
          curve: { id: 'curve', name: 'envelope curve', source: curveEdge.from, sinks: [curveEdge.to] },
          invalidCurve: { id: 'invalidCurve', name: 'other curve', source: { node: 'other', port: 'curve' }, sinks: [{ node: 'invalidEditor', port: 'curve' }] },
        } : {},
        reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: {} },
    }, 'Curve follow target')).toEqual([])
    const tab = app.activeTab()!
    expect(app.curveTargetForInput(tab, 'g0', 'editor', 'curve')).toMatchObject({
      nodeId: 'editor', inputId: 'curve', instancePath: [],
      follow: { envelopeNodeId: 'envelope', audioNodeId: 'audio', audioOutputId: 'audio' },
    })
    expect(app.curveTargetForInput(tab, 'g0', 'invalidEditor', 'curve')).toBeUndefined()
    app.dispose()
  })

  it('captures loader mask topology and redirects the associated paint source', () => {
    const app = new AppState()
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), maskPaintPayload()))
    expect(app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'mask-paint-target', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        loader: { id: 'loader', type: 'dinkster.load_image', values: { image: { digest: `blake3:${'a'.repeat(64)}`, name: 'a.png', size: 10, mediaType: 'image/png', virtualPath: '' } } },
        sink: { id: 'sink', type: 'Sink', values: {} },
      }, links: { mask: { id: 'mask', from: { node: 'loader', port: 'mask' }, to: { node: 'sink', port: 'mask' } } }, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: {} },
    }, 'Mask paint target')).toEqual([])
    const tab = app.activeTab()!
    const target = app.imageTargetForInput(tab, 'g0', 'loader', 'image')
    expect(target?.maskPaint).toEqual({ expectedMaskLinkIds: ['mask'], expectedMaskNetIds: [], paintNodeId: null, expectedPaintOperations: null })

    const source = target!.sourceRef
    const operations = `{"version":1,"sourceDigest":"${source.digest}","width":2,"height":1,"commands":[]}`
    expect(app.dispatchTo(tab, { command: 'image.applyMaskPaint', params: {
      graphId: 'g0', loaderNodeId: 'loader', inputId: 'image', expectedSource: source,
      operations, paintNodeId: null, expectedPaintOperations: null,
      expectedMaskLinkIds: ['mask'], expectedMaskNetIds: [],
    } }).ok).toBe(true)
    const paint = Object.values(tab.store.doc.graphs.g0!.nodes).find((node) => node.type === 'dinkster.mask.paint')!
    expect(app.dispatchTo(tab, { command: 'node.setValue', params: {
      graphId: 'g0', nodeId: paint.id, inputId: 'operations',
      value: `{"version":1,"version":1,"sourceDigest":"${source.digest}","width":2,"height":1,"commands":[]}`,
    } }).ok).toBe(true)
    expect(app.imageTargetForInput(tab, 'g0', 'loader', 'image')).toBeUndefined()
    expect(app.dispatchTo(tab, { command: 'node.setValue', params: {
      graphId: 'g0', nodeId: paint.id, inputId: 'operations', value: `${operations}${' '.repeat(4_194_305)}`,
    } }).ok).toBe(true)
    expect(app.imageTargetForInput(tab, 'g0', 'loader', 'image')).toBeUndefined()
    for (const value of [
      operations.replace('"version":1', '"version":1.0'),
      operations.replace('"version":1', '"version":1e0'),
      operations.replace('"width":2', '"width":2.0'),
      operations.replace('"height":1', '"height":1e0'),
    ]) {
      expect(app.dispatchTo(tab, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: paint.id, inputId: 'operations', value,
      } }).ok).toBe(true)
      expect(app.imageTargetForInput(tab, 'g0', 'loader', 'image')).toBeUndefined()
    }
    app.dispose()
  })

  it('refuses a COMPOSITOR input driven only in one subgraph occurrence', () => {
    const app = new AppState()
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), compositorPayload()))
    expect(app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'compositor-occurrence-target',
      root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'root',
          nodes: { instance: { id: 'instance', type: '#body', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
        body: {
          id: 'body', name: 'body',
          nodes: {
            source: { id: 'source', type: 'Source', values: {} },
            compositor: { id: 'compositor', type: 'Compositor', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 1,
        },
      },
      occurrenceTopologies: {
        instance: {
          owner: { instancePath: [], node: 'instance' },
          bodyGraph: 'body',
          links: {
            driven: {
              id: 'driven',
              from: { kind: 'body', endpoint: { node: 'source', port: 'out' } },
              to: { kind: 'body', endpoint: { node: 'compositor', port: 'recipe' } },
            },
          },
          nextOrdinal: 1,
        },
      },
      view: { graphs: {} },
    }, 'Occurrence compositor')).toEqual([])
    const tab = app.activeTab()!
    expect(app.compositorTargetForInput(
      tab, 'body', 'compositor', 'recipe', ['instance'],
    )).toBeUndefined()
    app.dispose()
  })

  it('opens only the exact unchanged first-party GLSL source as a session editor', () => {
    const app = new AppState()
    const tab = app.tabs.get()[0]!
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), glslPayload()))
    const graphId = tab.store.doc.root
    const before = new Set(Object.keys(tab.store.doc.graphs[graphId]!.nodes))
    expect(app.dispatchTo(tab, {
      command: 'node.add',
      params: { graphId, type: 'dinkster.image.glsl_shader', position: { x: 20, y: 30 } },
    }).ok).toBe(true)
    const nodeId = Object.keys(tab.store.doc.graphs[graphId]!.nodes).find((id) => !before.has(id))!
    const target = app.glslTargetForInput(tab, graphId, nodeId, 'fragment_shader')
    expect(target).toEqual({
      tabId: tab.id,
      graphId,
      nodeId,
      inputId: 'fragment_shader',
      instancePath: [],
      openedStoredValue: undefined,
      openedSchemaDefault: '#version 300 es\nvoid main() {}',
      openedValue: '#version 300 es\nvoid main() {}',
    })
    expect(app.glslTargetForInput(tab, graphId, nodeId, 'other')).toBeUndefined()
    expect(app.openGlslEditor(target!)).toBe(true)
    const opened = app.glslEditorTarget.get()!
    expect(opened).toEqual(target)
    expect(app.tabs.get().find((candidate) => candidate.id === tab.id)?.editorKind).toBe(GLSL_EDITOR_KIND)

    expect(app.dispatchTo(tab, {
      command: 'node.setValue',
      params: { graphId, nodeId, inputId: 'fragment_shader', value: 'changed' },
    }).ok).toBe(true)
    expect(app.validateGlslTarget(target!)).toBeUndefined()
    app.closeGlslEditor(opened)
    expect(app.glslEditorTarget.get()).toBeUndefined()
    expect(app.tabs.get().find((candidate) => candidate.id === tab.id)?.editorKind).toBe(GRAPH_EDITOR_KIND)
    app.dispose()
  })

  it('clears session-only editor targets on editor switch or tab close', () => {
    const app = new AppState()
    const tab = app.tabs.get()[0]!
    const imageTarget = {
      tabId: tab.id, graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'image',
      sourceRef: { digest: `blake3:${'a'.repeat(64)}`, name: 'a.png', size: 1, mediaType: 'image/png', virtualPath: '' },
    }
    const curveTarget = {
      tabId: tab.id, graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'curve', instancePath: [],
      openedStoredValue: undefined,
      openedSchemaDefault: undefined,
      openedValue: { interpolation: 'linear' as const, points: [{ position: 0, value: 0 }] },
    }
    const glslTarget = {
      tabId: tab.id, graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'fragment_shader' as const,
      instancePath: [], openedStoredValue: undefined, openedSchemaDefault: '', openedValue: '',
    }
    app.imageEditorTarget.set(imageTarget)
    app.setTabEditorKind(tab.id, IMAGE_EDITOR_KIND)
    expect(app.imageEditorTarget.get()).toBe(imageTarget)
    app.setTabEditorKind(tab.id, GRAPH_EDITOR_KIND)
    expect(app.imageEditorTarget.get()).toBeUndefined()
    app.curveEditorTarget.set(curveTarget)
    app.setTabEditorKind(tab.id, CURVE_EDITOR_KIND)
    expect(app.curveEditorTarget.get()).toBe(curveTarget)
    app.setTabEditorKind(tab.id, GRAPH_EDITOR_KIND)
    expect(app.curveEditorTarget.get()).toBeUndefined()
    app.glslEditorTarget.set(glslTarget)
    app.setTabEditorKind(tab.id, GLSL_EDITOR_KIND)
    expect(app.glslEditorTarget.get()).toBe(glslTarget)
    app.setTabEditorKind(tab.id, GRAPH_EDITOR_KIND)
    expect(app.glslEditorTarget.get()).toBeUndefined()
    app.imageEditorTarget.set(imageTarget)
    app.curveEditorTarget.set(curveTarget)
    app.glslEditorTarget.set(glslTarget)
    app.closeTab(tab.id)
    expect(app.imageEditorTarget.get()).toBeUndefined()
    expect(app.curveEditorTarget.get()).toBeUndefined()
    expect(app.glslEditorTarget.get()).toBeUndefined()
  })

  it.each([IMAGE_EDITOR_KIND, CURVE_EDITOR_KIND, GLSL_EDITOR_KIND])('clears a %s session when another tab activates and never persists it', (kind) => {
    g.localStorage = makeStorage()
    const app = new AppState()
    const [tab, other] = app.tabs.get()
    if (!tab || !other) throw new Error('fixture needs two tabs')
    const target = {
      tabId: tab.id, graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'image',
      sourceRef: { digest: `blake3:${'a'.repeat(64)}`, name: 'a.png', size: 1, mediaType: 'image/png', virtualPath: '' },
    }
    if (kind === IMAGE_EDITOR_KIND) app.imageEditorTarget.set(target)
    else if (kind === CURVE_EDITOR_KIND) app.curveEditorTarget.set({
      tabId: tab.id, graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'curve', instancePath: [],
      openedStoredValue: undefined,
      openedSchemaDefault: undefined,
      openedValue: { points: [{ position: 0, value: 0 }] },
    })
    else app.glslEditorTarget.set({
      tabId: tab.id, graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'fragment_shader', instancePath: [],
      openedStoredValue: undefined, openedSchemaDefault: '', openedValue: '',
    })
    app.setTabEditorKind(tab.id, kind)
    app.flushPersistTabs()
    const stored = JSON.parse(globalThis.localStorage!.getItem(TABS_KEY)!) as { tabs: { title: string; editorKind?: string }[] }
    expect(stored.tabs.find((record) => record.title === tab.title)?.editorKind).toBeUndefined()
    app.activeTabId.set(other.id)
    expect(app.imageEditorTarget.get()).toBeUndefined()
    expect(app.curveEditorTarget.get()).toBeUndefined()
    expect(app.glslEditorTarget.get()).toBeUndefined()
    expect(app.tabs.get().find((candidate) => candidate.id === tab.id)?.editorKind).toBe(GRAPH_EDITOR_KIND)
  })

  it('uses image as the built-in editor kind without a mask compatibility kind', () => {
    const registry = new EditorRegistry()
    registry.register({ id: IMAGE_EDITOR_KIND, title: 'Image editor', component: () => null })
    expect(IMAGE_EDITOR_KIND).toBe('image')
    expect(registry.get('image')?.title).toBe('Image editor')
    expect(registry.get('mask')).toBeUndefined()
  })

  it('editorKind persists (non-graph only) and restores across a reload', () => {
    g.localStorage = makeStorage()
    const app = new AppState()
    const tab = app.tabs.get()[0]!
    app.setTabEditorKind(tab.id, APP_EDITOR_KIND)
    app.flushPersistTabs()
    const stored = JSON.parse(globalThis.localStorage!.getItem(TABS_KEY)!) as {
      tabs: { title: string; editorKind?: string }[]
    }
    const records = stored.tabs
    expect(records.find((r) => r.title === tab.title)?.editorKind).toBe(APP_EDITOR_KIND)
    // Graph tabs omit the field entirely (pre-2.4 snapshot shape).
    for (const r of records) {
      if (r.title !== tab.title) expect(r.editorKind).toBeUndefined()
    }
    // Reload: the restored tab reopens in the app view.
    const app2 = new AppState()
    expect(app2.tabs.get().find((t) => t.id === tab.id)?.editorKind).toBe(APP_EDITOR_KIND)
  })

  it('an unknown persisted editorKind is preserved, not silently coerced to graph', () => {
    g.localStorage = makeStorage()
    const app = new AppState()
    app.flushPersistTabs()
    const raw = JSON.parse(globalThis.localStorage!.getItem(TABS_KEY)!) as {
      tabs: { editorKind?: string }[]
    }
    raw.tabs[0]!.editorKind = 'compositor' // e.g. from an unloaded extension
    globalThis.localStorage!.setItem(TABS_KEY, JSON.stringify(raw))
    // The shell renders its "No editor registered" fallback for this kind;
    // the user's choice survives until the kind's provider returns.
    const app2 = new AppState()
    expect(app2.tabs.get()[0]!.editorKind).toBe('compositor')
  })
})
