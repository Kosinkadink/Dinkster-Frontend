import { coreCommandRegistry, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema } from '@dinkster/core'
import { createWidgetRegistry } from '@dinkster/widgets'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor } from '../src/WidgetEditor.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
