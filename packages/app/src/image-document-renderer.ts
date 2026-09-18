import {
  IMAGE_FIXED_POINT_SCALE,
  IMAGE_OPACITY_MAX,
  type ImageAffineTransform,
  type ImageDocument,
  type ImageLayer,
  type ImageMask,
  type ImageRasterResource,
} from '@dinkster/core'
import type { ImageDocumentLocalStore } from './image-document-local.js'

const blendOperation: Readonly<Partial<Record<ImageLayer['blendMode'], GlobalCompositeOperation>>> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
}

const MAX_PREVIEW_DIMENSION = 2_048
const MAX_PREVIEW_PIXELS = 4_000_000

export function imageDocumentPreviewRefusal(value: ImageDocument): string | undefined {
  if (value.canvas.compositing === 'linear-premultiplied-alpha' || value.canvas.background !== undefined ||
    (value.canvas.color !== undefined && (value.canvas.color.primaries !== 1 ||
      value.canvas.color.transfer !== 13 || value.canvas.color.range !== 2 ||
      value.canvas.color.matrix !== undefined || value.canvas.color.bit_depth !== undefined))) {
    return 'Canvas color or background requires the authoritative CPU render'
  }
  for (const layer of Object.values(value.layers)) {
    if (blendOperation[layer.blendMode] === undefined || layer.clipping !== 'none' ||
      layer.z_index !== undefined || (layer.kind === 'group' && layer.isolation === 'pass-through')) {
      return 'Layer blending, clipping, ordering or isolation requires the authoritative CPU render'
    }
  }
  if (Object.values(value.resources).some((resource) => resource.alphaMode !== 'straight')) {
    return 'Explicit raster alpha interpretation requires the authoritative CPU render'
  }
  return undefined
}

function canvas(width: number, height: number): HTMLCanvasElement {
  return Object.assign(document.createElement('canvas'), { width, height })
}

function context(surface: HTMLCanvasElement): CanvasRenderingContext2D {
  const value = surface.getContext('2d', { willReadFrequently: true })
  if (value === null) throw new Error('2D canvas is unavailable')
  return value
}

function applyTransform(target: CanvasRenderingContext2D, transform: ImageAffineTransform): void {
  target.transform(
    transform.a / IMAGE_FIXED_POINT_SCALE,
    transform.b / IMAGE_FIXED_POINT_SCALE,
    transform.c / IMAGE_FIXED_POINT_SCALE,
    transform.d / IMAGE_FIXED_POINT_SCALE,
    transform.tx / IMAGE_FIXED_POINT_SCALE,
    transform.ty / IMAGE_FIXED_POINT_SCALE,
  )
}

