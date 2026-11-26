import { render } from 'solid-js/web'
import { createSignal as createSolidSignal } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { createWidgetRegistry } from '@dinkster/widgets'
import { asLinkId, asNodeId, asPortId, coreCommandRegistry, createSignal, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema, type CompileArtifact, type Json } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor, type WidgetEditorProps, type WidgetEditorState } from '../src/WidgetEditor.js'
import { SaveTargetSpace } from '../src/InNodeEditorSpaces.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps mount recovery and declared-default reset inside the Save target editor without changing a wired target', async () => {
  const root = document.createElement('div'); document.body.append(root)
  const [wired, setWired] = createSolidSignal(false)
  const commit = vi.fn(async () => true)
  const dispose = render(() => <SaveTargetSpace value={{ mount: 'usb1', prefix: 'shots/shot_042' }} wired={wired()}
    declared={{ prefix: 'ComfyUI' }} help="Relative name only"
    fetchMounts={async () => ({ activeOutputMount: 'output', mountChangesAllowed: false,
      mounts: [{ id: 'output', mode: 'readwrite', state: 'ready' }] })}
    commit={commit} queue={() => {}} />, root)
  const button = (label: string) => [...root.querySelectorAll('button')].find((entry) => entry.textContent === label)
  try {
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')?.textContent).toContain('usb1 is not on this machine. Saving to output.'))
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Use project default')
    expect(root.querySelector('.dinkster-canvas-target-name')?.getAttribute('title')).toBe('Relative name only')
    button('Use project default')!.focus()
    const recoverKey = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    button('Use project default')!.dispatchEvent(recoverKey)
    expect(recoverKey.defaultPrevented).toBe(false)
    button('Use project default')!.click()
    expect(root.querySelector('[role="status"]')).toBeNull()
    expect(root.querySelector('input')!.value).toBe('shots/shot_042')
    expect(document.activeElement).toBe(root.querySelector('input'))
    expect(commit).not.toHaveBeenCalled()
    expect(button('Reset to default')).toBeDefined()
    button('Reset to default')!.focus()
    const resetKey = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    button('Reset to default')!.dispatchEvent(resetKey)
    expect(resetKey.defaultPrevented).toBe(false)
    button('Reset to default')!.click()
    expect(root.querySelector('input')!.value).toBe('ComfyUI')
    expect(button('Reset to default')).toBeUndefined()
    expect(document.activeElement).toBe(root.querySelector('input'))
    expect(commit).not.toHaveBeenCalled()
    setWired(true)
    expect(button('Use project default')).toBeUndefined()
    expect(button('Reset to default')).toBeUndefined()
    expect(root.querySelector('input')!.readOnly).toBe(true)
  } finally { dispose() }
})

it('selects the save name on opening and queues the atomically stored target only after commit succeeds', async () => {
  const root = document.createElement('div'); document.body.append(root)
  let saved: Json = { mount: 'output', prefix: 'before' }
  const queued: Json[] = []
  let finish!: (ok: boolean) => void
  const [wired, setWired] = createSolidSignal(false)
  const dispose = render(() => <SaveTargetSpace value={saved} wired={wired()}
    fetchMounts={async () => ({ activeOutputMount: 'output', mountChangesAllowed: false, mounts: [
      { id: 'output', mode: 'readwrite', state: 'ready' }, { id: 'archive', mode: 'readwrite', state: 'ready' },
    ] })}
    commit={async (value) => {
      const ok = await new Promise<boolean>((resolve) => { finish = resolve })
      if (ok) saved = value
      return ok
    }} queue={() => queued.push(saved)} />, root)
  try {
    const name = root.querySelector('input')!
    const mount = root.querySelector('button')!
    await vi.waitFor(() => expect(document.activeElement).toBe(name))
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 6])
    await vi.waitFor(() => expect(mount.textContent).toContain('output'))
    mount.focus()
    mount.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(root.querySelector('[role="listbox"]')).not.toBeNull()
    Array.from(root.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'archive')!.click()
    name.focus()
    name.value = 'after'; name.dispatchEvent(new Event('input', { bubbles: true }))
    expect(saved).toEqual({ mount: 'output', prefix: 'before' })
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    expect(queued).toEqual([])
    finish(true)
    await vi.waitFor(() => expect(queued).toEqual([{ mount: 'archive', prefix: 'after' }]))
    name.value = 'refused'; name.dispatchEvent(new Event('input', { bubbles: true }))
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    finish(false)
    await Promise.resolve(); await Promise.resolve()
    expect(queued).toEqual([{ mount: 'archive', prefix: 'after' }])
    setWired(true)
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await Promise.resolve()
    expect(saved).toEqual({ mount: 'archive', prefix: 'after' })
    expect(queued).toHaveLength(1)
  } finally { dispose() }
})

