import { defaultRenditionOf, type ExecutionState, type RenditionResult, type ValueDescriptor } from '@dinkster/client'
import { parseAssetTypeId } from '@dinkster/core'
import { imageBatchCount, type PeekValues } from './peek-preview.js'

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
  readonly kind: 'asset' | 'rendition'
  readonly mediaType: string
  readonly descriptor?: ValueDescriptor
  readonly listPath?: readonly number[]
  readonly batchIndex?: number
  readonly load?: (signal: AbortSignal) => Promise<RenditionResult>
  readonly name?: string
  readonly digest?: string
  readonly virtualPath?: string
}

interface ImageAssetRef {
  readonly digest: string
  readonly mediaType: string
  readonly name?: string
  readonly virtualPath?: string
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
      (typeId === 'ASSET' || parseAssetTypeId(typeId) !== undefined) &&
      digest !== undefined && CAS_DIGEST.test(digest) && mediaType?.startsWith('image/') === true
    ) {
      const name = typeof meta?.['name'] === 'string' ? meta['name'] : undefined
      const virtualPath = typeof meta?.['virtualPath'] === 'string' ? meta['virtualPath'] : undefined
      refs.push({ digest, mediaType, ...(name === undefined ? {} : { name }), ...(virtualPath === undefined ? {} : { virtualPath }) })
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
    readonly assetUrlForExecution: (ref: ExecutionState['ref'], digest: string) => string
    readonly values?: PeekValues | undefined
  },
): readonly ExecutedImage[] {
  const allowed = options.runtimeIds === undefined ? undefined : new Set(options.runtimeIds)
  const images: ExecutedImage[] = []
  for (const runtimeId of Object.keys(execution.outputs).sort()) {
    if (allowed !== undefined && !allowed.has(runtimeId)) continue
    const outputs = execution.outputs[runtimeId]!
    for (const outputId of Object.keys(outputs).sort()) {
      const descriptor = outputs[outputId] as ValueDescriptor | undefined
      const count = descriptor?.typeId === 'IMAGE' ? imageBatchCount(descriptor) : undefined
      const values = options.values
      if (count !== undefined && values !== undefined) {
        const query = { jobId: execution.ref.prompt, nodeId: runtimeId, outputId }
        for (let batchIndex = 0; batchIndex < count; batchIndex++) images.push({
          key: `${execution.key}:rendition:${runtimeId}:${outputId}:${batchIndex}`,
          runtimeId, outputId, descriptorIndex: 0, batchIndex,
          url: '', kind: 'rendition', mediaType: 'image/png',
          load: async (signal) => {
            const peek = await values.peek(query, { signal })
            if (!peek.available) return peek
            const rendition = defaultRenditionOf(peek.renditions.filter((item) =>
              item.mime === 'image/png' && (count === 1 || item.parameters?.includes('batch') === true)))
            if (rendition === undefined) return {
              available: false, status: 406, reason: 'no-rendition', error: 'No PNG rendition supports this image batch.',
            }
            return values.rendition(query, rendition.kind, {
              signal,
              ...(rendition.parameters?.includes('batch') === true ? { batch: batchIndex } : {}),
              ...(rendition.version === undefined ? {} : { rendererVersion: rendition.version }),
            })
          },
        })
      }
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
          ...(ref.virtualPath === undefined ? {} : { virtualPath: ref.virtualPath }),
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
