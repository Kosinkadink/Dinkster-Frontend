import { asLinkId, asNodeId, asPortId, coreCommandRegistry, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema, type CompileArtifact } from '@dinkster/core'
import { createWidgetRegistry } from '@dinkster/widgets'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor } from '../src/WidgetEditor.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import type { ExecutionState, RetainedAssets } from '@dinkster/client'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['live', 'refused', 'closed', 'edited', 'disconnected', 'disposed'] as const)(
  'keeps the connected IMAGE receipt through Painter decode and draw: %s', async (scenario) => {
    const schema = parseDinksterSchema('Painter', { interface: [
      { role: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } },
      { role: 'input', id: 'mask', type: { kind: 'concrete', types: ['ASSET'] }, required: false,
        widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image', allowUpload: true },
        sourceFilename: { kind: 'media/image', category: 'input' } },
    ] }).schema!
    const imported = importLitegraph({ nodes: [{ id: 1, type: 'Painter' }], links: [] }, () => schema).document!
    const graph = imported.graphs.g0!
    const doc = { ...imported, graphs: { g0: { ...graph, nodes: { ...graph.nodes,
      source: { id: asNodeId('source'), type: 'Source', values: {} },
    }, links: { image: { id: asLinkId('image'), from: { node: asNodeId('source'), port: asPortId('IMAGE') },
      to: { node: asNodeId('n1'), port: asPortId('image') } } } } } }
    const app = createWorkflowApp([schema])
    app.openDocument(doc, 'Connected Painter')
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
    vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
    let acknowledge!: () => void
    vi.mocked(app.connection.retainAssets).mockImplementationOnce((owner, declaration) => new Promise((resolve) => {
      acknowledge = () => resolve({ ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 })
    }))
    let renditions = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!new URL(String(url), 'http://fixture').searchParams.has('rendition')) return Response.json({
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
      target: { kind: 'input', nodeId: 'n1', valueKey: 'mask' }, label: 'Mask',
      spec: inputsOf(schema)[1]!.widget, declaredType: inputsOf(schema)[1]!.type,
      multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial: null,
    }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
    try {
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
      expect(renditions).toBe(0)
      expect(decode).not.toHaveBeenCalled()
      acknowledge()
      if (scenario === 'refused') {
        await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull())
        expect(decode).not.toHaveBeenCalled()
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
  const schema = parseDinksterSchema('Painter', { interface: [
    { role: 'input', id: 'mask', type: { kind: 'concrete', types: ['ASSET'] }, required: false,
      widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image', allowUpload: true },
      sourceFilename: { kind: 'media/image', category: 'input' } },
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
    workflowAssetReader: () => ({ key: 'fixture', current: () => true, read: async <T,>(consume: () => Promise<T>) => consume() }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  let closed = false
  const dispose = render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'mask' }, label: 'Mask',
    spec: inputsOf(schema)[0]!.widget, declaredType: inputsOf(schema)[0]!.type,
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

it.each(['live', 'refused', 'closed-before', 'closed-decode', 'edited', 'disconnected', 'disposed'] as const)(
  'borrows the saved Painter mask owner through bitmap decode: %s', async (scenario) => {
    const schema = parseDinksterSchema('Painter', { interface: [
      { role: 'input', id: 'mask', type: { kind: 'concrete', types: ['ASSET'] }, required: false,
        widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image', allowUpload: true },
        sourceFilename: { kind: 'media/image', category: 'input' } },
    ] }).schema!
    const initial = { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png', name: 'mask.png', size: 7, virtualPath: '' }
    const doc = importLitegraph({ nodes: [{ id: 1, type: 'Painter', widgets_values: [initial] }], links: [] }, () => schema).document!
    const app = createWorkflowApp([schema])
    expect(app.openDocument(doc, 'Painter reader')).toEqual([])
    const tab = app.activeTab()!
    const context = { clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    let finish!: () => void
    const bitmap = { width: 13, height: 7, close: vi.fn() }
    const decode = vi.fn(() => new Promise<typeof bitmap>((resolve) => { finish = () => resolve(bitmap) }))
    vi.stubGlobal('createImageBitmap', decode)
    const fetch = vi.spyOn(app.connection, 'fetchAssetBytes').mockResolvedValue(new Uint8Array([1]).buffer)
    let acknowledge!: () => void
    let requested: RetainedAssets | undefined
    vi.mocked(app.connection.retainAssets).mockImplementationOnce((owner, declaration) => {
      requested = { ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 }
      return new Promise<RetainedAssets>((resolve) => { acknowledge = () => resolve(requested!) })
    })
    vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <WidgetEditor app={app} ed={{
      tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'mask' }, label: 'Mask',
      spec: inputsOf(schema)[0]!.widget, declaredType: inputsOf(schema)[0]!.type,
      multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial,
    }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
    try {
      await vi.waitFor(() => expect(requested).toBeDefined())
      expect(requested!.digests).toEqual([initial.digest])
      expect(fetch).not.toHaveBeenCalled()
      expect(decode).not.toHaveBeenCalled()
      if (scenario === 'closed-before') dispose()
      acknowledge()
      if (scenario === 'refused' || scenario === 'closed-before') {
        if (scenario === 'refused') await vi.waitFor(() => expect(root.querySelector('[role="alert"][data-tone="error"]')?.textContent).toContain('acknowledgment differs'))
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        expect(fetch).not.toHaveBeenCalled()
        expect(decode).not.toHaveBeenCalled()
        return
      }
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
      if (scenario === 'closed-decode') dispose()
      if (scenario === 'edited') expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n1', inputId: 'mask', value: { ...initial, digest: `blake3:${'b'.repeat(64)}` },
      } })).ok).toBe(true)
      if (scenario === 'disconnected') {
        vi.stubGlobal('WebSocket', class { close() {} })
        app.connection.connect(); app.connection.disconnect()
      }
      if (scenario === 'disposed') app.dispose()
      finish()
      await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
      expect(context.drawImage).toHaveBeenCalledTimes(scenario === 'live' ? 1 : 0)
      if (scenario === 'live') {
        expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 512, 512)
        expect(Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Apply')?.disabled).toBe(false)
      }
    } finally { finish?.(); dispose(); app.dispose() }
  },
)
