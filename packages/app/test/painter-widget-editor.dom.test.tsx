import { asLinkId, asNodeId, asPortId, coreCommandRegistry, DocumentStore, elaborateInterface, importLitegraph, parseDinksterSchema, type CompileArtifact, type NodeSchema } from '@dinkster/core'
import { createWidgetRegistry } from '@dinkster/widgets'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor } from '../src/WidgetEditor.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import type { ExecutionState } from '@dinkster/client'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// Painter's editor row as the engine declares it: it writes the mask row and reads the node's image.
const painterRow = { kind: 'editor', id: 'painter', widget: { type: 'PAINTER', writes: { mask: 'mask' }, reads: { image: 'image' } } } as const
const maskRow = { kind: 'input', id: 'mask', type: { kind: 'concrete', types: ['ASSET'] }, required: false,
  widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image', allowUpload: true },
  sourceFilename: { kind: 'media/image', category: 'input' } } as const
// What the canvas hands the editor when the Painter row is opened.
const painterEditor = (schema: NodeSchema) => {
  const row = elaborateInterface(schema, { values: {} }).items.find((item) => item.kind === 'editor')!
  return { spec: row.widget, target: { kind: 'input' as const, nodeId: 'n1', valueKey: 'mask', parts: row.parts } }
}

it.each(['live', 'refused', 'closed', 'edited', 'disconnected', 'disposed'] as const)(
  'keeps the connected IMAGE receipt the Painter row reads through decode and draw: %s', async (scenario) => {
    const nodeType = 'dinkster.image.painter'
    const schema = parseDinksterSchema(nodeType, { body: [
      { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } },
      maskRow, painterRow,
    ] }).schema!
    const imported = importLitegraph({ nodes: [{ id: 1, type: nodeType }], links: [] }, () => schema).document!
    const graph = imported.graphs.g0!
    const doc = { ...imported, graphs: { g0: { ...graph, nodes: { ...graph.nodes,
      source: { id: asNodeId('source'), type: 'Source', values: {} },
    }, links: { image: { id: asLinkId('image'), from: { node: asNodeId('source'), port: asPortId('IMAGE') },
      to: { node: asNodeId('n1'), port: asPortId('image') } } } } } }
    const app = createWorkflowApp([schema])
    await app.openDocument(doc, 'Connected Painter')
    const tab = app.activeTab()!
    const art = { snapshot: tab.store.doc, schemaHash: 'schema', connection: app.connection.id,
      prompt: { source: { class_type: 'Source', inputs: {} } },
      provenance: { toSource: { source: 'source' }, fromSource: {} },
    } as unknown as CompileArtifact
    const execution = { key: 'painter-job', ref: { connection: app.connection.id, prompt: 'job' },
      status: 'completed', artifact: art, nodes: {}, outputs: { source: {} },
    } as unknown as ExecutionState
    vi.spyOn(app, 'executionForTab').mockReturnValue(execution)
    vi.spyOn(app, 'compileTabCached').mockReturnValue({ ok: true, artifact: art })
    let renditions = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!new URL(String(url), 'http://fixture').searchParams.has('rendition')) return Response.json(scenario === 'refused' ? { available: false } : {
        available: true, descriptor: { typeId: 'IMAGE', fingerprint: 'image', meta: {} },
        renditions: [{ kind: 'png', mime: 'image/png', default: true }],
      })
      renditions++
      return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png', 'X-Dinkster-Fingerprint': 'image', 'X-Dinkster-Rendition': 'png' } })
    })
    const context = { clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const bitmap = { width: 13, height: 7, close: vi.fn() }
    let finish!: () => void
    const decode = vi.fn(() => new Promise<typeof bitmap>((resolve) => { finish = () => resolve(bitmap) }))
    vi.stubGlobal('createImageBitmap', decode)
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <WidgetEditor app={app} ed={{ tab, graphId: 'g0',
      ...painterEditor(schema), label: 'Mask',
      multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial: null,
    }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
    try {
      if (scenario === 'refused') {
        await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull())
        return
      }
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
      if (scenario === 'closed') dispose()
      if (scenario === 'edited') tab.store.dispatch({ command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Edited while decoding' } })
      if (scenario === 'disconnected') {
        vi.stubGlobal('WebSocket', class { close() {} })
        app.connection.connect(); app.connection.disconnect()
      }
      if (scenario === 'disposed') app.dispose()
      finish()
      await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
      expect(context.drawImage).toHaveBeenCalledTimes(scenario === 'live' ? 1 : 0)
      if (scenario === 'live') {
        expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
        expect(root.querySelector('canvas')?.width).toBe(13)
      }
    } finally { finish?.(); dispose(); app.dispose() }
  },
)

it.each(['apply', 'local', 'failure', 'cancel', 'retarget', 'closed'] as const)('keeps Painter edits undoable and authority-bound on %s', async (outcome) => {
  const schema = parseDinksterSchema('Painter', { body: [
    maskRow, painterRow,
  ] }).schema!
  const metadata = { mediaType: 'image/png', name: 'old.png', size: 1, virtualPath: 'old.png' }
  const initial = outcome === 'local'
    ? { ...metadata, verification: 'unverified', localBinding: 'engine-issued-binding' }
    : { ...metadata, digest: `blake3:${'a'.repeat(64)}` }
  const painted = { ...metadata, digest: `blake3:${'b'.repeat(64)}`, name: 'painting.png' }
  const doc = importLitegraph({ nodes: [{ id: 1, type: 'Painter', widgets_values: [initial] }], links: [] }, () => schema).document!
  const store = new DocumentStore(doc, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  const context = { clearRect() {}, drawImage() {}, fillRect() {} }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['painted-pixels'], { type: 'image/png' })))
  vi.stubGlobal('createImageBitmap', async () => ({ close() {} }))
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  let requested = false
  const connection = {
    fetchMountSettings: async () => ({ mounts: [] }),
    fetchMountLocations: async () => ({ activeMounts: [] }),
    onMountsChanged: () => () => {},
    fetchAssetBytes: async () => outcome === 'local' ? undefined : new Uint8Array([1]).buffer,
    fetchLocalAssetBytes: async (binding: string) => binding === 'engine-issued-binding' ? new Uint8Array([2]).buffer : undefined,
    uploadMediaAsset: async (file: File) => {
      expect(file.type).toBe('image/png')
      expect(file.size).toBe(14)
      requested = true
      await pending
      if (outcome === 'failure') throw new Error('upload refused')
      return painted
    },
  }
  let backend = { protocol: 'dinkster', connection }
  const app = {
    widgetRegistry: registry, widgetRegistryForTab: () => registry,
    backendForTab: () => backend,
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  let closed = false
  const dispose = render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', ...painterEditor(schema), label: 'Mask',
    multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => { closed = true }} />, root)
  const button = (name: string) => Array.from(document.querySelectorAll('button')).find((item) => item.textContent === name)!
  await vi.waitFor(() => expect(button('Apply').disabled).toBe(false))
  expect(document.querySelector('canvas')?.width).toBe(512)
  if (outcome === 'cancel') {
    button('Cancel').click()
    expect(closed).toBe(true)
    expect(requested).toBe(false)
  } else {
    button('Apply').click()
    await vi.waitFor(() => expect(requested).toBe(true))
    expect(store.doc.graphs.g0!.nodes.n1!.values.mask).toEqual(initial)
    if (outcome === 'retarget') backend = { ...backend, connection: { ...connection } }
    if (outcome === 'closed') dispose()
    finish()
    if (outcome === 'apply' || outcome === 'local') {
      await vi.waitFor(() => expect(store.doc.graphs.g0!.nodes.n1!.values.mask).toEqual(painted))
      expect(closed).toBe(true)
      expect(store.undo()).toBe(true)
      expect(store.doc.graphs.g0!.nodes.n1!.values.mask).toEqual(initial)
    } else if (outcome !== 'closed') {
      await vi.waitFor(() => expect(document.querySelector('[role="alert"][data-tone="error"]')?.textContent).toContain(outcome === 'failure' ? 'upload refused' : 'backend changed'))
    } else await pending
  }
  if (outcome !== 'closed') dispose()
  expect(store.doc.graphs.g0!.nodes.n1!.values.mask).toEqual(initial)
})

