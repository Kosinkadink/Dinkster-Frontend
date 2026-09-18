/**
 * Peek-preview candidates: which (runtime node, output) pairs a scene node's
 * preview panel should try to render from a bound NATIVE execution via
 * GET /api/values renditions.
 *
 * Two sources, strict precedence:
 * - a node that ran in the bound execution shows its OWN recorded outputs
 *   (per-output summaries from node_finished/node_cached, or hydrated job
 *   result descriptors for target nodes) - never a neighbor's;
 * - a node with NO recorded presence in the run (newly added or rewired
 *   after it) falls back to its PRODUCERS: the same companion source map
 *   that powers propagated widget values names the (node, output) driving
 *   each input, so an Image Preview wired to a past run's output can render
 *   that output immediately, before ever executing.
 *
 * Inline scalars are excluded: they already display as companion values,
 * and a scalar type has no rendition to render. Document nodes resolve to
 * runtime ids through the view's occurrence mapping (`runtimeIdsOf`, same
 * rule as companion producers): nested views peek the navigated instance's
 * occurrences, and an unknown instance path abstains. Candidates carry the
 * RUNTIME id - /api/values wants it verbatim.
 *
 * peekCandidatesFor is pure derivation over store state - no fetching.
 * fetchPeekRendition is the candidate->bytes loop the host runs, kept here
 * (decode-free) so its transient-vs-definitive miss contract is testable.
 */

import { defaultRenditionOf } from '@dinkster/client'
import type { RenditionInfo, RenditionResult, ValuePeekResult, ValueQuery, ValueDescriptor, ValuePeekOptions, RenditionOptions } from '@dinkster/client'
import { parseAssetTypeId } from '@dinkster/core'
import type { CompanionSourceMap, NodeProgress, NodeSchema, TypeExpr } from '@dinkster/core'
import { isModel3dMime } from './model3d-mime.js'

/** Runtime identity of one output to peek (jobId comes from the execution). */
export interface PeekCandidate {
  readonly node: string
  readonly output: string
  readonly declaredIntent?: true
  readonly mediaKind?: 'image' | 'video' | 'audio' | 'model3d'
}

const mediaKindOfType = (type: TypeExpr): 'image' | 'video' | 'audio' | 'model3d' | undefined => {
  if (type.kind === 'list' || type.kind === 'asset') return mediaKindOfType(type.element)
  if (type.kind !== 'concrete') return undefined
  const name = type.name.toLowerCase()
  return name.endsWith('.video')
    ? 'video'
    : name.endsWith('.audio')
      ? 'audio'
      : name.endsWith('.image')
        ? 'image'
        // dinkster.splat renders through the model3d pipeline via its PLY rendition.
        : name.endsWith('.model3d') || name.endsWith('.splat') ? 'model3d' : undefined
}

/** Explicit final-output preview intent, preserving declaration order. */
export function declaredPreviewCandidates(
  schema: NodeSchema | undefined,
  runtimeIds: readonly string[],
): readonly PeekCandidate[] {
  if (schema === undefined) return []
  const outputs = schema.items.filter((item): item is Extract<NodeSchema['items'][number], { kind: 'output' }> =>
    item.kind === 'output' && item.preview === true)
  return runtimeIds.flatMap((node) => outputs.map((output) => {
    const mediaKind = mediaKindOfType(output.type)
    return { node, output: output.id, declaredIntent: true as const, ...(mediaKind === undefined ? {} : { mediaKind }) }
  }))
}

const renderableMime = (mime: string): boolean =>
  mime.startsWith('image/') || mime === 'video/mp4' || mime === 'video/webm' || mime === 'audio/wav' ||
  isModel3dMime(mime)

const definitiveStatus = (status: number): boolean => status === 404 || status === 406 || status === 410

