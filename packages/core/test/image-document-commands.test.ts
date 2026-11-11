import { describe, expect, it, vi } from 'vitest'
import {
  IMAGE_DOCUMENT_FORMAT_VERSION,
  IMAGE_FIXED_POINT_SCALE,
  IMAGE_OPACITY_MAX,
  ImageDocumentStore,
  asImageLayerId,
  asImageLineageId,
  asImageResourceId,
  createLocalImageDocumentSession,
  orderedImageLayerIds,
  type ImageDocument,
  type ImageRasterInput,
} from '../src/index.js'

const DIGEST_A = `blake3:${'a'.repeat(64)}` as const
const DIGEST_B = `blake3:${'b'.repeat(64)}` as const
const DIGEST_C = `blake3:${'c'.repeat(64)}` as const

const identity = () => ({
  a: IMAGE_FIXED_POINT_SCALE,
  b: 0,
  c: 0,
  d: IMAGE_FIXED_POINT_SCALE,
  tx: 0,
  ty: 0,
})

function document(): ImageDocument {
  return {
    format: 'dinkster-image',
    formatVersion: IMAGE_DOCUMENT_FORMAT_VERSION,
    lineage: asImageLineageId('image-command-test'),
    canvas: {
      width: 8,
      height: 6,
      colorSpace: 'srgb',
      channelDepth: 8,
      compositing: 'premultiplied-alpha',
    },
    allocation: { nextOrdinal: 2 },
    rootLayerIds: [asImageLayerId('l1')],
    layers: {
      l1: {
        id: asImageLayerId('l1'),
        kind: 'raster',
        name: 'Pixels',
        visible: true,
        opacity: IMAGE_OPACITY_MAX,
        transform: identity(),
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [],
        resourceId: asImageResourceId('r0'),
        sourceRect: { x: 0, y: 0, width: 8, height: 6 },
      },
    },
    masks: {},
    resources: {
      r0: {
        id: asImageResourceId('r0'),
        kind: 'raster',
        digest: DIGEST_A,
        byteSize: 192,
        mediaType: 'image/png',
        width: 8,
        height: 6,
        colorSpace: 'srgb',
        channelDepth: 8,
        alphaMode: 'straight',
      },
    },
  }
}

function resource(digest: typeof DIGEST_B | typeof DIGEST_C): ImageRasterInput {
  return {
    kind: 'raster',
    digest,
    byteSize: 96,
    mediaType: 'image/png',
    width: 4,
    height: 6,
    colorSpace: 'srgb',
    channelDepth: 8,
    alphaMode: 'straight',
  }
}

const addLayer = (digest: typeof DIGEST_B | typeof DIGEST_C = DIGEST_B) => ({
  command: 'image.layer.addRaster' as const,
  params: {
    parentId: null,
    index: 1,
    name: 'Added pixels',
    resource: resource(digest),
    sourceRect: { x: 0, y: 0, width: 4, height: 6 },
  },
})

