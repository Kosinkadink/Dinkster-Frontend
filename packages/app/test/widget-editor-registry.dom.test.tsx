import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { createWidgetRegistry } from '@dinkster/widgets'
import { asLinkId, asNodeId, asPortId, coreCommandRegistry, createSignal, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema, type CompileArtifact } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor, type WidgetEditorProps, type WidgetEditorState } from '../src/WidgetEditor.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['BOUNDING_BOX', 'IMAGECOMPARE'] as const)('bounds decoded %s previews and releases late results', async (kind) => {
  const inputId = kind === 'BOUNDING_BOX' ? 'crop_region' : 'compare_view'
  const initial = kind === 'BOUNDING_BOX' ? { x: 0, y: 0, width: 12, height: 7 } : null
  const schema = parseDinksterSchema('PreviewFixture', { interface: [
    { role: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] }, required: false },
    { role: 'input', id: inputId, type: { kind: 'concrete', types: [kind] }, default: initial, widget: { type: kind } },
  ] }).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [initial] }], links: [] }, () => schema).document!
  const graph = imported.graphs.g0!
  const store = new DocumentStore({ ...imported, graphs: { g0: { ...graph,
    nodes: { ...graph.nodes, source: { id: asNodeId('source'), type: 'Source', values: {} } },
    links: { image: { id: asLinkId('image'), from: { node: asNodeId('source'), port: asPortId('IMAGE') },
      to: { node: asNodeId('n1'), port: asPortId('image') } } },
  } } }, coreCommandRegistry())
  const tab = { store, graphStack: createSignal(['g0']), instancePath: createSignal([]) } as unknown as Tab
  const artifact = { snapshot: store.doc, connection: 'native', schemaHash: 'schema',
    prompt: { source: { class_type: 'Source', inputs: {} }, n1: { class_type: schema.type, inputs: {} } },
    provenance: { toSource: { source: 'source', n1: 'n1' }, fromSource: {} },
  } as unknown as CompileArtifact
  const execution = { key: 'preview', status: 'completed', ref: { connection: 'native', prompt: 'job' },
    artifact, nodes: {}, outputs: { source: {} },
    previews: { n1: { image_a: { channel: 'image/png', payload: new ArrayBuffer(1), timestamp: 1 } } },
  } as unknown as ExecutionState
  const registry = createWidgetRegistry()
  const backend = { id: 'native', protocol: 'dinkster', connection: { values: () => ({
    peek: async () => ({ available: true, descriptor: { typeId: 'IMAGE' }, renditions: [{ kind: 'png', mime: 'image/png', default: true }] }),
    read: async (_query: unknown, _descriptor: unknown, consume: () => Promise<void>) => consume(),
    rendition: async () => ({ available: true, mime: 'image/png', bytes: new ArrayBuffer(1) }),
  }) } }
  const app = { widgetRegistry: registry, widgetRegistryForTab: () => registry,
    store: { executions: createSignal(new Map()) }, executionForTab: () => execution,
    compileTabCached: () => ({ ok: true, artifact }), backendForTab: () => backend,
  } as unknown as AppState
  const context = { clearRect: vi.fn(), drawImage: vi.fn(), save() {}, restore() {}, beginPath() {}, rect() {}, fill() {}, strokeRect() {} }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  for (const [width, height, closed, accepted] of [
    [4096, 17, false, true], [13, 4096, false, true],
    [4097, 17, false, false], [13, 4097, false, false],
    [0, 17, false, false], [13, 0, false, false], [13, 7, true, false],
  ] as const) {
    context.drawImage.mockClear()
    const bitmap = { width, height, close: vi.fn() }
    let finish!: () => void
    const decode = vi.fn(() => new Promise<typeof bitmap>((resolve) => { finish = () => resolve(bitmap) }))
    vi.stubGlobal('createImageBitmap', decode)
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <WidgetEditor app={app} ed={{
      tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: inputId }, label: 'Preview',
      spec: inputsOf(schema)[1]!.widget, multiline: false, initial,
      rect: { x: 0, y: 0, width: 180, height: 24 },
    }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
    try {
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
      const canvas = root.querySelector('canvas')!
      const originalSize = [canvas.width, canvas.height]
      if (closed) dispose()
      finish()
      if (accepted) {
        await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalled())
        expect(bitmap.close).not.toHaveBeenCalled()
        if (kind === 'BOUNDING_BOX') expect([canvas.width, canvas.height]).toEqual([width, height])
      } else {
        await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
        expect(context.drawImage).not.toHaveBeenCalled()
        expect([canvas.width, canvas.height]).toEqual(originalSize)
      }
    } finally { finish?.(); dispose(); root.remove() }
    expect(bitmap.close).toHaveBeenCalledOnce()
  }
})