const validMediaBytes = (mime: string, bytes: ArrayBuffer): boolean => {
  const b = new Uint8Array(bytes)
  if (mime === 'video/mp4') return b.length >= 8 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp'
  if (mime === 'video/webm') return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3
  if (mime === 'audio/wav') return b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WAVE'
  if (mime === 'model/gltf-binary') {
    return b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'glTF' &&
      b[4] === 2 && b[5] === 0 && b[6] === 0 && b[7] === 0
  }
  if (mime === 'model/ply') {
    // The magic line is "ply" plus a newline; Windows-written files use CRLF.
    return b.length >= 4 && String.fromCharCode(...b.slice(0, 3)) === 'ply' &&
      (b[3] === 0x0a || (b[3] === 0x0d && b[4] === 0x0a))
  }
  return true
}

/**
 * Budget for browser metadata validation across ONE whole candidate
 * sequence. The deadline is shared: candidates that never emit media
 * events cannot each wait a full timeout, so one preview row's total
 * validation wait never scales with candidate count.
 */
export const MEDIA_VALIDATION_BUDGET_MS = 10_000

/** Structural subset of DinksterValuesClient the loader needs (fakeable). */
export interface PeekValues {
  peek(query: ValueQuery, options?: ValuePeekOptions): Promise<ValuePeekResult>
  rendition(query: ValueQuery, kind: string, options?: RenditionOptions): Promise<RenditionResult>
}

export interface PeekImageBatch {
  readonly descriptor: ValueDescriptor
  readonly query: ValueQuery
  readonly rendition: RenditionInfo
  readonly count: number
}

export class ImageBatchUnsupportedError extends Error {
  readonly negativeCache = true
  constructor() { super('IMAGE batch preview unavailable: backend does not advertise the PNG batch parameter.') }
}

/** Only a declared IMAGE batch axis is pageable; list length is a separate axis. */
export function imageBatchCount(descriptor: ValueDescriptor): number | undefined {
  if (!/(?:^|\.)image$/i.test(parseAssetTypeId(descriptor.typeId) ?? descriptor.typeId)) return undefined
  const shape = descriptor.meta?.['shape']
  if (!Array.isArray(shape) || shape.length !== 4 || ![1, 2, 3, 4].includes(shape[3] as number)) return undefined
  return shape.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0) ? shape[0] as number : undefined
}

/**
 * Fetch the first renderable rendition among candidates, in order. Every
 * refusal is a structured outcome, so a miss is an exhausted loop, not an
 * exception from the client - the throw here carries `transient`:
 * - false (definitive): every candidate refused for a content reason
 *   (not-retained, evicted, scalar-only, no renditions...) - the host may
 *   negative-cache the source key;
 * - true: at least one candidate failed on transport ('http-error') - the
 *   host must NOT negative-cache; a later refresh retries.
 */
