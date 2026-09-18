import {
  isImageAssetInput,
  MAX_MASK_PAINT_COMMANDS,
  MAX_MASK_PAINT_JSON_BYTES,
  MAX_MASK_PAINT_STROKE_POINTS,
  MAX_MASK_PAINT_TOTAL_POINTS,
  parseMaskPaintRecipe,
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

function maskPaintCommands(operations: readonly MaskEditOperation[]): readonly Record<string, unknown>[] {
  let totalPoints = 0
  if (operations.length > MAX_MASK_PAINT_COMMANDS) throw new Error(`Mask edits exceed ${MAX_MASK_PAINT_COMMANDS} commands`)
  return operations.map((operation) => {
    if (operation.kind === 'mask.clear') return { op: 'clear' }
    if (operation.kind === 'mask.invert') return { op: 'invert' }
    if (operation.points.length < 1 || operation.points.length > MAX_MASK_PAINT_STROKE_POINTS) {
      throw new Error(`A mask stroke must contain 1 to ${MAX_MASK_PAINT_STROKE_POINTS} points`)
    }
    totalPoints += operation.points.length
    if (totalPoints > MAX_MASK_PAINT_TOTAL_POINTS) throw new Error(`Mask edits exceed ${MAX_MASK_PAINT_TOTAL_POINTS} points`)
    return {
      op: 'stroke', mode: operation.mode, size: operation.size, hardness: operation.hardness,
      points: operation.points.map(({ x, y, pressure }) => ({ x, y, pressure })),
    }
  })
}

export function maskPaintOperationsJson(session: ImageSession, sourceDigest: string): string {
  const value = JSON.stringify({
    version: 1,
    sourceDigest,
    width: session.source.width,
    height: session.source.height,
    commands: maskPaintCommands(session.operations.slice(0, session.index + 1)),
  })
  if (new TextEncoder().encode(value).length > MAX_MASK_PAINT_JSON_BYTES) throw new Error('Mask edits exceed 4 MiB')
  return value
}

export function restoreMaskPaintSession(base: ImageSession, value: string, sourceDigest: string): ImageSession {
  const raw = parseMaskPaintRecipe(value)
  if (!raw || raw.sourceDigest !== sourceDigest || raw.width !== base.source.width || raw.height !== base.source.height) {
    throw new Error('Existing mask operations do not match this source')
  }
  const operations: MaskEditOperation[] = []
  for (const command of raw.commands) {
    if (command.op === 'clear' || command.op === 'invert') {
      operations.push({ kind: command.op === 'clear' ? 'mask.clear' : 'mask.invert' })
      continue
    }
    const points = command.points.map((point, index) => {
      return { x: point.x, y: point.y, pressure: point.pressure, time: index, tiltX: 0, tiltY: 0, twist: 0 }
    })
    operations.push({ kind: 'mask.stroke', mode: command.mode, size: command.size, hardness: command.hardness, points })
  }
  return { ...base, operations, index: operations.length - 1 }
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
