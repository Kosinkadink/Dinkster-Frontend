import { describe, expect, it } from 'vitest'
import { asGraphDefId, asLineageId, asNodeId, coreCommandRegistry, DocumentStore, type NodeSchema, type WorkflowDocument } from '@dinkster/core'
import {
  appendImageEditOperation,
  createImageSession,
  imageInputCandidates,
  maskPaintOperationsJson,
  projectImageMask,
  redoImageEdit,
  restoreMaskPaintSession,
  undoImageEdit,
} from '../src/image-editor.js'
import { applyMaskToRgba, maskFromRgba } from '../src/image-mask-tool.js'
import { decodePng, encodePng } from '../src/image-png.js'

describe('image editor mask capability', () => {
  it('round-trips the strict cumulative mask-paint recipe without local pointer fields', () => {
    const source = { width: 2, height: 1, rgba: new Uint8ClampedArray(8) }
    const digest = `blake3:${'a'.repeat(64)}`
    const edited = appendImageEditOperation(createImageSession(source), {
      kind: 'mask.stroke', mode: 'paint', size: 12.5, hardness: 0.75,
      points: [{ x: 0.5, y: 0.5, pressure: 0.8, time: 10, tiltX: 2, tiltY: 3, twist: 4 }],
    })
    const value = maskPaintOperationsJson(edited, digest)
    expect(JSON.parse(value)).toEqual({
      version: 1, sourceDigest: digest, width: 2, height: 1,
      commands: [{ op: 'stroke', mode: 'paint', size: 12.5, hardness: 0.75, points: [{ x: 0.5, y: 0.5, pressure: 0.8 }] }],
    })
    const restored = restoreMaskPaintSession(createImageSession(source), value, digest)
    expect(restored.index).toBe(0)
    expect(maskPaintOperationsJson(restored, digest)).toBe(value)
  })

  it('refuses stale, malformed, dimension-mismatched, and unknown mask-paint recipes', () => {
    const base = createImageSession({ width: 2, height: 1, rgba: new Uint8ClampedArray(8) })
    const digest = `blake3:${'a'.repeat(64)}`
    const valid = { version: 1, sourceDigest: digest, width: 2, height: 1, commands: [] }
    const validJson = JSON.stringify(valid)
    for (const value of [
      '{',
      JSON.stringify({ ...valid, sourceDigest: `blake3:${'b'.repeat(64)}` }),
      JSON.stringify({ ...valid, width: 3 }),
      JSON.stringify({ ...valid, extra: true }),
      JSON.stringify({ ...valid, commands: [{ op: 'stroke', mode: 'paint', size: 1, hardness: 1, points: [] }] }),
      `{"version":1,"\\u0076ersion":1,"sourceDigest":"${digest}","width":2,"height":1,"commands":[]}`,
      `{"version":1,"sourceDigest":"${digest}","width":2,"height":1,"commands":[{"op":"stroke","mode":"paint","size":1,"hardness":1,"points":[{"x":0.5,"x":0.5,"y":0.5,"pressure":1}]}]}`,
      `${validJson}${' '.repeat(4_194_305)}`,
      validJson.replace('"version":1', '"version":1.0'),
      validJson.replace('"version":1', '"version":1e0'),
      validJson.replace('"width":2', '"width":2.0'),
      validJson.replace('"height":1', '"height":1e0'),
    ]) expect(() => restoreMaskPaintSession(base, value, digest)).toThrow()
  })

  it('decodes a standard filtered RGBA fixture', async () => {
    const bytes = Uint8Array.from(Buffer.from('89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000001549444154789c63f8cfc0f01f0841e07ffd7f2000003d5208780421d8850000000049454e44ae426082', 'hex'))
    const decoded = await decodePng(bytes)
    expect([decoded.width, decoded.height]).toEqual([2, 2])
  })

  it('decodes palette transparency, grayscale alpha, and Adam7 without losing RGB', async () => {
    const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))
    const palette = await decodePng(fromHex('89504e470d0a1a0a0000000d4948445200000002000000010103000000ceecedc900000006504c54450a141e28323cd51bb4e90000000274524e53ff00e5b7304a0000000a49444154789c63700000004200412937f4ef0000000049454e44ae426082'))
    expect([...palette.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 0])
    const grayscaleAlpha = await decodePng(fromHex('89504e470d0a1a0a0000000d49484452000000020000000108040000005e2bb7010000000d49444154789c6310f97f82010004e201dc0dc7bdfb0000000049454e44ae426082'))
    expect([...grayscaleAlpha.rgba]).toEqual([20, 20, 20, 255, 200, 200, 200, 0])
    const packedGrayscale = await decodePng(fromHex('89504e470d0a1a0a0000000d4948445200000002000000010100000000dc5942270000000274524e5300010194fdae0000000a49444154789c63700000004200412937f4ef0000000049454e44ae426082'))
    expect([...packedGrayscale.rgba]).toEqual([0, 0, 0, 255, 255, 255, 255, 0])
    const adam7 = await decodePng(fromHex('89504e470d0a1a0a0000000d4948445200000003000000030806000001212f85290000002f49444154789c0dc8b10100300404c0671bbd45ec10cf164617cd1507d1b708e540c80936609a076b219e30bff6da0fdc040b567104b1960000000049454e44ae426082'))
    expect(Buffer.from(adam7.rgba).toString('hex')).toBe('010264ff290265005102667f013465002934667f513467ff0166667f296667ff51666800')
  })

  it('uses 1-alpha and preserves transparent RGB through PNG export and reopen', async () => {
    const source = new Uint8ClampedArray([
      1, 2, 3, 255,
      44, 55, 66, 0,
      101, 102, 103, 127,
    ])
    const mask = maskFromRgba(source)
    expect([...mask]).toEqual([0, 255, 128])
    const png = await encodePng(3, 1, applyMaskToRgba(source, mask))
    const reopened = await decodePng(png)
    expect(reopened.width).toBe(3)
    expect([...reopened.rgba]).toEqual([...source])
    expect([...maskFromRgba(reopened.rgba)]).toEqual([0, 255, 128])
  })

  it('keeps serializable grouped operations in a local undoable session', () => {
    const source = {
      width: 3,
      height: 1,
      rgba: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 155, 7, 8, 9, 0]),
    }
    let session = createImageSession(source)
    session = appendImageEditOperation(session, {
      kind: 'mask.stroke', mode: 'paint', size: 2, hardness: 1,
      points: [
        { x: 0.5, y: 0.5, time: 10, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 },
        { x: 1.5, y: 0.5, time: 11, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 },
      ],
    })
    expect(session.operations).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(session.operations))).toEqual(session.operations)
    const painted = projectImageMask(session)
    session = undoImageEdit(session)
    expect([...projectImageMask(session)]).toEqual([0, 100, 255])
    session = redoImageEdit(session)
    expect([...projectImageMask(session)]).toEqual([...painted])
    session = undoImageEdit(session)
    session = appendImageEditOperation(session, { kind: 'mask.clear' })
    expect(session.operations).toHaveLength(1)
    expect(redoImageEdit(session)).toBe(session)
    expect([...projectImageMask(session)]).toEqual([0, 0, 0])
    session = appendImageEditOperation(session, { kind: 'mask.invert' })
    expect([...projectImageMask(session)]).toEqual([255, 255, 255])
    const doc: WorkflowDocument = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('image-edit-session'), root: asGraphDefId('g0'),
      graphs: { g0: { id: asGraphDefId('g0'), name: 'image', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: {} },
    }
    const store = new DocumentStore(doc, coreCommandRegistry())
    expect(store.revision).toBe(0)
  })

  it('uses pen pressure for both brush diameter and opacity', () => {
    const source = {
      width: 9,
      height: 9,
      rgba: Uint8ClampedArray.from({ length: 9 * 9 * 4 }, (_, index) => index % 4 === 3 ? 255 : 0),
    }
    const stroke = (pressure: number) => appendImageEditOperation(createImageSession(source), {
      kind: 'mask.stroke' as const,
      mode: 'paint' as const,
      size: 8,
      hardness: 1,
      points: [{ x: 4.5, y: 4.5, time: 10, pressure, tiltX: 0, tiltY: 0, twist: 0 }],
    })
    const light = projectImageMask(stroke(0.25))
    const firm = projectImageMask(stroke(1))
    expect(light[4 * 9 + 4]).toBe(64)
    expect(firm[4 * 9 + 4]).toBe(255)
    expect(firm.filter((value) => value > 0).length).toBeGreaterThan(light.filter((value) => value > 0).length)
  })
})