export async function fetchPeekRendition(
  values: PeekValues,
  jobId: string,
  candidates: readonly PeekCandidate[],
  validate?: (result: { readonly bytes: ArrayBuffer; readonly mime: string }, deadline?: number) => Promise<boolean>,
  options?: { readonly batchIndex?: number; readonly elementIndex?: number; readonly signal?: AbortSignal },
): Promise<{
  readonly bytes: ArrayBuffer
  readonly mime: string
  readonly node: string
  readonly output: string
  readonly count?: number
  readonly colorTransform?: string
  readonly previewOnly?: true
  readonly imageBatch?: PeekImageBatch
  readonly video?: { readonly query: ValueQuery; readonly descriptor: ValueDescriptor; readonly renditions: readonly RenditionInfo[]; readonly notice?: string }
  readonly audio?: { readonly descriptor: ValueDescriptor; readonly query: ValueQuery; readonly renditions: readonly RenditionInfo[] }
}> {
  let negativeCache = candidates.length > 0
  let videoNotice: string | undefined
  // One absolute deadline for ALL candidate validations, started when the
  // first validation begins (fetch time does not consume the budget).
  let validationDeadline: number | undefined
  for (const c of candidates) {
    options?.signal?.throwIfAborted()
    let query: ValueQuery = { jobId, nodeId: c.node, outputId: c.output }
    let peeked = await values.peek(query, options)
    if (!peeked.available) {
      if (!definitiveStatus(peeked.status)) negativeCache = false
      continue
    }
    const count = peeked.descriptor.length
    let depth = 0
    while (peeked.available && peeked.descriptor.length !== undefined && depth < 32) {
      if (peeked.descriptor.length === 0) {
        negativeCache = false
        break
      }
      query = { ...query, element: [...(query.element ?? []), depth === 0 ? options?.elementIndex ?? 0 : 0] }
      peeked = await values.peek(query, options)
      depth++
    }
    if (!peeked.available) {
      if (!definitiveStatus(peeked.status)) negativeCache = false
      continue
    }
    if (peeked.descriptor.length !== undefined) continue
    const imageCount = imageBatchCount(peeked.descriptor)
    const batchRenditions = peeked.renditions.filter((rendition) => rendition.kind === 'png' && rendition.mime === 'image/png' && rendition.parameters?.includes('batch'))
    if (imageCount !== undefined && imageCount > 1 && batchRenditions.length === 0) throw new ImageBatchUnsupportedError()
    const batchCount = batchRenditions.length > 0 ? imageCount : undefined
    const batchQuery = query
    const renditionOptions = {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(batchCount === undefined ? {} : { batch: Math.max(0, Math.min(options?.batchIndex ?? 0, batchCount - 1)) }),
    }
    const audio = c.mediaKind === 'audio' || /(?:^|\.)audio$/i.test(
      parseAssetTypeId(peeked.descriptor.typeId) ?? peeked.descriptor.typeId,
    )
    if (audio) return {
      bytes: new ArrayBuffer(0), mime: 'audio/wav', node: c.node, output: c.output,
      ...(count !== undefined ? { count } : {}),
      audio: { descriptor: peeked.descriptor, query, renditions: peeked.renditions },
    }
    const video = c.mediaKind === 'video' || /(?:^|\.)video$/i.test(
      parseAssetTypeId(peeked.descriptor.typeId) ?? peeked.descriptor.typeId,
    )
    // Original VIDEO bytes ignore lazy edits and may require an unbounded decode.
    const renditions = video
      ? ['preview', 'poster'].flatMap((kind) => peeked.renditions.filter((rendition) => rendition.kind === kind))
      : batchCount !== undefined
        ? batchRenditions
        : [defaultRenditionOf(peeked.renditions)].filter((rendition) => rendition !== undefined)
    if (renditions.length === 0 && !video) negativeCache = false
    if (video && renditions.length === 0) videoNotice = 'No bounded video preview or poster is advertised'
    let notice: string | undefined
    for (const info of renditions) {
      const { kind } = info
      if (batchCount !== undefined) {
        const shape = peeked.descriptor.meta!['shape'] as number[]
        const maxEdge = info.limits?.['maxEdge']
        const scale = maxEdge !== undefined && maxEdge > 0 ? Math.min(1, maxEdge / Math.max(shape[1]!, shape[2]!)) : 1
        if (Math.ceil(shape[1]! * scale) * Math.ceil(shape[2]! * scale) > 16 * 1024 * 1024) {
          throw Object.assign(new Error('Image exceeds the 16 megapixel preview budget'), { negativeCache: true })
        }
      }
      options?.signal?.throwIfAborted()
      const rendition = await values.rendition(query, kind, {
        ...renditionOptions,
        ...(info.version !== undefined ? { rendererVersion: info.version } : {}),
      })
      options?.signal?.throwIfAborted()
      if (!rendition.available) {
        if (!definitiveStatus(rendition.status)) negativeCache = false
        notice = `${kind}: ${rendition.error} (${rendition.status}, ${rendition.reason})`
        if (video) videoNotice = notice
        continue
      }
      if (batchCount !== undefined && rendition.bytes.byteLength > 64 * 1024 * 1024) throw Object.assign(new Error('Image exceeds the 64 MiB preview budget'), { negativeCache: true })
      if (!renderableMime(rendition.mime) || !validMediaBytes(rendition.mime, rendition.bytes)) {
        negativeCache = false
        continue
      }
      if (validate !== undefined) {
        validationDeadline ??= Date.now() + MEDIA_VALIDATION_BUDGET_MS
        if (!await validate(rendition, validationDeadline)) {
          negativeCache = false
          continue
        }
      }
      return {
        bytes: rendition.bytes,
        mime: rendition.mime,
        node: c.node,
        output: c.output,
        ...(batchCount !== undefined ? { count: batchCount, imageBatch: { descriptor: peeked.descriptor, query: batchQuery, rendition: info, count: batchCount } } : count !== undefined ? { count } : {}),
        ...(rendition.colorTransform !== undefined ? { colorTransform: rendition.colorTransform } : {}),
        ...(video ? { previewOnly: true as const } : {}),
        ...(video ? { video: { query, descriptor: peeked.descriptor, renditions: peeked.renditions, ...(notice === undefined ? {} : { notice }) } } : {}),
      }
    }
  }
  throw Object.assign(new Error(videoNotice ?? 'no renderable output'), { transient: !negativeCache, negativeCache, videoNotice })
}