describe('ImageDocument commands', () => {
  it('preserves v2 color, isolation, z order and blend edits in the same history', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch({ command: 'image.canvas.update', params: {
      width: 8, height: 6, compositing: 'linear-premultiplied-alpha',
    } }).ok).toBe(true)
    expect(store.doc.canvas.compositing).toBe('linear-premultiplied-alpha')
    expect(store.undo()).toBe(true)
    expect(store.doc.canvas.compositing).toBe('premultiplied-alpha')
    expect(store.dispatch({ command: 'image.layer.group', params: { layerIds: ['l1'], name: 'Group' } }).ok).toBe(true)
    expect(store.dispatch({ command: 'image.layer.update', params: {
      layerId: 'l2', isolation: 'pass-through', z_index: -5, blendMode: 'color_dodge',
    } }).ok).toBe(true)
    expect(store.doc.layers['l2']).toMatchObject({ isolation: 'pass-through', z_index: -5, blendMode: 'color_dodge' })
    expect(store.undo()).toBe(true)
    expect(store.doc.layers['l2']).not.toHaveProperty('isolation')
    expect(store.redo()).toBe(true)
    expect(store.doc.layers['l2']).toMatchObject({ isolation: 'pass-through' })
    expect(store.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', isolation: 'isolated' } }).ok).toBe(false)
  })

  it('checks clipping against effective z order with stable array-order ties', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch(addLayer()).ok).toBe(true)
    expect(store.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', z_index: 2, clipping: 'clip-to-previous' } }).ok).toBe(true)
    expect(store.dispatch({ command: 'image.layer.update', params: { layerId: 'l3', z_index: 2 } }).ok).toBe(false)
    expect(store.doc.rootLayerIds).toEqual(['l1', 'l3'])
    expect(store.doc.resources).toHaveProperty('r0')
  })

  it('moves by effective order and restores explicit z indexes on undo', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch(addLayer()).ok).toBe(true)
    expect(store.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', z_index: 10 } }).ok).toBe(true)
    const before = store.doc
    expect(orderedImageLayerIds(before, before.rootLayerIds)).toEqual(['l3', 'l1'])
    expect(store.dispatch({ command: 'image.layer.move', params: { layerId: 'l1', parentId: null, index: 0 } }).ok).toBe(true)
    expect(orderedImageLayerIds(store.doc, store.doc.rootLayerIds)).toEqual(['l1', 'l3'])
    expect(store.doc.layers['l1']!.z_index).toBe(0)
    expect(store.doc.layers['l3']!.z_index).toBe(1)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(orderedImageLayerIds(store.doc, store.doc.rootLayerIds)).toEqual(['l1', 'l3'])
  })

  it('keeps mixed explicit and implicit z order when grouping later siblings', () => {
    const store = new ImageDocumentStore(document())
    for (let index = 0; index < 3; index++) expect(store.dispatch(addLayer()).ok).toBe(true)
    expect(store.doc.rootLayerIds).toEqual(['l1', 'l7', 'l5', 'l3'])
    expect(store.dispatch({ command: 'image.layer.update', params: { layerId: 'l5', z_index: 2 } }).ok).toBe(true)
    const before = store.doc
    const grouped = store.dispatch({ command: 'image.layer.group', params: { layerIds: ['l5', 'l3'], name: 'Group' } })
    expect(grouped.ok).toBe(true)
    const group = store.doc.layers['l8']!
    if (group.kind !== 'group') throw new Error('expected group')
    expect(orderedImageLayerIds(store.doc, group.childLayerIds)).toEqual(['l5', 'l3'])
    expect(store.doc.layers['l5']!.z_index).toBe(0)
    expect(store.doc.layers['l3']!.z_index).toBe(1)
    expect(store.undo()).toBe(true)
    expect(store.doc.layers).toEqual(before.layers)
    expect(store.doc.rootLayerIds).toEqual(before.rootLayerIds)
  })

  it('groups adjacent siblings in document order without moving or duplicating resources', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch(addLayer()).ok).toBe(true)
    const before = store.doc
    const grouped = store.dispatch({ command: 'image.layer.group', params: { layerIds: ['l3', 'l1'], name: 'Group' } })
    expect(grouped.ok).toBe(true)
    expect(store.doc.rootLayerIds).toEqual(['l4'])
    expect(store.doc.layers['l4']).toMatchObject({ kind: 'group', childLayerIds: ['l1', 'l3'] })
    expect(store.doc.resources).toEqual(before.resources)
    expect(store.undo()).toBe(true)
    expect(store.doc.layers).toEqual(before.layers)
    expect(store.doc.rootLayerIds).toEqual(before.rootLayerIds)
    expect(store.doc.allocation.nextOrdinal).toBe(5)
    expect(store.redo()).toBe(true)
    expect(store.doc.rootLayerIds).toEqual(['l4'])
  })

  it('rejects duplicate, missing, and nonadjacent group members atomically', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch(addLayer()).ok).toBe(true)
    expect(store.dispatch(addLayer(DIGEST_C)).ok).toBe(true)
    for (const layerIds of [[], ['l1', 'l1'], ['missing'], ['l1', 'l3']]) {
      const before = store.doc
      expect(store.dispatch({ command: 'image.layer.group', params: { layerIds, name: 'Group' } }).ok).toBe(false)
      expect(store.doc).toBe(before)
    }
  })

  it('resizes the canvas without changing source assets and preserves clipping in history', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch({ command: 'image.canvas.update', params: { width: 100, height: 80 } }).ok).toBe(true)
    expect(store.doc.canvas).toMatchObject({ width: 100, height: 80 })
    expect(store.doc.resources).toEqual(document().resources)
    expect(store.dispatch({ command: 'image.canvas.update', params: { width: 16_385, height: 80 } }).ok).toBe(false)
    expect(store.dispatch(addLayer()).ok).toBe(true)
    expect(store.dispatch({ command: 'image.layer.update', params: { layerId: 'l3', clipping: 'clip-to-previous' } }).ok).toBe(true)
    expect(store.doc.layers['l3']!.clipping).toBe('clip-to-previous')
    expect(store.undo()).toBe(true)
    expect(store.doc.layers['l3']!.clipping).toBe('none')
  })

  it('crops the canvas by translating root composition without changing raster resources', () => {
    const initial = document()
    const store = new ImageDocumentStore(initial)
    expect(store.dispatch({
      command: 'image.canvas.crop', params: { x: 2, y: 1, width: 5, height: 4 },
    }).ok).toBe(true)
    expect(store.doc.canvas).toMatchObject({ width: 5, height: 4 })
    expect(store.doc.layers['l1']!.transform).toEqual({ ...identity(), tx: -2_000_000, ty: -1_000_000 })
    expect(store.doc.resources).toEqual(initial.resources)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(initial)
    for (const params of [
      { x: -1, y: 0, width: 5, height: 4 },
      { x: 4, y: 0, width: 5, height: 4 },
      { x: 0, y: 0, width: 0, height: 4 },
      { x: 0.5, y: 0, width: 5, height: 4 },
    ]) {
      expect(store.dispatch({ command: 'image.canvas.crop', params }).ok).toBe(false)
      expect(store.doc).toEqual(initial)
    }
  })

  it('resizes root composition with ties-to-even fixed-point scaling', () => {
    const initial = document()
    const store = new ImageDocumentStore({
      ...initial,
      layers: { l1: { ...initial.layers['l1']!, transform: {
        a: 1, b: 1, c: -1, d: 3, tx: 1, ty: -1,
        components: {
          x: 0, y: 0, width: 8, height: 6, rotation: 0,
          flipHorizontal: false, flipVertical: false, sourceWidth: 8, sourceHeight: 6,
        },
      } } },
    })
    expect(store.dispatch({ command: 'image.canvas.resize', params: { width: 4, height: 3 } }).ok).toBe(true)
    expect(store.doc.canvas).toMatchObject({ width: 4, height: 3 })
    expect(store.doc.layers['l1']!.transform).toEqual({ a: 0, b: 0, c: 0, d: 2, tx: 0, ty: 0 })
    expect(store.doc.resources).toEqual(initial.resources)
    expect(store.dispatch({ command: 'image.canvas.resize', params: { width: 16_385, height: 3 } }).ok).toBe(false)
  })

  it('stores output policy as non-rendering metadata with atomic history', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch({ command: 'image.output.update', params: { format: 'jpeg', quality: 73 } }).ok).toBe(true)
    expect(store.doc.extensions).toEqual({ 'dinkster.outputPolicy': { format: 'jpeg', quality: 73 } })
    expect(store.undo()).toBe(true)
    expect(store.doc.extensions).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.dispatch({ command: 'image.output.update', params: { format: 'gif', quality: 73 } }).ok).toBe(false)
    expect(store.dispatch({ command: 'image.output.update', params: { format: 'webp', quality: 101 } }).ok).toBe(false)
  })

  it('updates raster rendering properties atomically', () => {
    const store = new ImageDocumentStore(document())
    const result = store.dispatch({
      command: 'image.layer.update',
      params: {
        layerId: 'l1',
        name: 'Foreground',
        opacity: 32_768,
        blendMode: 'multiply',
        transform: { ...identity(), tx: 2_000_000, ty: -1_000_000 },
      },
    })
    expect(result.ok).toBe(true)
    expect(store.doc.layers['l1']).toMatchObject({
      name: 'Foreground',
      opacity: 32_768,
      blendMode: 'multiply',
      transform: { tx: 2_000_000, ty: -1_000_000 },
    })
    const before = store.doc
    expect(store.dispatch({
      command: 'image.layer.update',
      params: { layerId: 'l1', opacity: 0.5 },
    }).ok).toBe(false)
    expect(store.doc).toBe(before)
    expect(store.revision).toBe(1)
  })

  it('adds and moves raster layers with deterministic allocation', () => {
    const store = new ImageDocumentStore(document())
    const added = store.dispatch(addLayer())
    expect(added.ok && added.created).toEqual({ layerId: 'l3', resourceId: 'r2' })
    expect(store.doc.rootLayerIds).toEqual(['l1', 'l3'])
    expect(store.doc.layers['l3']).toMatchObject({ name: 'Added pixels', resourceId: 'r2' })
    expect(store.doc.resources['r2']?.digest).toBe(DIGEST_B)
    expect(store.doc.allocation.nextOrdinal).toBe(4)

    expect(store.dispatch({
      command: 'image.layer.move', params: { layerId: 'l3', parentId: null, index: 0 },
    }).ok).toBe(true)
    expect(store.doc.rootLayerIds).toEqual(['l3', 'l1'])
  })

  it('removes layer subtrees and only their unreferenced resources', () => {
    const initial = document()
    const shared = {
      ...initial,
      allocation: { nextOrdinal: 4 },
      rootLayerIds: [asImageLayerId('l1'), asImageLayerId('l3')],
      layers: {
        ...initial.layers,
        l3: {
          ...initial.layers['l1']!,
          id: asImageLayerId('l3'),
          name: 'Shared resource',
        },
      },
    }
    const store = new ImageDocumentStore(shared)
    expect(store.dispatch({ command: 'image.layer.remove', params: { layerId: 'l1' } }).ok).toBe(true)
    expect(store.doc.layers['l1']).toBeUndefined()
    expect(store.doc.resources['r0']).toBeDefined()
    expect(store.dispatch({ command: 'image.layer.remove', params: { layerId: 'l3' } }).ok).toBe(true)
    expect(store.doc.resources).toEqual({})
  })

  it('does not collect a pre-existing unreferenced resource during an unrelated removal', () => {
    const initial = document()
    const store = new ImageDocumentStore({
      ...initial,
      allocation: { nextOrdinal: 3 },
      resources: {
        ...initial.resources,
        r2: { ...resource(DIGEST_B), id: asImageResourceId('r2') },
      },
    })
    expect(store.dispatch({ command: 'image.layer.remove', params: { layerId: 'l1' } }).ok).toBe(true)
    expect(store.doc.resources).toEqual({
      r2: { ...resource(DIGEST_B), id: asImageResourceId('r2') },
    })
  })

  it('rejects moves that would create a layer cycle', () => {
    const initial = document()
    const grouped: ImageDocument = {
      ...initial,
      allocation: { nextOrdinal: 4 },
      rootLayerIds: [asImageLayerId('l3')],
      layers: {
        ...initial.layers,
        l3: {
          id: asImageLayerId('l3'),
          kind: 'group',
          name: 'Group',
          visible: true,
          opacity: IMAGE_OPACITY_MAX,
          transform: identity(),
          blendMode: 'normal',
          clipping: 'none',
          maskIds: [],
          childLayerIds: [asImageLayerId('l1')],
        },
      },
    }
    const store = new ImageDocumentStore(grouped)
    const before = store.doc
    const result = store.dispatch({
      command: 'image.layer.move', params: { layerId: 'l3', parentId: 'l3', index: 0 },
    })
    expect(result.ok).toBe(false)
    expect(store.doc).toBe(before)
  })

  it('adds, updates, and removes raster masks', () => {
    const store = new ImageDocumentStore(document())
    const added = store.dispatch({
      command: 'image.mask.addRaster',
      params: {
        ownerLayerId: 'l1',
        index: 0,
        resource: resource(DIGEST_B),
        sourceRect: { x: 0, y: 0, width: 4, height: 6 },
      },
    })
    expect(added.ok && added.created).toEqual({ maskId: 'm3', resourceId: 'r2' })
    expect(store.doc.layers['l1']?.maskIds).toEqual(['m3'])
    expect(store.dispatch({
      command: 'image.mask.update',
      params: { maskId: 'm3', invert: true, opacity: 1000, combineMode: 'subtract' },
    }).ok).toBe(true)
    expect(store.doc.masks['m3']).toMatchObject({ invert: true, opacity: 1000, combineMode: 'subtract' })
    expect(store.dispatch({ command: 'image.mask.remove', params: { maskId: 'm3' } }).ok).toBe(true)
    expect(store.doc.masks).toEqual({})
    expect(store.doc.resources['r2']).toBeUndefined()
  })

  it('owns invocation data and rejects unknown fields', () => {
    const store = new ImageDocumentStore(document())
    const transform = { ...identity(), tx: 1_000_000 }
    expect(store.dispatch({
      command: 'image.layer.update', params: { layerId: 'l1', transform },
    }).ok).toBe(true)
    transform.tx = 9_000_000
    expect(store.doc.layers['l1']?.transform.tx).toBe(1_000_000)
    expect(store.dispatch({
      command: 'image.layer.update', params: { layerId: 'l1', visible: false, unknown: true },
    }).ok).toBe(false)
    for (const layerId of ['__proto__', 'constructor', 'toString']) {
      expect(store.dispatch({
        command: 'image.layer.update', params: { layerId, visible: false },
      }).ok).toBe(false)
    }
  })
})

