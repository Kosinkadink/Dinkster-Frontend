// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, asPromptId, DINKSTER_SCHEMA_WIRE_VERSION, EMPTY_COMPOSITOR_RECIPE, registerCatalog, setLocale, type DinksterNodesPayload, type Json } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, isCompositorEditorTarget } from '../src/app-state.js'
import { CompositorEditor } from '../src/CompositorEditor.js'
import { prepareWorkflowApp } from './fixtures/workflow-app.js'

const apps: AppState[] = []
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
          type: { kind: 'concrete', types: ['COMPOSITOR'] },
          default: EMPTY_COMPOSITOR_RECIPE,
          widget: { type: 'COMPOSITOR' },
        },
        { role: 'output', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } },
      ],
    },
  },
} as unknown as DinksterNodesPayload

async function mount(options: {
  readonly storedValue?: Json
  readonly previewState?: Readonly<Record<string, unknown>>
  readonly holdOwnership?: boolean
} = {}) {
  const app = prepareWorkflowApp(new AppState())
  apps.push(app)
  const tab = app.tabs.get()[0]!
  app.registry.set(buildDinksterRegistry(asConnectionId('local'), payload))
  const graphId = tab.store.doc.root
  const seedNodeIds = Object.keys(tab.store.doc.graphs[graphId]!.nodes)
  if (seedNodeIds.length > 0 && !(await app.dispatchTo(tab, {
    command: 'node.remove', params: { graphId, nodeIds: seedNodeIds },
  })).ok) throw new Error('failed to clear compositor fixture graph')
  const before = new Set(Object.keys(tab.store.doc.graphs[graphId]!.nodes))
  if (!(await app.dispatchTo(tab, {
    command: 'node.add', params: { graphId, type: 'Compositor', position: { x: 20, y: 30 } },
  })).ok) throw new Error('failed to add compositor fixture node')
  const nodeId = Object.keys(tab.store.doc.graphs[graphId]!.nodes).find((id) => !before.has(id))!
  if (options.storedValue !== undefined && !(await app.dispatchTo(tab, {
    command: 'node.setValue',
    params: { graphId, nodeId, inputId: 'recipe', value: options.storedValue },
  })).ok) throw new Error('failed to store compositor fixture recipe')
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
  let accept!: () => void
  let refuse!: () => void
  const acknowledgment = new Promise<void>((resolve, reject) => {
    accept = resolve
    refuse = () => reject(new Error('Editor ownership refused'))
  })
  if (options.holdOwnership) {
    vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
      await acknowledgment
      return { ...owner, ...declaration, revision: declaration.revision + 1 }
    })
    vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
  }
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <CompositorEditor app={app} />, root)
  if (!options.holdOwnership) await vi.waitFor(() => expect(root.querySelectorAll('.compositor-layer-row')).toHaveLength(2))
  return { app, tab, graphId, nodeId, root, dispose, accept, refuse }
}

afterEach(() => {
  for (const app of apps.splice(0)) app.dispose()
  vi.restoreAllMocks()
  setLocale('en')
  document.body.replaceChildren()
  localStorage.clear()
})

