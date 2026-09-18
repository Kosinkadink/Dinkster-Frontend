import type { ExecutionState, RenditionResult, ValueDescriptor } from '@dinkster/client'
import { parseAssetTypeId } from '@dinkster/core'

export interface ExecutedImageBatch {
  readonly count: number
  imageAt(index: number): ExecutedImage
}

export interface ExecutedImage {
  readonly key: string
  readonly runtimeId: string
  readonly outputId: string
  readonly descriptorIndex: number
  readonly url: string
  readonly kind: 'v1' | 'asset' | 'rendition'
  readonly mediaType: string
  readonly descriptor?: ValueDescriptor
  readonly listPath?: readonly number[]
  readonly batchIndex?: number
  readonly load?: (signal: AbortSignal) => Promise<RenditionResult>
  readonly name?: string
  readonly digest?: string
  readonly subfolder?: string
  readonly fileType?: string
}

interface ImageAssetRef {
  readonly digest: string
  readonly mediaType: string
  readonly name?: string
}

const CAS_DIGEST = /^blake3:[0-9a-f]{64}$/

function imageAssetRefsInOrder(descriptor: unknown): readonly ImageAssetRef[] {
  const refs: ImageAssetRef[] = []
  const visited = new WeakSet<object>()
  const stack: unknown[] = [descriptor]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value !== 'object' || value === null || Array.isArray(value) || visited.has(value)) continue
    visited.add(value)
    const item = value as Record<string, unknown>
    const typeId = item['typeId']
    const meta = typeof item['meta'] === 'object' && item['meta'] !== null && !Array.isArray(item['meta'])
      ? item['meta'] as Record<string, unknown>
      : undefined
    const digest = typeof meta?.['digest'] === 'string' ? meta['digest'] : undefined
    const mediaType = typeof meta?.['mediaType'] === 'string' ? meta['mediaType'] : undefined
    if (
      typeof typeId === 'string' &&
      (typeId === 'dinkster.asset' || parseAssetTypeId(typeId) !== undefined) &&
      digest !== undefined && CAS_DIGEST.test(digest) && mediaType?.startsWith('image/') === true
    ) {
      const name = typeof meta?.['name'] === 'string' ? meta['name'] : undefined
      refs.push({ digest, mediaType, ...(name === undefined ? {} : { name }) })
    }
    const elements = item['elements']
    if (Array.isArray(elements)) {
      for (let index = elements.length - 1; index >= 0; index--) stack.push(elements[index])
    }
  }
  return refs
}

export function executedImageInventory(
  execution: ExecutionState,
  options: {
    readonly runtimeIds?: readonly string[]
    readonly viewUrlForExecution: (
      ref: ExecutionState['ref'],
      file: { filename: string; subfolder?: string; type?: string },
    ) => string
    readonly assetUrlForExecution: (ref: ExecutionState['ref'], digest: string) => string
  },
): readonly ExecutedImage[] {
  const allowed = options.runtimeIds === undefined ? undefined : new Set(options.runtimeIds)
  const images: ExecutedImage[] = []
  for (const runtimeId of Object.keys(execution.outputs).sort()) {
    if (allowed !== undefined && !allowed.has(runtimeId)) continue
    const outputs = execution.outputs[runtimeId]!
    const v1Images = outputs['images']
    const validV1Images: { readonly descriptorIndex: number; readonly request: { filename: string; subfolder?: string; type?: string } }[] = []
    if (Array.isArray(v1Images)) {
      for (const [descriptorIndex, value] of v1Images.entries()) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
        const file = value as { filename?: unknown; subfolder?: unknown; type?: unknown }
        if (typeof file.filename !== 'string' || file.filename.length === 0) continue
        const request = {
          filename: file.filename,
          ...(typeof file.subfolder === 'string' ? { subfolder: file.subfolder } : {}),
          ...(typeof file.type === 'string' ? { type: file.type } : {}),
        }
        validV1Images.push({ descriptorIndex, request })
      }
    }
    if (validV1Images.length > 0) {
      for (const { descriptorIndex, request } of validV1Images) {
        images.push({
          key: `${execution.key}:v1:${runtimeId}:${descriptorIndex}:${JSON.stringify(request)}`,
          runtimeId,
          outputId: 'images',
          descriptorIndex,
          url: options.viewUrlForExecution(execution.ref, request),
          kind: 'v1',
          mediaType: 'image (legacy descriptor)',
          name: request.filename,
          ...(request.subfolder === undefined ? {} : { subfolder: request.subfolder }),
          ...(request.type === undefined ? {} : { fileType: request.type }),
        })
      }
      continue
    }
    for (const outputId of Object.keys(outputs).sort()) {
      for (const [descriptorIndex, ref] of imageAssetRefsInOrder(outputs[outputId]).entries()) {
        images.push({
          key: `${execution.key}:asset:${runtimeId}:${outputId}:${descriptorIndex}:${ref.digest}`,
          runtimeId,
          outputId,
          descriptorIndex,
          url: options.assetUrlForExecution(execution.ref, ref.digest),
          kind: 'asset',
          mediaType: ref.mediaType,
          digest: ref.digest,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        })
      }
    }
  }
  return images
}

export function executedImageLabel(image: ExecutedImage, index: number, total: number): string {
  const identity = image.name ?? image.digest ?? image.outputId
  return `Image ${index + 1} of ${total}, node ${image.runtimeId}, output ${image.outputId}, descriptor ${image.descriptorIndex + 1}, ${identity}`
}
