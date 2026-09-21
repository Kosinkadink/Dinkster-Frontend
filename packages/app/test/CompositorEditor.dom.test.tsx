// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import { asConnectionId, asPromptId, DINKSTER_SCHEMA_WIRE_VERSION, EMPTY_COMPOSITOR_RECIPE, registerCatalog, setLocale, type DinksterNodesPayload, type Json } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { CompositorEditor } from '../src/CompositorEditor.js'

const assetDigest = `blake3:${'a'.repeat(64)}`
const transform = (x: number, y: number, width: number, height: number) => ({
  a: 1_000_000, b: 0, c: 0, d: 1_000_000, tx: x * 1_000_000, ty: y * 1_000_000,
  components: { x, y, width, height, rotation: 0, flipHorizontal: false, flipVertical: false, sourceWidth: width, sourceHeight: height },
})
const imageDocument = {
  format: 'dinkster-image', formatVersion: 2, lineage: 'compositor-state',
  canvas: { width: 320, height: 240, colorSpace: 'srgb', channelDepth: 8, compositing: 'premultiplied-alpha', background: [4112, 8224, 12336, 32768] },
  allocation: { nextOrdinal: 4 }, rootLayerIds: ['l0', 'l2'],
  layers: {
    'l0': { id: 'l0', kind: 'raster', name: 'Background', visible: true, opacity: 65_535, transform: transform(0, 0, 320, 240), blendMode: 'normal', clipping: 'none', maskIds: [], resourceId: 'r1', sourceRect: { x: 0, y: 0, width: 320, height: 240 }, z_index: 0 },
    'l2': { id: 'l2', kind: 'raster', name: 'Overlay', visible: true, opacity: 49_151, transform: transform(40, 30, 80, 60), blendMode: 'screen', clipping: 'none', maskIds: [], resourceId: 'r3', sourceRect: { x: 0, y: 0, width: 80, height: 60 }, z_index: 1 },
  },
  masks: {},
  resources: {
    'r1': { id: 'r1', kind: 'raster', digest: assetDigest, byteSize: 1, mediaType: 'image/png', width: 320, height: 240, colorSpace: 'srgb', channelDepth: 8, alphaMode: 'straight' },
    'r3': { id: 'r3', kind: 'raster', digest: assetDigest, byteSize: 1, mediaType: 'image/png', width: 80, height: 60, colorSpace: 'srgb', channelDepth: 8, alphaMode: 'straight' },
  },
}
const state = { version: 2 as const, document: imageDocument, documentDigest: assetDigest, stale: false, layerStreams: ['compositor.layer.0', 'compositor.layer.1'] }

const payload = {
  schemaVersion: 1,
  nodes: {
    Compositor: {
      schemaVersion: 1,
      displayName: 'Create Layered Image',
      category: 'image/compositing',
      idempotent: false,
      outputNode: true,
      editorRole: 'compositor',
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
  },
} as unknown as DinksterNodesPayload

function mount(options: {
  readonly storedValue?: Json
  readonly previewState?: typeof state
} = {}) {
  const app = new AppState()
  const tab = app.tabs.get()[0]!
  app.registry.set(buildDinksterRegistry(asConnectionId('local'), payload))
  const graphId = tab.store.doc.root
  const seedNodeIds = Object.keys(tab.store.doc.graphs[graphId]!.nodes)
  if (seedNodeIds.length > 0 && !app.dispatchTo(tab, {
    command: 'node.remove', params: { graphId, nodeIds: seedNodeIds },
  }).ok) throw new Error('failed to clear compositor fixture graph')
  const before = new Set(Object.keys(tab.store.doc.graphs[graphId]!.nodes))
  if (!app.dispatchTo(tab, {
    command: 'node.add', params: { graphId, type: 'Compositor', position: { x: 20, y: 30 } },
  }).ok) throw new Error('failed to add compositor fixture node')
  const nodeId = Object.keys(tab.store.doc.graphs[graphId]!.nodes).find((id) => !before.has(id))!
  if (options.storedValue !== undefined && !app.dispatchTo(tab, {
    command: 'node.setValue',
    params: { graphId, nodeId, inputId: 'recipe', value: options.storedValue },
  }).ok) throw new Error('failed to store compositor fixture recipe')
  const target = app.compositorTargetForInput(tab, graphId, nodeId, 'recipe')!
  const compiled = app.compileTab(tab)
  if (!compiled?.ok) throw new Error(`failed to compile compositor fixture: ${JSON.stringify(compiled?.diagnostics)}`)
  const ref = { connection: asConnectionId('local'), prompt: asPromptId('compositor-run') }
  app.registerRun(tab, ref, compiled.artifact, 1)
  const runtimeNodeId = Object.values(compiled.artifact.provenance.fromSource).flat()[0]!
  app.store.apply({
    kind: 'preview', execution: ref, timestamp: 2, runtimeNodeId,
    channel: 'application/vnd.dinkster.compositor-state+json', stream: 'compositor-state',
    payload: options.previewState ?? state,
  })
  if (!app.openCompositorEditor(target)) throw new Error('failed to open compositor fixture')
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <CompositorEditor app={app} />, root)
  return { app, tab, graphId, nodeId, root, dispose }
}

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
  localStorage.clear()
})