it.each([false, true])('edits structured save destinations with writable grants and optional=%s', async (optional) => {
  const schema = parseDinksterSchema('SaveTargetFixture', { body: [
    { kind: 'input', id: 'target', type: { kind: 'concrete', types: ['dinkster.save_target'] }, required: !optional, widget: { type: 'SAVE_TARGET', suffix: '.pgm' } },
  ] }).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [] }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  const app = { widgetRegistry: registry, widgetRegistryForTab: () => registry,
    registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ protocol: 'dinkster', connection: { fetchMountSettings: async () => ({ outputMount: 'archive', mounts: [
      { id: 'archive', mode: 'readwrite', state: 'ready' },
      { id: 'reference', mode: 'read', state: 'ready' },
      { id: 'offline', mode: 'readwrite', state: 'missing' },
    ] }) } }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const open = () => render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'target' }, label: 'Destination',
    spec: inputsOf(schema)[0]!.widget, multiline: false, initial: store.doc.graphs.g0!.nodes.n1!.values.target ?? null,
    rect: { x: 0, y: 0, width: 180, height: 24 },
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  let dispose = open()
  await vi.waitFor(() => expect(root.querySelector('[role="combobox"]')!.textContent).toContain('archive'))
  ;(root.querySelector('[role="combobox"]') as HTMLButtonElement).click()
  expect(Array.from(document.querySelectorAll('[role="option"]')).map((entry) => entry.textContent)).toEqual(['archive'])
  ;(document.querySelector('[data-option-id="archive"]') as HTMLElement).click()
  const before = store.doc.graphs.g0!.nodes.n1!.values
  const prefix = root.querySelector<HTMLInputElement>('#save-target-prefix')!
  expect(prefix.getAttribute('aria-labelledby')).toBeTruthy()
  expect(root.textContent).toContain('numbering and .pgm')
  const apply = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Apply destination')!
  for (const value of ['', '/absolute', 'a//b', '.', 'a/../b', 'a/./b', 'a\\b', 'a/']) {
    prefix.value = value; prefix.dispatchEvent(new Event('input', { bubbles: true }))
    expect(apply.disabled, value).toBe(true)
  }
  prefix.value = 'nested/frame'; prefix.dispatchEvent(new Event('input', { bubbles: true }))
  expect(apply.disabled).toBe(false)
  expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual(before)
  apply.click()
  await vi.waitFor(() => expect(store.doc.graphs.g0!.nodes.n1!.values.target).toEqual({ mount: 'archive', prefix: 'nested/frame' }))
  expect(store.undo()).toBe(true)
  expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual(before)
  expect(Array.from(root.querySelectorAll('button')).some((button) => button.textContent === 'Clear destination')).toBe(optional)
  dispose()
  if (optional) {
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'target', value: { mount: 'archive', prefix: 'old' } } })
    dispose = open()
    Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Clear destination')!.click()
    await vi.waitFor(() => expect(store.doc.graphs.g0!.nodes.n1!.values.target).toBeNull())
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.values.target).toEqual({ mount: 'archive', prefix: 'old' })
    dispose()
  }
})