it('opens an empty comparison with named disabled controls without changing the graph value', () => {
  const schema = parseDinksterSchema('CompareFixture', { interface: [
    { role: 'input', id: 'compare_view', type: { kind: 'concrete', types: ['IMAGECOMPARE'] }, default: null, widget: { type: 'IMAGECOMPARE' } },
  ] }).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [null] }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const tab = { store, graphStack: createSignal(['g0']), instancePath: createSignal([]) } as unknown as Tab
  const registry = createWidgetRegistry()
  const app = {
    widgetRegistry: registry, widgetRegistryForTab: () => registry,
    store: { executions: createSignal(new Map()) }, executionForTab: () => undefined,
    compileTabCached: () => undefined, backendForTab: () => ({ id: 'native' }),
  } as unknown as AppState
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'compare_view' }, label: 'Compare',
    spec: inputsOf(schema)[0]!.widget, multiline: false,
    rect: { x: 0, y: 0, width: 180, height: 24 }, initial: null,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  expect(root.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Compare images')
  expect(root.querySelector('[role="slider"]')?.getAttribute('aria-disabled')).toBe('true')
  expect(Array.from(root.querySelectorAll<HTMLButtonElement>('[role="combobox"]')).map((control) => [control.getAttribute('aria-label'), control.disabled]))
    .toEqual([['Image A frame', true], ['Image B frame', true]])
  expect(root.textContent).toContain('Run this comparison')
  expect(store.doc.graphs.g0!.nodes.n1!.values.compare_view).toBeNull()
  dispose()
  context.mockRestore()
})

it('edits a crop region atomically, rejects invalid drafts and supports undo', async () => {
  const initial = { x: 3, y: 7, width: 91, height: 23 }
  const schema = parseDinksterSchema('CropFixture', { interface: [
    { role: 'input', id: 'crop_region', type: { kind: 'concrete', types: ['BOUNDING_BOX'] }, default: initial, widget: { type: 'BOUNDING_BOX', component: 'ImageCrop' } },
  ] }).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [initial] }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  const app = {
    widgetRegistry: registry, widgetRegistryForTab: () => registry,
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'crop_region' }, label: 'Crop region',
    spec: inputsOf(schema)[0]!.widget, multiline: false,
    rect: { x: 0, y: 0, width: 180, height: 24 }, initial,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  const input = (field: string, value: string) => {
    const control = root.querySelector<HTMLInputElement>(`#bounding-box-${field}`)!
    expect(control.getAttribute('aria-labelledby')).toBeTruthy()
    control.value = value
    control.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const apply = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Apply crop')!
  input('width', '')
  expect(apply.disabled).toBe(true)
  input('width', '12.5')
  expect(apply.disabled).toBe(true)
  input('width', '12')
  input('height', '5')
  input('x', '17')
  expect(store.doc.graphs.g0!.nodes.n1!.values.crop_region).toEqual(initial)
  apply.click()
  await vi.waitFor(() => expect(store.doc.graphs.g0!.nodes.n1!.values.crop_region).toEqual({ x: 17, y: 7, width: 12, height: 5 }))
  expect(store.undo()).toBe(true)
  expect(store.doc.graphs.g0!.nodes.n1!.values.crop_region).toEqual(initial)
  dispose()
})