describe('CompositorEditor', () => {
  it('edits layer order and properties, then commits one exact atomic recipe', () => {
    const mounted = mount()
    expect(mounted.root.querySelectorAll('.compositor-layer-row')).toHaveLength(2)
    expect([...mounted.root.querySelectorAll<HTMLInputElement>('input')].some((input) => input.value === '320')).toBe(true)
    expect(mounted.root.textContent).toContain('Overlay')

    const name = [...mounted.root.querySelectorAll<HTMLInputElement>('.compositor-properties input')]
      .find((input) => input.value === 'Overlay')!
    name.value = 'Watermark'
    name.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const lower = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Lower')!
    lower.click()
    const revision = mounted.tab.store.revision
    const apply = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Apply')!
    apply.click()

    expect(mounted.tab.store.revision).toBe(revision + 1)
    const value = mounted.tab.store.doc.graphs[mounted.graphId]!.nodes[mounted.nodeId]!.values['recipe'] as {
      version: number; documentDigest: string; commands: Json[]
    }
    expect(value.version).toBe(2)
    expect(value.documentDigest).toBe(assetDigest)
    expect(value.commands).toContainEqual({
      op: 'layer', id: 'l2',
      changes: { name: 'Watermark', visible: true, opacity: 49_151, blendMode: 'screen' },
    })
    expect(value.commands.at(-1)).toEqual({ op: 'reorder', ids: ['l2', 'l0'] })
    expect(mounted.app.imageEditorTarget.get()).toBeUndefined()
    mounted.dispose()
    mounted.app.dispose()
  })

  it('refuses an apply after the stored recipe changes concurrently', () => {
    const mounted = mount()
    const recipe = { version: 2, documentDigest: assetDigest, commands: [{ op: 'layer', id: 'l0', changes: { visible: false } }] }
    expect(mounted.app.dispatchTo(mounted.tab, {
      command: 'node.setValue',
      params: { graphId: mounted.graphId, nodeId: mounted.nodeId, inputId: 'recipe', value: recipe },
    }).ok).toBe(true)
    const apply = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Apply')!
    apply.click()
    expect(apply.disabled).toBe(true)
    expect(mounted.root.querySelector('[role="alert"]')).toBeNull()
    expect(mounted.app.imageEditorTarget.get()).toBeDefined()
    mounted.dispose()
    mounted.app.dispose()
  })

  it('uses the runtime document when the stored delta is stale', () => {
    const saved = { version: 2, documentDigest: `blake3:${'b'.repeat(64)}`, commands: [] }
    const mounted = mount({ storedValue: saved, previewState: { ...state, stale: true } })
    expect(mounted.root.textContent).toContain('Overlay')
    mounted.dispose()
    mounted.app.dispose()
  })

  it('updates mounted host text when the locale changes and preserves catalog fallback', () => {
    registerCatalog('de-DE', { 'compositor.layers.title': 'Ebenen' })
    const mounted = mount()
    expect(mounted.root.textContent).toContain('Layers')
    expect(mounted.root.textContent).toContain('Apply')

    setLocale('de-DE')
    expect(mounted.root.textContent).toContain('Ebenen')
    expect(mounted.root.textContent).not.toContain('Layers')
    expect(mounted.root.textContent).toContain('Apply')

    mounted.dispose()
    mounted.app.dispose()
  })
})