describe('ImageDocument history and session', () => {
  it.each(['dispatch', 'undo', 'redo'] as const)('keeps prepared %s invisible until admission and commit', async (kind) => {
    let allowed: ImageDocument | undefined
    const session = createLocalImageDocumentSession(document(), {
      validateCommit: (current, candidate) => current === candidate || candidate === allowed ? [] : [{
        severity: 'error', origin: 'command', code: 'image.admission.required', message: 'Owner not acknowledged',
      }],
    })
    const publishAdd = (): void => {
      const add = session.prepareDispatch(addLayer())
      expect(add.ok).toBe(true)
      if (!add.ok) return
      allowed = add.document
      expect(add.commit().ok).toBe(true)
    }
    if (kind !== 'dispatch') publishAdd()
    if (kind === 'redo') {
      const undo = session.prepareUndo()
      if (!undo.ok) throw new Error('Missing undo')
      allowed = undo.document
      expect(undo.commit().ok).toBe(true)
    }
    const before = session.doc
    const revision = session.revision
    const undo = session.canUndo
    const redo = session.canRedo
    const visible: ImageDocument[] = []
    const operations: unknown[] = []
    session.document.subscribe((value) => visible.push(value))
    session.onOp((value) => operations.push(value))
    const prepared = kind === 'dispatch' ? session.prepareDispatch(addLayer())
      : kind === 'undo' ? session.prepareUndo() : session.prepareRedo()
    if (!prepared.ok) throw new Error('Missing prepared edit')
    expect(prepared.currentResourceDigests).toEqual(kind === 'dispatch' ? [DIGEST_A] : [DIGEST_A, DIGEST_B])
    expect(prepared.resourceDigests).toEqual([DIGEST_A, DIGEST_B])
    let acknowledge!: () => void
    const admission = new Promise<void>((resolve) => { acknowledge = resolve })
    const pending = admission.then(() => { allowed = prepared.document; return prepared.commit() })
    await Promise.resolve()
    expect(session.doc).toBe(before)
    expect(session.document.get()).toBe(before)
    expect(session.revision).toBe(revision)
    expect([session.canUndo, session.canRedo]).toEqual([undo, redo])
    expect(visible).toEqual([])
    expect(operations).toEqual([])
    acknowledge()
    expect((await pending).ok).toBe(true)
    expect(session.doc).toBe(prepared.document)
    expect(session.revision).toBe(revision + 1)
    expect(visible).toEqual([prepared.document])
    expect(operations).toHaveLength(1)
    expect(prepared.commit().ok).toBe(false)
  })

  it.each(['dispatch', 'undo', 'redo'] as const)('refuses direct %s without mutating document or history', (kind) => {
    let admitted = true
    const policy = () => admitted ? [] : [{
      severity: 'error' as const, origin: 'command' as const,
      code: 'image.admission.refused', message: 'Owner refused',
    }]
    const session = createLocalImageDocumentSession(document(), { validateCommit: policy })
    expect(session.dispatch(addLayer()).ok).toBe(true)
    if (kind === 'redo') expect(session.undo()).toBe(true)
    const before = session.doc
    const revision = session.revision
    const history = [session.canUndo, session.canRedo]
    const observe = vi.fn()
    session.document.subscribe(observe)
    session.onOp(observe)
    admitted = false
    const outcome = kind === 'dispatch' ? session.dispatch({ command: 'image.layer.remove', params: { layerId: 'l3' } }).ok
      : kind === 'undo' ? session.undo() : session.redo()
    expect(outcome).toBe(false)
    expect(session.doc).toBe(before)
    expect(session.revision).toBe(revision)
    expect([session.canUndo, session.canRedo]).toEqual(history)
    expect(observe).not.toHaveBeenCalled()
    expect(() => createLocalImageDocumentSession(document(), { validateCommit: policy })).toThrow('Owner refused')
    const refused = kind === 'dispatch' ? session.prepareDispatch(addLayer(DIGEST_C))
      : kind === 'undo' ? session.prepareUndo() : session.prepareRedo()
    if (!refused.ok) throw new Error('Missing refused candidate')
    expect(refused.commit().ok).toBe(false)
    admitted = true
    expect(refused.commit().ok).toBe(false)
    expect(session.doc).toBe(before)
    expect(session.revision).toBe(revision)
  })

  it.each(['command', 'history-clear', 'policy-history-clear'] as const)('rejects candidates displaced by %s', (change) => {
    let mutatePolicy = false
    const store: ImageDocumentStore = new ImageDocumentStore(document(), 200, Date.now, () => {
      if (mutatePolicy) store.clearHistory()
      return []
    })
    expect(store.dispatch(addLayer()).ok).toBe(true)
    const prepared = store.prepareUndo()
    if (!prepared.ok) throw new Error('Missing undo')
    if (change === 'command') expect(store.dispatch({
      command: 'image.layer.update', params: { layerId: 'l1', name: 'Newer' },
    }).ok).toBe(true)
    else if (change === 'history-clear') store.clearHistory()
    else mutatePolicy = true
    const before = store.doc
    const revision = store.revision
    expect(prepared.commit()).toMatchObject({ ok: false, diagnostics: [{ code: 'image.candidate.stale' }] })
    expect(store.doc).toBe(before)
    expect(store.revision).toBe(revision)
    expect(store.doc.rootLayerIds).toEqual(['l1', 'l3'])
    if (change === 'command') expect(store.doc.layers.l1?.name).toBe('Newer')
    else expect(store.canUndo).toBe(false)
  })

  it('inventories unused external resources but excludes inline bytes across history', () => {
    const source = document()
    const store = new ImageDocumentStore({ ...source, resources: {
      ...source.resources,
      r8: { ...source.resources.r0!, id: asImageResourceId('r8'), digest: DIGEST_C },
      r9: { ...source.resources.r0!, id: asImageResourceId('r9'), inline: 'AA==', byteSize: 1,
        digest: 'blake3:2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213' },
    }, allocation: { nextOrdinal: 10 } })
    const prepared = store.prepareDispatch(addLayer())
    if (!prepared.ok) throw new Error('Missing prepared add')
    expect(prepared.currentResourceDigests).toEqual([DIGEST_A, DIGEST_C])
    expect(prepared.resourceDigests).toEqual([DIGEST_A, DIGEST_B, DIGEST_C])
    expect(prepared.commit().ok).toBe(true)
    const undo = store.prepareUndo()
    if (!undo.ok) throw new Error('Missing undo')
    expect(undo.resourceDigests).toEqual([DIGEST_A, DIGEST_B, DIGEST_C])
    expect(undo.commit().ok).toBe(true)
    store.clearHistory()
    expect(store.retainedResourceDigests()).toEqual(new Set([DIGEST_A, DIGEST_C]))
  })

  it('undoes and redoes without rewinding allocation cursors', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch(addLayer()).ok).toBe(true)
    const second = { ...addLayer(DIGEST_C), params: { ...addLayer(DIGEST_C).params, index: 2 } }
    expect(store.dispatch(second).ok).toBe(true)
    expect(store.doc.allocation.nextOrdinal).toBe(6)
    expect(store.undo()).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc.rootLayerIds).toEqual(['l1'])
    expect(store.doc.allocation.nextOrdinal).toBe(6)
    expect(store.redo()).toBe(true)
    expect(store.doc.rootLayerIds).toEqual(['l1', 'l3'])
    expect(store.doc.allocation.nextOrdinal).toBe(6)
    const fresh = store.dispatch({ ...addLayer(DIGEST_C), params: { ...addLayer(DIGEST_C).params, index: 2 } })
    expect(fresh.ok && fresh.created).toEqual({ layerId: 'l7', resourceId: 'r6' })
    expect(store.doc.allocation.nextOrdinal).toBe(8)
  })

  it('retains resource bytes while either undo or redo can restore them', () => {
    const store = new ImageDocumentStore(document())
    expect(store.dispatch(addLayer()).ok).toBe(true)
    expect(store.retainedResourceDigests()).toEqual(new Set([DIGEST_A, DIGEST_B]))
    expect(store.dispatch({ command: 'image.layer.remove', params: { layerId: 'l3' } }).ok).toBe(true)
    expect(store.doc.resources['r2']).toBeUndefined()
    expect(store.retainedResourceDigests()).toEqual(new Set([DIGEST_A, DIGEST_B]))
    expect(store.undo()).toBe(true)
    expect(store.redo()).toBe(true)
    store.clearHistory()
    expect(store.retainedResourceDigests()).toEqual(new Set([DIGEST_A]))
  })

  it('drops resource retention with evicted history', () => {
    const store = new ImageDocumentStore(document(), 1)
    expect(store.dispatch(addLayer()).ok).toBe(true)
    expect(store.dispatch({ command: 'image.layer.remove', params: { layerId: 'l3' } }).ok).toBe(true)
    expect(store.retainedResourceDigests()).toContain(DIGEST_B)
    const prepared = store.prepareDispatch({
      command: 'image.layer.update', params: { layerId: 'l1', visible: false },
    })
    if (!prepared.ok) throw new Error('Missing prepared edit')
    expect(prepared.currentResourceDigests).toEqual([DIGEST_A, DIGEST_B])
    expect(prepared.resourceDigests).toEqual([DIGEST_A])
    expect(store.retainedResourceDigests()).toContain(DIGEST_B)
    expect(prepared.commit().ok).toBe(true)
    expect(store.retainedResourceDigests()).not.toContain(DIGEST_B)
  })

  it('publishes contiguous wire-shaped local session operations', () => {
    const session = createLocalImageDocumentSession(document(), {
      actorId: 'alice',
      clock: () => 123,
    })
    const operations: unknown[] = []
    session.onOp((operation) => operations.push(operation))
    expect(session.dispatch({
      command: 'image.layer.update', params: { layerId: 'l1', visible: false },
    }).ok).toBe(true)
    expect(session.undo()).toBe(true)
    expect(session.redo()).toBe(true)
    expect(operations).toMatchObject([
      { opId: 'alice#1', actorId: 'alice', baseRevision: 0, revision: 1, timestamp: 123, origin: 'image.layer.update' },
      { opId: 'alice#2', baseRevision: 1, revision: 2, origin: 'image.undo' },
      { opId: 'alice#3', baseRevision: 2, revision: 3, origin: 'image.redo' },
    ])
    expect((operations[0] as { patch: Record<string, unknown>[] }).patch[0]).not.toHaveProperty('oldValue')
    expect(session.document.get()).toBe(session.doc)
    expect(() => createLocalImageDocumentSession(document(), { actorId: 'bad#actor' })).toThrow('actor id')
  })

  it('returns the committed result when a listener dispatches again', () => {
    const store = new ImageDocumentStore(document())
    store.onTransaction((transaction) => {
      if (transaction.revision === 1) {
        store.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Nested' } })
      }
    })
    const first = store.dispatch({
      command: 'image.layer.update', params: { layerId: 'l1', visible: false },
    })
    expect(first.ok && first.revision).toBe(1)
    expect(first.ok && first.document.layers['l1']).toMatchObject({ name: 'Pixels', visible: false })
    expect(store.revision).toBe(2)
    expect(store.doc.layers['l1']).toMatchObject({ name: 'Nested', visible: false })
  })

  it('isolates store listeners after a commit', () => {
    const store = new ImageDocumentStore(document())
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const observed: number[] = []
    store.onTransaction(() => { throw new Error('listener failed') })
    store.onTransaction((transaction) => observed.push(transaction.revision))
    expect(store.dispatch({
      command: 'image.layer.update', params: { layerId: 'l1', visible: false },
    }).ok).toBe(true)
    expect(observed).toEqual([1])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