it('edits only the schema-backed mount string, preserving prefix and undoable default selection', async () => {
  const schema = parseDinksterSchema('SaveFixture', { interface: [
    { role: 'input', id: 'filename_prefix', type: { kind: 'concrete', types: ['STRING'] }, default: 'frames/session' },
    { role: 'input', id: 'mount', type: { kind: 'concrete', types: ['STRING'] }, required: false, default: null, widget: { type: 'MOUNT' }, adjacentTo: 'filename_prefix' },
  ] }).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: ['frames/session', null] }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  const app = {
    widgetRegistry: registry,
    widgetRegistryForTab: () => registry,
    backendForTab: () => ({ protocol: 'dinkster', connection: { fetchMountSettings: async () => ({ mounts: [
      { id: 'archive', mode: 'readwrite', state: 'ready' },
      { id: 'reference', mode: 'read', state: 'ready' },
      { id: 'offline', mode: 'readwrite', state: 'missing' },
    ] }) } }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div')
  document.body.append(root)
  const open = () => render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'mount' }, label: 'Mount',
    spec: inputsOf(schema)[1]!.widget, declaredType: inputsOf(schema)[1]!.type,
    multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial: store.doc.graphs.g0!.nodes.n1!.values.mount,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  let dispose = open()
  await Promise.resolve(); await Promise.resolve()
  const choice = root.querySelector<HTMLButtonElement>('[data-testid="mount-widget-choice"]')!
  expect(choice.textContent).toContain('Default output mount')
  choice.click()
  expect(Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toEqual(['Default output mount', 'archive'])
  ;(document.querySelector('[data-option-id="archive"]') as HTMLElement).click()
  expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual({ filename_prefix: 'frames/session', mount: null })
  root.querySelector<HTMLButtonElement>('[data-testid="mount-widget-apply"]')!.click()
  expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual({ filename_prefix: 'frames/session', mount: 'archive' })
  expect(Object.keys(store.doc.graphs.g0!.nodes)).toEqual(['n1'])
  dispose()
  dispose = open()
  await Promise.resolve(); await Promise.resolve()
  root.querySelector<HTMLButtonElement>('[data-testid="mount-widget-choice"]')!.click()
  ;(document.querySelector('[data-option-id=""]') as HTMLElement).click()
  root.querySelector<HTMLButtonElement>('[data-testid="mount-widget-apply"]')!.click()
  expect(store.doc.graphs.g0!.nodes.n1!.values.mount).toBeNull()
  expect(store.undo()).toBe(true)
  expect(store.doc.graphs.g0!.nodes.n1!.values.mount).toBe('archive')
  expect(store.doc.graphs.g0!.nodes.n1!.values.filename_prefix).toBe('frames/session')
  dispose()
})

it('renders an editor registered at runtime for a new widget type', () => {
  const registry = createWidgetRegistry()
  const RuntimeEditor = (props: WidgetEditorProps) => (
    <div data-testid="runtime-widget-editor">Editing {props.ed.label}</div>
  )
  expect(registry.editorFor('pack.TIMELINE')).toBeUndefined()
  registry.registerEditor('pack.TIMELINE', RuntimeEditor)

  const tab = {} as Tab
  const app = {
    widgetRegistry: registry,
    widgetRegistryForTab: () => registry,
  } as unknown as AppState
  const ed: WidgetEditorState = {
    tab,
    graphId: 'g0',
    target: { kind: 'input', nodeId: 'n0', valueKey: 'timeline' },
    label: 'Timeline',
    spec: { widgetType: 'pack.TIMELINE', options: {} },
    multiline: false,
    rect: { x: 0, y: 0, width: 100, height: 24 },
    initial: null,
  }

  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => (
    <WidgetEditor
      app={app}
      ed={ed}
      viewport={() => ({ x: 0, y: 0, scale: 1 })}
      onClose={() => {}}
    />
  ), root)

  expect(root.querySelector('[data-testid="runtime-widget-editor"]')?.textContent).toBe('Editing Timeline')
  unmount()
})
