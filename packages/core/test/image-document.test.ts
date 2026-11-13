import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../src/diagnostics.js'
import { loadDocument } from '../src/format/migrate.js'
import { checkImageDocument } from '../src/image-document/invariants.js'
import { loadImageDocument, serializeImageDocument } from '../src/image-document/migrate.js'
import { IMAGE_DOCUMENT_FORMAT_VERSION, IMAGE_FIXED_POINT_SCALE, IMAGE_OPACITY_MAX, MAX_IMAGE_CANVAS_DIMENSION, MAX_IMAGE_LAYER_DEPTH, asImageLayerId, asImageLineageId, asImageMaskId, asImageResourceId, type ImageAffineTransform, type ImageDocument } from '../src/image-document/model.js'

const DIGEST = `blake3:${'a'.repeat(64)}` as const
const LAYER = asImageLayerId('l1')
const GROUP = asImageLayerId('l3')
const MASK = asImageMaskId('m2')
const RESOURCE = asImageResourceId('r0')

const identity = (): ImageAffineTransform => ({
  a: IMAGE_FIXED_POINT_SCALE,
  b: 0,
  c: 0,
  d: IMAGE_FIXED_POINT_SCALE,
  tx: 0,
  ty: 0,
})

function imageDocument(): ImageDocument {
  return {
    format: 'dinkster-image',
    formatVersion: IMAGE_DOCUMENT_FORMAT_VERSION,
    lineage: asImageLineageId('image-lineage-1'),
    canvas: {
      width: 8,
      height: 6,
      colorSpace: 'srgb',
      channelDepth: 8,
      compositing: 'premultiplied-alpha',
    },
    allocation: { nextOrdinal: 4 },
    rootLayerIds: [GROUP],
    layers: {
      l1: {
        id: LAYER,
        kind: 'raster',
        name: 'Pixels',
        visible: true,
        opacity: IMAGE_OPACITY_MAX,
        transform: identity(),
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [MASK],
        resourceId: RESOURCE,
        sourceRect: { x: 0, y: 0, width: 8, height: 6 },
      },
      l3: {
        id: GROUP,
        kind: 'group',
        name: 'Root group',
        visible: true,
        opacity: IMAGE_OPACITY_MAX,
        transform: identity(),
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [],
        childLayerIds: [LAYER],
      },
    },
    masks: {
      m2: {
        id: MASK,
        kind: 'raster',
        ownerLayerId: LAYER,
        enabled: true,
        invert: false,
        opacity: IMAGE_OPACITY_MAX,
        transform: identity(),
        combineMode: 'multiply',
        channel: 'luminance',
        resourceId: RESOURCE,
        sourceRect: { x: 0, y: 0, width: 8, height: 6 },
      },
    },
    resources: {
      r0: {
        id: RESOURCE,
        kind: 'raster',
        digest: DIGEST,
        byteSize: 100,
        mediaType: 'image/png',
        width: 8,
        height: 6,
        colorSpace: 'srgb',
        channelDepth: 8,
        alphaMode: 'straight',
      },
    },
    extensions: { test: { ignoredByRenderer: true } },
  }
}

const mutableDocument = (): Record<string, any> => structuredClone(imageDocument())
const errorCodes = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics.filter((item) => item.severity === 'error').map((item) => item.code)

describe('ImageDocument loading', () => {
  it('loads a valid document as a detached deep-frozen value', () => {
    const input = mutableDocument()
    const result = loadImageDocument(input)
    expect(errorCodes(result.diagnostics)).toEqual([])
    expect(result.document).toEqual(input)
    expect(Object.isFrozen(result.document)).toBe(true)
    expect(Object.isFrozen(result.document!.layers)).toBe(true)
    expect(Object.isFrozen(result.document!.layers['l1']!.transform)).toBe(true)
    input.layers = {}
    expect(Object.keys(result.document!.layers)).toHaveLength(2)
  })

  it('keeps workflow and image loaders separated by their root discriminator', () => {
    expect(loadDocument(imageDocument()).document).toBeUndefined()
    expect(loadImageDocument({ format: 'dinkster-workflow', formatVersion: 1 }).document).toBeUndefined()
    expect(loadImageDocument({ format: 'dinkster-workflow', formatVersion: 1 }).diagnostics[0]!.code)
      .toBe('image.format.unknown')
  })

})

