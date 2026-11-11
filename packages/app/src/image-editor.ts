import {
  isImageAssetInput,
  type AssetRef,
  type NodeSchema,
} from '@dinkster/core'
import { projectMask, type MaskEditOperation } from './image-mask-tool.js'
import type { ImageRaster } from './image-png.js'

export interface ImageInputCandidate {
  readonly nodeId: string
  readonly inputId: string
  readonly sourceRef: AssetRef
}

export interface ImageSession {
  readonly source: ImageRaster
  readonly operations: readonly MaskEditOperation[]
  readonly index: number
}

export function isAssetRef(value: unknown): value is AssetRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ref = value as Partial<AssetRef>
  return Object.keys(value).length === 5 && /^blake3:[0-9a-f]{64}$/.test(ref.digest ?? '') &&
    typeof ref.name === 'string' && Number.isSafeInteger(ref.size) && (ref.size ?? -1) >= 0 &&
    typeof ref.mediaType === 'string' && typeof ref.virtualPath === 'string'
}

export function imageInputCandidates(args: {
  readonly schema: NodeSchema | undefined
  readonly nodeId: string
  readonly values: Readonly<Record<string, unknown>>
  readonly drivenInputIds?: ReadonlySet<string>
}): readonly ImageInputCandidate[] {
  if (!args.schema) return []
  return args.schema.items.flatMap((item): ImageInputCandidate[] => {
    if (item.kind !== 'input' || !isImageAssetInput(item) || args.drivenInputIds?.has(item.id)) return []
    const value = args.values[item.id]
    return isAssetRef(value) && value.mediaType === 'image/png'
      ? [{ nodeId: args.nodeId, inputId: item.id, sourceRef: value }]
      : []
  })
}

export const createImageSession = (source: ImageRaster): ImageSession => ({
  source,
  operations: [],
  index: -1,
})

export function appendImageEditOperation(session: ImageSession, operation: MaskEditOperation): ImageSession {
  const operations = [...session.operations.slice(0, session.index + 1), operation]
  return { ...session, operations, index: operations.length - 1 }
}

export const undoImageEdit = (session: ImageSession): ImageSession =>
  session.index >= 0 ? { ...session, index: session.index - 1 } : session

export const redoImageEdit = (session: ImageSession): ImageSession =>
  session.index + 1 < session.operations.length ? { ...session, index: session.index + 1 } : session

export const projectImageMask = (session: ImageSession): Uint8ClampedArray =>
  projectMask(session.source.rgba, session.source.width, session.source.height, session.operations.slice(0, session.index + 1))