/** An inline scalar summary/descriptor renders as a companion, not imagery. */
const hasInlineScalar = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) return false
  const value = (v as { value?: unknown }).value
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export function peekCandidatesFor(args: {
  /** Companion sources of the CURRENT graph (deriveCompanions output). */
  readonly sources: CompanionSourceMap
  /** Bound execution's per-node progress (runtime node id keyed). */
  readonly execNodes: Readonly<Record<string, NodeProgress>> | undefined
  /** Bound execution's hydrated job-result outputs (target nodes only). */
  readonly execOutputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined
  readonly nodeId: string
  /**
   * Runtime ids a document node of the CURRENT view owns (occurrence
   * mapping). Undefined = unknown instance path: abstain.
   */
  readonly runtimeIdsOf: ((nodeId: string) => readonly string[]) | undefined
  /** Runtime region id -> visible output id -> backend state-port output id. */
  readonly outputAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Schema/interface output order. Unknown output ids follow in event order. */
  readonly outputOrder?: readonly string[]
}): readonly PeekCandidate[] {
  const resolve = args.runtimeIdsOf
  if (!resolve) return []
  const { nodeId } = args

  // Own outputs win: union of event summaries and hydrated descriptors,
  // across every runtime occurrence the node owns in this view.
  const ownIds = resolve(nodeId)
  const out: PeekCandidate[] = []
  let ran = false
  for (const rid of ownIds) {
    if (args.execNodes?.[rid] !== undefined) ran = true
    const own = new Map<string, unknown>()
    for (const [id, d] of Object.entries(args.execOutputs?.[rid] ?? {})) own.set(id, d)
    for (const [id, s] of Object.entries(args.execNodes?.[rid]?.outputs ?? {})) own.set(id, s)
    if (own.size > 0) ran = true
    const order = new Map((args.outputOrder ?? []).map((id, index) => [args.outputAliases?.[rid]?.[id] ?? id, index]))
    out.push(...[...own.entries()]
      .filter(([, v]) => !hasInlineScalar(v))
      .map(([output], eventIndex) => ({ node: rid, output, eventIndex }))
      .sort((a, b) => args.outputOrder === undefined
        ? a.output.localeCompare(b.output)
        : (order.get(a.output) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.output) ?? Number.MAX_SAFE_INTEGER) || a.eventIndex - b.eventIndex)
      .map(({ node, output }) => ({ node, output })))
  }
  // The node ran (or has recorded outputs): its own imagery or nothing.
  if (ran) return out

  // Producer fallback: inputs driven by nodes that DID run in this execution.
  const seen = new Set<string>()
  const ports = args.sources.get(nodeId)
  if (!ports) return out
  for (const [, source] of [...ports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (source.kind !== 'producer') continue
    for (const rid of resolve(source.node)) {
      const output = args.outputAliases?.[rid]?.[source.output] ?? source.output
      const produced =
        args.execNodes?.[rid]?.outputs?.[output] ?? args.execOutputs?.[rid]?.[output]
      if (produced === undefined || hasInlineScalar(produced)) continue
      const key = `${rid}\u0000${output}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ node: rid, output })
    }
  }
  return out
}