describe('ImageDocument shape and limits', () => {

  it('retains the v2 fields without converting color metadata or raster bytes', () => {
    const input = mutableDocument()
    input.canvas.compositing = 'linear-premultiplied-alpha'
    input.canvas.color = { primaries: 999, transfer: 13, range: 2, matrix: 0, bit_depth: 8 }
    input.canvas.background = [65535, 0, 0, 32768]
    input.layers.l3.isolation = 'pass-through'
    input.layers.l1.z_index = -4
    input.layers.l1.blendMode = 'vivid_light'
    input.layers.l1.transform.components = {
      x: 0, y: 0, width: 8, height: 6, rotation: 0,
      flipHorizontal: false, flipVertical: false, sourceWidth: 8, sourceHeight: 6,
    }
    input.resources.r0.inline = 'AA=='
    input.resources.r0.byteSize = 1
    input.resources.r0.digest = 'blake3:2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'
    expect(loadImageDocument(input).document).toEqual(input)
  })

  it('rejects malformed v2 fields, incomplete components and inline byte mismatches', () => {
    for (const mutate of [
      (input: Record<string, any>) => { input.canvas.color = { primaries: 1, transfer: 13 } },
      (input: Record<string, any>) => { input.canvas.background = [0, 0, 0, 65536] },
      (input: Record<string, any>) => { input.layers.l1.isolation = 'isolated' },
      (input: Record<string, any>) => { input.layers.l1.z_index = 1.5 },
      (input: Record<string, any>) => { input.layers.l1.transform.components = { x: 0 } },
      (input: Record<string, any>) => { input.resources.r0.inline = 'AA==' },
      (input: Record<string, any>) => { input.resources.r0.inline = '!!!!' },
    ]) {
      const input = mutableDocument()
      mutate(input)
      expect(loadImageDocument(input).document).toBeUndefined()
    }
  })

  it.each([
    {
      a: 0, b: 1000000, c: -1000000, d: 0, tx: 17000000, ty: 19000000,
      components: {
        x: 10, y: 20, width: 8, height: 6, rotation: Math.PI / 2,
        flipHorizontal: false, flipVertical: false, sourceWidth: 8, sourceHeight: 6,
      },
    },
    {
      a: -1910673, b: -591040, c: -443280, d: 1433005, tx: 3209636, ty: 4112927,
      components: {
        x: -2.5, y: 3.25, width: 5.5, height: 2.25, rotation: 0.3,
        flipHorizontal: true, flipVertical: false, sourceWidth: 2.75, sourceHeight: 1.5,
      },
    },
    {
      a: 924724, b: -380638, c: 380638, d: 924724, tx: -840810, ty: 1748378,
      components: {
        x: 0, y: 0, width: 8, height: 6, rotation: 1e100,
        flipHorizontal: false, flipVertical: false, sourceWidth: 8, sourceHeight: 6,
      },
    },
    {
      // CPU and browser trig can round to different integers at this threshold.
      a: 1000001, b: 874611, c: -658338, d: 752722, tx: 493425, ty: -313666,
      components: {
        x: 0, y: 0, width: 1.3285122570160817, height: 1, rotation: 0.718609201533476,
        flipHorizontal: false, flipVertical: false, sourceWidth: 1, sourceHeight: 1,
      },
    },
  ])('preserves CPU affine coefficients and fractional radians components without rederiving them (%#)', (transform) => {
    const input = mutableDocument()
    input.layers.l1.transform = transform
    input.masks.m2.transform = transform
    const loaded = loadImageDocument(input)
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.document).toEqual(input)
    expect(serializeImageDocument(loaded.document!)).toBe(serializeImageDocument(input as ImageDocument))
  })

  it('rejects non-integer and out-of-contract rendering values', () => {
    const opacity = mutableDocument()
    opacity.layers.l1.opacity = 0.5
    expect(loadImageDocument(opacity).document).toBeUndefined()

    const transform = mutableDocument()
    transform.layers.l1.transform.a = Number.MAX_SAFE_INTEGER
    expect(loadImageDocument(transform).document).toBeUndefined()

    const canvas = mutableDocument()
    canvas.canvas.width = MAX_IMAGE_CANVAS_DIMENSION + 1
    expect(loadImageDocument(canvas).document).toBeUndefined()
  })

  it('rejects malformed resource descriptors and decoded pixel bombs', () => {
    const digest = mutableDocument()
    digest.resources.r0.digest = `sha256:${'a'.repeat(64)}`
    expect(loadImageDocument(digest).document).toBeUndefined()

    const bomb = mutableDocument()
    bomb.resources.r0.width = 16_384
    bomb.resources.r0.height = 16_384
    expect(loadImageDocument(bomb).diagnostics.some((item) => item.message.includes('decoded raster exceeds')))
      .toBe(true)
  })

})