it.each([
  { node: 'dinkster.video.video_trim', id: 'trim', feature: 'trim', stored: { trim: { start_time: 2, duration: 3 } },
    shown: { 'video-trim-start-seconds': '2', 'video-trim-duration-seconds': '3' } },
  { node: 'dinkster.video.video_crop', id: 'crop', feature: 'crop', stored: { crop: { x: 16, y: 8, width: 320, height: 240 } },
    shown: { 'video-crop-x': '16', 'video-crop-y': '8', 'video-crop-width': '320', 'video-crop-height': '240' } },
])('opens $node at its stored value and closing unchanged writes nothing', async ({ node, id, feature, stored, shown }) => {
  // The rows these nodes declare: the edit is the input the widget sits on, and Trim writes a strict duration row.
  const schema = parseDinksterSchema(node, { body: [
    { kind: 'input', id: 'video', type: { kind: 'concrete', types: ['VIDEO'] } },
    { kind: 'input', id, type: { kind: 'concrete', types: ['VIDEO_EDIT'] }, default: {},
      widget: { type: 'VIDEO_EDIT', features: [feature], ...(feature === 'trim' ? { writes: { strict_duration: 'strict_duration' } } : {}) } },
    ...(feature === 'trim' ? [{ kind: 'input', id: 'strict_duration', type: { kind: 'concrete', types: ['BOOLEAN'] }, default: false }] : []),
  ] } as never).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [] }], links: [] }, () => schema).document!
  const store = new DocumentStore(imported, coreCommandRegistry())
  store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: id, value: stored } })
  const before = store.doc.graphs.g0!.nodes.n1!.values
  const revision = store.revision
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  const app = { widgetRegistry: registry, widgetRegistryForTab: () => registry,
    registryForTab: () => ({ resolve: () => schema }), executionForTab: () => undefined,
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const input = inputsOf(schema).find((row) => row.id === id)!
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', label: id, spec: input.widget, declaredType: input.type, multiline: false,
    target: { kind: 'input', nodeId: 'n1', valueKey: id, parts: { reads: {}, writes: input.widget!.writes ?? {} } },
    rect: { x: 0, y: 0, width: 180, height: 24 }, initial: stored,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  for (const [testId, value] of Object.entries(shown))
    expect(root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)?.value, testId).toBe(value)
  root.querySelector<HTMLButtonElement>('[data-testid="video-edit-apply"]')!.click()
  await Promise.resolve()
  expect(store.revision).toBe(revision)
  expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual(before)
  dispose()
})

it('bounds decoded crop previews and releases late results', async () => {
  const inputId = 'crop_region'
  const initial = { x: 0, y: 0, width: 12, height: 7 }
  const schema = parseDinksterSchema('PreviewFixture', { body: [
    { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] }, required: false },
    { kind: 'input', id: inputId, type: { kind: 'concrete', types: ['BOUNDING_BOX'] }, default: initial, widget: { type: 'BOUNDING_BOX' } },
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
    previews: {},
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
      tab, graphId: 'g0', label: 'Preview', target: { kind: 'input', nodeId: 'n1', valueKey: inputId,
        parts: { writes: {}, reads: { image: 'image' } } },
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
        expect([canvas.width, canvas.height]).toEqual([width, height])
      } else {
        await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
        expect(context.drawImage).not.toHaveBeenCalled()
        expect([canvas.width, canvas.height]).toEqual(originalSize)
      }
    } finally { finish?.(); dispose(); root.remove() }
    expect(bitmap.close).toHaveBeenCalledOnce()
  }
})

it('edits a crop region atomically, rejects invalid drafts and supports undo', async () => {
  const initial = { x: 3, y: 7, width: 91, height: 23 }
  const schema = parseDinksterSchema('CropFixture', { body: [
    { kind: 'input', id: 'crop_region', type: { kind: 'concrete', types: ['BOUNDING_BOX'] }, default: initial, widget: { type: 'BOUNDING_BOX', component: 'ImageCrop' } },
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
  const schema = parseDinksterSchema('SaveFixture', { body: [{ kind: 'row', rows: [
    { kind: 'input', id: 'filename_prefix', type: { kind: 'concrete', types: ['STRING'] }, default: 'frames/session' },
    { kind: 'input', id: 'mount', type: { kind: 'concrete', types: ['STRING'] }, required: false, default: null, widget: { type: 'MOUNT' } },
  ] }] }).schema!
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