it.each(['live', 'closed-decode', 'edited', 'disconnected'] as const)(
  'loads a saved Painter mask and discards stale bitmap decodes: %s', async (scenario) => {
    const schema = parseDinksterSchema('Painter', { body: [
      maskRow, painterRow,
    ] }).schema!
    const initial = { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png', name: 'mask.png', size: 7, virtualPath: '' }
    const doc = importLitegraph({ nodes: [{ id: 1, type: 'Painter', widgets_values: [initial] }], links: [] }, () => schema).document!
    const app = createWorkflowApp([schema])
    expect((await app.openDocument(doc, 'Painter reader'))).toEqual([])
    const tab = app.activeTab()!
    const context = { clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    let finish!: () => void
    const bitmap = { width: 13, height: 7, close: vi.fn() }
    const decode = vi.fn(() => new Promise<typeof bitmap>((resolve) => { finish = () => resolve(bitmap) }))
    vi.stubGlobal('createImageBitmap', decode)
    const fetch = vi.spyOn(app.backendForTab(tab).connection, 'fetchAssetBytes').mockResolvedValue(new Uint8Array([1]).buffer)
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <WidgetEditor app={app} ed={{
      tab, graphId: 'g0', ...painterEditor(schema), label: 'Mask',
      multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial,
    }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
    try {
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
      expect(fetch).toHaveBeenCalledWith(initial.digest, expect.any(AbortSignal))
      if (scenario === 'closed-decode') dispose()
      if (scenario === 'edited') expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n1', inputId: 'mask', value: { ...initial, digest: `blake3:${'b'.repeat(64)}` },
      } })).ok).toBe(true)
      if (scenario === 'disconnected') {
        vi.stubGlobal('WebSocket', class { close() {} })
        app.connection.connect(); app.connection.disconnect()
      }
      finish()
      await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
      const visible = scenario === 'live' || scenario === 'disconnected'
      expect(context.drawImage).toHaveBeenCalledTimes(visible ? 1 : 0)
      if (visible) {
        expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 512, 512)
        expect(Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Apply')?.disabled).toBe(false)
      }
    } finally { finish?.(); dispose(); app.dispose() }
  },
)