describe('ImageDocument invariants', () => {

  it('rejects duplicate parents, dangling children, cycles, and excessive depth', () => {
    const duplicate = mutableDocument()
    duplicate.rootLayerIds.push('l1')
    expect(errorCodes(checkImageDocument(duplicate as ImageDocument))).toContain('image.layer.parentCount')

    const dangling = mutableDocument()
    dangling.layers.l3.childLayerIds = ['l99']
    expect(errorCodes(checkImageDocument(dangling as ImageDocument))).toContain('image.layer.dangling')

    const cycle = mutableDocument()
    cycle.rootLayerIds = []
    cycle.layers.l1 = { ...cycle.layers.l3, id: 'l1', childLayerIds: ['l3'] }
    cycle.layers.l3.childLayerIds = ['l1']
    cycle.masks = {}
    cycle.resources = {}
    cycle.allocation.nextOrdinal = 4
    expect(errorCodes(checkImageDocument(cycle as ImageDocument))).toContain('image.layer.cycle')

    const layers: Record<string, any> = {}
    for (let index = 0; index <= MAX_IMAGE_LAYER_DEPTH; index++) {
      layers[`l${index}`] = {
        id: `l${index}`,
        kind: 'group',
        name: '',
        visible: true,
        opacity: IMAGE_OPACITY_MAX,
        transform: identity(),
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [],
        childLayerIds: index === MAX_IMAGE_LAYER_DEPTH ? [] : [`l${index + 1}`],
      }
    }
    const deep = {
      ...imageDocument(),
      allocation: { nextOrdinal: MAX_IMAGE_LAYER_DEPTH + 1 },
      rootLayerIds: ['l0'],
      layers,
      masks: {},
      resources: {},
    }
    expect(errorCodes(checkImageDocument(deep as unknown as ImageDocument))).toContain('image.layer.depth')
  })

  it('enforces mask ownership and resource closure', () => {
    const owner = mutableDocument()
    owner.masks.m2.ownerLayerId = 'l3'
    expect(errorCodes(checkImageDocument(owner as ImageDocument))).toContain('image.mask.ownerMismatch')

    const missing = mutableDocument()
    missing.layers.l1.resourceId = 'r9'
    expect(errorCodes(checkImageDocument(missing as ImageDocument))).toContain('image.resource.dangling')

    const rectangle = mutableDocument()
    rectangle.masks.m2.sourceRect.width = 9
    expect(errorCodes(checkImageDocument(rectangle as ImageDocument))).toContain('image.resource.sourceRect')

    const jpeg = mutableDocument()
    jpeg.resources.r0.mediaType = 'image/jpeg'
    expect(errorCodes(checkImageDocument(jpeg as ImageDocument))).toContain('image.resource.alphaMode')
  })
})