describe('CompositorEditor', () => {
  it.each(['accepted', 'refused'] as const)('waits for independent editor ownership: %s', async (mode) => {
    const resourceDigest = `blake3:${'b'.repeat(64)}`
    const unusedDigest = `blake3:${'c'.repeat(64)}`
    const mounted = await mount({ holdOwnership: true, previewState: { ...state, document: {
      ...imageDocument, allocation: { nextOrdinal: 5 },
      layers: { ...imageDocument.layers, l2: { ...imageDocument.layers.l2, visible: false } },
      resources: { ...imageDocument.resources,
        r3: { ...imageDocument.resources.r3, digest: resourceDigest },
        r4: { ...imageDocument.resources.r3, id: 'r4', digest: unusedDigest } },
    } } })
    try {
      await vi.waitFor(() => expect(mounted.app.connection.retainAssets).toHaveBeenCalledOnce())
      expect(vi.mocked(mounted.app.connection.retainAssets).mock.calls[0]![1])
        .toEqual({ revision: 0, complete: true, digests: [assetDigest, resourceDigest, unusedDigest] })
      expect(mounted.root.querySelectorAll('.compositor-layer-row')).toHaveLength(0)
      if (mode === 'refused') mounted.refuse()
      else mounted.accept()
      if (mode === 'accepted') {
        await vi.waitFor(() => expect(mounted.root.querySelectorAll('.compositor-layer-row')).toHaveLength(2))
      } else {
        await vi.waitFor(() => expect(mounted.root.textContent).toContain('Editor ownership refused'))
        expect(mounted.root.querySelectorAll('.compositor-layer-row')).toHaveLength(0)
      }
    } finally { mounted.dispose() }
  })

  it.each(['acknowledged', 'lost', 'refused', 'canceled', 'closed', 'registry', 'disconnected', 'disposed', 'out-of-order'] as const)(
    'retires only a published same-lifetime editor predecessor: %s', async (mode) => {
      const mounted = await mount()
      try {
        const { app, tab } = mounted
        const target = app.imageEditorTarget.get()!
        if (!isCompositorEditorTarget(target)) throw new Error('Expected compositor target')
        const backend = app.backendForTab(tab)
        const admitted = vi.mocked(app.connection.retainAssets).mock
        const index = admitted.calls.map((call, index) => ({ call, index })).reverse().find(({ call: [, declaration] }) => declaration.complete &&
          declaration.digests.length === 1 && declaration.digests[0] === assetDigest)!.index
        expect(index).toBeGreaterThanOrEqual(0)
        const previous = await admitted.results[index]!.value
        const independent = { ...previous, ownerId: 'independent-editor' }
        const owners = new Map([[previous.ownerId, previous], [independent.ownerId, independent]])
        const release = vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
          const current = owners.get(owner.ownerId)!
          expect(current.revision).toBe(revision)
          const released = { ...current, revision: revision + 1, complete: true, digests: [] }
          owners.set(owner.ownerId, released)
          return released
        })
        vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
        let acknowledge!: () => void
        const pending = new Promise<void>((resolve) => { acknowledge = resolve })
        let entered!: () => void
        const requested = new Promise<void>((resolve) => { entered = resolve })
        const retain = vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
          entered()
          await pending
          if (mode === 'refused') throw new Error('refused')
          const receipt = { ...owner, ...declaration, revision: 1 }
          owners.set(owner.ownerId, receipt)
          if (mode === 'lost') throw new Error('lost response')
          return receipt
        })
        const nextDigest = `blake3:${'d'.repeat(64)}`
        const publish = vi.fn(() => mode !== 'canceled')
        const operation = app.retainEditorAssets(target, backend, { ...state, documentDigest: nextDigest }, publish)
          .then(() => true, () => false)
        await requested
        expect(owners.get(previous.ownerId)).toEqual(previous)
        expect(publish).not.toHaveBeenCalled()
        expect(release).not.toHaveBeenCalled()
        if (mode === 'closed') app.closeImageEditor(target)
        if (mode === 'registry') backend.registry.set(undefined)
        if (mode === 'disconnected') {
          vi.stubGlobal('WebSocket', class { close() {} })
          try { backend.connection.connect(); backend.connection.disconnect() } finally { vi.unstubAllGlobals() }
        }
        if (mode === 'disposed') app.dispose()
        if (mode === 'out-of-order') {
          retain.mockImplementation(async (owner, declaration) => {
            const receipt = { ...owner, ...declaration, revision: 1 }
            owners.set(owner.ownerId, receipt)
            return receipt
          })
          await app.retainEditorAssets(target, backend, { ...state, documentDigest: `blake3:${'e'.repeat(64)}` }, () => true)
        }
        acknowledge()
        const succeeds = ['acknowledged', 'lost', 'canceled'].includes(mode)
        expect(await operation).toBe(succeeds)
        expect(publish).toHaveBeenCalledTimes(succeeds ? 1 : 0)
        const replaced = ['acknowledged', 'lost', 'out-of-order'].includes(mode)
        expect(release).toHaveBeenCalledTimes(replaced ? 1 : 0)
        expect(owners.get(previous.ownerId)?.digests).toEqual(replaced ? [] : previous.digests)
        expect(owners.get(independent.ownerId)).toEqual(independent)
        for (const [id, owner] of owners) if (id !== previous.ownerId) expect(owner.revision).toBe(1)
        mounted.dispose()
        expect(release).toHaveBeenCalledTimes(replaced ? 1 : 0)
      } finally { mounted.dispose() }
    },
  )

  it('refuses malformed editor resources without claiming a complete empty inventory', async () => {
    const mounted = await mount()
    try {
      const target = mounted.app.imageEditorTarget.get()!
      if (!isCompositorEditorTarget(target)) throw new Error('Expected compositor target')
      const retain = vi.mocked(mounted.app.connection.retainAssets)
      retain.mockClear()
      const publish = vi.fn(() => true)
      await expect(mounted.app.retainEditorAssets(target, mounted.app.backendForTab(mounted.tab), {
        ...state, document: { ...imageDocument, resources: { ...imageDocument.resources,
          r3: { ...imageDocument.resources.r3, digest: 'invalid' } } },
      }, publish)).rejects.toThrow('Editor resource inventory is invalid')
      expect(retain).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    } finally { mounted.dispose() }
  })

  it('edits layer order and properties, then commits one exact atomic recipe', async () => {
    const mounted = await mount()
    expect(mounted.root.querySelectorAll('.compositor-layer-row')).toHaveLength(2)
    expect([...mounted.root.querySelectorAll<HTMLInputElement>('input')].some((input) => input.value === '320')).toBe(true)
    expect(mounted.root.textContent).toContain('Overlay')

    const name = [...mounted.root.querySelectorAll<HTMLInputElement>('.compositor-properties input')]
      .find((input) => input.value === 'Overlay')!
    name.value = 'Watermark'
    name.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const x = mounted.root.querySelector<HTMLInputElement>('[role="spinbutton"][aria-label="X"]')!
    x.value = '12.5'
    x.dispatchEvent(new InputEvent('input', { bubbles: true }))
    mounted.root.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Visible"]')!.click()
    const opacity = mounted.root.querySelector<HTMLElement>('[role="slider"][aria-label="Opacity"]')!
    opacity.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    for (let i = 0; i < 25; i++) opacity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    mounted.root.querySelector<HTMLButtonElement>('[role="combobox"]')!.click()
    document.querySelector<HTMLElement>('[role="option"][data-option-id="multiply"]')!.click()
    const lower = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Lower')!
    lower.click()
    const revision = mounted.tab.store.revision
    const apply = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Apply')!
    apply.click()

    await vi.waitFor(() => expect(mounted.tab.store.revision).toBe(revision + 1))
    const value = mounted.tab.store.doc.graphs[mounted.graphId]!.nodes[mounted.nodeId]!.values['recipe'] as {
      version: number; documentDigest: string; commands: Json[]
    }
    expect(value.version).toBe(2)
    expect(value.documentDigest).toBe(assetDigest)
    expect(value.commands).toContainEqual({
      op: 'layer', id: 'l2',
      changes: { name: 'Watermark', visible: false, opacity: 16_384, blendMode: 'multiply' },
    })
    expect(value.commands).toContainEqual({ op: 'transform', id: 'l2', components: {
      x: 12.5, y: 30, width: 80, height: 60, rotation: 0,
      flipHorizontal: false, flipVertical: false, sourceWidth: 80, sourceHeight: 60,
    } })
    expect(value.commands.at(-1)).toEqual({ op: 'reorder', ids: ['l2', 'l0'] })
    await vi.waitFor(() => expect(mounted.app.imageEditorTarget.get()).toBeUndefined())
    mounted.dispose()
    mounted.app.dispose()
  })

  it.each([false, true])('waits for compositor result %s before closing and prevents duplicate apply', async (accepted) => {
    const mounted = await mount()
    const request = mounted.app.imageEditorTarget.get()
    const dispatch = mounted.app.dispatchTo.bind(mounted.app)
    let settle!: () => void
    const pending = vi.spyOn(mounted.app, 'dispatchTo').mockImplementation((tab, invocation) =>
      new Promise((resolve) => { settle = () => resolve(accepted ? dispatch(tab, invocation) : { ok: false, diagnostics: [] }) }) as never)
    const apply = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Apply')!
    apply.click()
    expect(apply.disabled).toBe(true)
    expect(mounted.app.imageEditorTarget.get()).toBe(request)
    apply.click()
    expect(pending).toHaveBeenCalledOnce()
    settle()
    await vi.waitFor(() => accepted
      ? expect(mounted.app.imageEditorTarget.get()).toBeUndefined()
      : expect(mounted.root.querySelector('[role="alert"]')).not.toBeNull())
    if (!accepted) {
      expect(mounted.app.imageEditorTarget.get()).toBe(request)
      expect(apply.disabled).toBe(false)
    }
    mounted.dispose()
    mounted.app.dispose()
  })

  it('keeps a replacement compositor free of an old apply refusal', async () => {
    const mounted = await mount()
    let settle!: () => void
    vi.spyOn(mounted.app, 'dispatchTo').mockImplementation(() => new Promise((resolve) => {
      settle = () => resolve({ ok: false, diagnostics: [] })
    }) as never)
    const apply = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Apply')!
    apply.click()
    const replacement = { ...mounted.app.imageEditorTarget.get()! }
    mounted.app.imageEditorTarget.set(replacement)
    settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(mounted.app.imageEditorTarget.get()).toBe(replacement)
    expect(mounted.root.querySelector('[role="alert"]')).toBeNull()
    mounted.dispose()
    mounted.app.dispose()
  })

  it('refuses an apply after the stored recipe changes concurrently', async () => {
    const mounted = await mount()
    const recipe = { version: 2, documentDigest: assetDigest, commands: [{ op: 'layer', id: 'l0', changes: { visible: false } }] }
    expect((await mounted.app.dispatchTo(mounted.tab, {
      command: 'node.setValue',
      params: { graphId: mounted.graphId, nodeId: mounted.nodeId, inputId: 'recipe', value: recipe },
    })).ok).toBe(true)
    const apply = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Apply')!
    apply.click()
    expect(apply.disabled).toBe(true)
    expect(mounted.root.querySelector('[role="alert"]')).toBeNull()
    expect(mounted.app.imageEditorTarget.get()).toBeDefined()
    mounted.dispose()
    mounted.app.dispose()
  })

  it('uses the runtime document when the stored delta is stale', async () => {
    const saved = { version: 2, documentDigest: `blake3:${'b'.repeat(64)}`, commands: [] }
    const mounted = await mount({ storedValue: saved, previewState: { ...state, stale: true } })
    expect(mounted.root.textContent).toContain('Overlay')
    mounted.dispose()
    mounted.app.dispose()
  })

  it('updates mounted host text when the locale changes and preserves catalog fallback', async () => {
    registerCatalog('de-DE', { 'compositor.layers.title': 'Ebenen' })
    const mounted = await mount()
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