describe('image editor entry admission', () => {
  const ref = { digest: `blake3:${'a'.repeat(64)}`, name: 'image.png', size: 10, mediaType: 'image/png', virtualPath: '' }
  const input = (id: string, kind = 'image') => ({
    kind: 'input' as const, id, displayName: id, optional: false,
    type: { kind: 'asset' as const, element: { kind: 'concrete' as const, name: kind === 'image' ? 'comfy.IMAGE' : 'comfy.VIDEO' } },
    widget: { widgetType: 'ASSET', kind, options: { accept: [kind === 'image' ? 'image/png' : 'video/mp4'] } },
  })
  const schema = (items: NodeSchema['items']): NodeSchema => ({
    type: 'Loader', displayName: 'Loader', category: 'test', source: { kind: 'dinkster' }, items, isOutputNode: false,
  } as unknown as NodeSchema)

  it('accepts one writable image AssetRef and rejects missing, video, driven, and ambiguous inputs', () => {
    expect(imageInputCandidates({ schema: schema([input('image')]), nodeId: asNodeId('n0'), values: { image: ref } })).toHaveLength(1)
    expect(imageInputCandidates({ schema: schema([{ ...input('image'), type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } } }]), nodeId: asNodeId('n0'), values: { image: ref } })).toHaveLength(1)
    expect(imageInputCandidates({ schema: schema([input('image')]), nodeId: asNodeId('n0'), values: {} })).toEqual([])
    expect(imageInputCandidates({ schema: schema([input('video', 'video')]), nodeId: asNodeId('n0'), values: { video: { ...ref, mediaType: 'video/mp4' } } })).toEqual([])
    expect(imageInputCandidates({ schema: schema([input('image')]), nodeId: asNodeId('n0'), values: { image: ref }, drivenInputIds: new Set(['image']) })).toEqual([])
    expect(imageInputCandidates({ schema: schema([input('a'), input('b')]), nodeId: asNodeId('n0'), values: { a: ref, b: ref } })).toHaveLength(2)
    expect(imageInputCandidates({ schema: schema([{ ...input('image'), type: { kind: 'concrete', name: 'dinkster.asset' } }]), nodeId: asNodeId('n0'), values: { image: ref } })).toEqual([])
    expect(imageInputCandidates({ schema: schema([input('image')]), nodeId: asNodeId('n0'), values: { image: { ...ref, mediaType: 'image/jpeg' } } })).toEqual([])
    expect(imageInputCandidates({ schema: schema([{ ...input('image'), hidden: true }]), nodeId: asNodeId('n0'), values: { image: ref } })).toEqual([])
  })
})