function maskValue(mask: ImageMask, red: number, green: number, blue: number, alpha: number): number {
  const channel = mask.channel === 'alpha'
    ? alpha / 255
    : (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  const value = mask.invert ? 1 - channel : channel
  const opacity = mask.opacity / IMAGE_OPACITY_MAX
  return 1 - opacity + value * opacity
}

export class ImageDocumentPreviewRenderer {
  private readonly bitmaps = new Map<string, Promise<ImageBitmap>>()

  constructor(private readonly store: ImageDocumentLocalStore) {}

  dispose(): void {
    for (const pending of this.bitmaps.values()) void pending.then((bitmap) => bitmap.close()).catch(() => undefined)
    this.bitmaps.clear()
  }

  async draw(documentValue: ImageDocument, output: HTMLCanvasElement): Promise<void> {
    const refusal = imageDocumentPreviewRefusal(documentValue)
    if (refusal !== undefined) {
      context(output).clearRect(0, 0, output.width, output.height)
      throw new Error(refusal)
    }
    const scale = Math.min(
      1,
      MAX_PREVIEW_DIMENSION / documentValue.canvas.width,
      MAX_PREVIEW_DIMENSION / documentValue.canvas.height,
      Math.sqrt(MAX_PREVIEW_PIXELS / (documentValue.canvas.width * documentValue.canvas.height)),
    )
    output.width = Math.max(1, Math.round(documentValue.canvas.width * scale))
    output.height = Math.max(1, Math.round(documentValue.canvas.height * scale))
    const target = context(output)
    target.clearRect(0, 0, output.width, output.height)
    target.scale(scale, scale)
    for (const layerId of documentValue.rootLayerIds) {
      await this.drawLayer(documentValue, documentValue.layers[layerId]!, target, scale)
    }
  }

  private async bitmap(resource: ImageRasterResource): Promise<ImageBitmap> {
    let pending = this.bitmaps.get(resource.digest)
    if (pending === undefined) {
      pending = this.store.getResource(resource.digest).then((staged) => {
        if (staged === undefined) throw new Error(`ImageDocument resource is not staged: ${resource.id}`)
        return createImageBitmap(new Blob([Uint8Array.from(staged.bytes)], { type: staged.mediaType }), {
          colorSpaceConversion: 'default',
          imageOrientation: 'none',
          premultiplyAlpha: 'none',
        })
      })
      this.bitmaps.set(resource.digest, pending)
      void pending.catch(() => {
        if (this.bitmaps.get(resource.digest) === pending) this.bitmaps.delete(resource.digest)
      })
    }
    return pending
  }

  private async drawLayer(
    documentValue: ImageDocument,
    layer: ImageLayer,
    target: CanvasRenderingContext2D,
    scale: number,
  ): Promise<void> {
    if (!layer.visible || layer.opacity === 0) return
    const width = Math.max(1, Math.round(documentValue.canvas.width * scale))
    const height = Math.max(1, Math.round(documentValue.canvas.height * scale))
    const surface = canvas(width, height)
    const local = context(surface)
    local.scale(scale, scale)
    if (layer.kind === 'raster') {
      const resource = documentValue.resources[layer.resourceId]!
      const image = await this.bitmap(resource)
      local.save()
      applyTransform(local, layer.transform)
      local.drawImage(
        image,
        layer.sourceRect.x,
        layer.sourceRect.y,
        layer.sourceRect.width,
        layer.sourceRect.height,
        0,
        0,
        layer.sourceRect.width,
        layer.sourceRect.height,
      )
      local.restore()
    } else {
      for (const childId of layer.childLayerIds) {
        await this.drawLayer(documentValue, documentValue.layers[childId]!, local, scale)
      }
    }
    if (layer.maskIds.length > 0) await this.applyMasks(documentValue, layer, surface, scale)
    target.save()
    target.globalAlpha = layer.opacity / IMAGE_OPACITY_MAX
    target.globalCompositeOperation = blendOperation[layer.blendMode]!
    if (layer.kind === 'group') applyTransform(target, layer.transform)
    target.drawImage(surface, 0, 0, documentValue.canvas.width, documentValue.canvas.height)
    target.restore()
  }

  private async applyMasks(
    documentValue: ImageDocument,
    layer: ImageLayer,
    surface: HTMLCanvasElement,
    scale: number,
  ): Promise<void> {
    const enabled = layer.maskIds.map((id) => documentValue.masks[id]!).filter((mask) => mask.enabled)
    if (enabled.length === 0) return
    const width = surface.width
    const height = surface.height
    const combined = new Float32Array(width * height)
    let initialized = false
    for (const mask of enabled) {
      const maskSurface = canvas(width, height)
      const maskContext = context(maskSurface)
      maskContext.scale(scale, scale)
      const resource = documentValue.resources[mask.resourceId]!
      const image = await this.bitmap(resource)
      maskContext.save()
      applyTransform(maskContext, mask.transform)
      maskContext.drawImage(
        image,
        mask.sourceRect.x,
        mask.sourceRect.y,
        mask.sourceRect.width,
        mask.sourceRect.height,
        0,
        0,
        mask.sourceRect.width,
        mask.sourceRect.height,
      )
      maskContext.restore()
      const pixels = maskContext.getImageData(0, 0, width, height).data
      for (let pixel = 0; pixel < combined.length; pixel += 1) {
        const offset = pixel * 4
        const value = maskValue(mask, pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!)
        if (!initialized) combined[pixel] = value
        else if (mask.combineMode === 'multiply') combined[pixel] = combined[pixel]! * value
        else if (mask.combineMode === 'add') combined[pixel] = Math.min(1, combined[pixel]! + value)
        else if (mask.combineMode === 'subtract') combined[pixel] = Math.max(0, combined[pixel]! - value)
        else combined[pixel] = Math.min(combined[pixel]!, value)
      }
      initialized = true
    }
    const target = context(surface)
    const content = target.getImageData(0, 0, width, height)
    for (let pixel = 0; pixel < combined.length; pixel += 1) {
      content.data[pixel * 4 + 3] = Math.round(content.data[pixel * 4 + 3]! * combined[pixel]!)
    }
    target.putImageData(content, 0, 0)
  }
}
