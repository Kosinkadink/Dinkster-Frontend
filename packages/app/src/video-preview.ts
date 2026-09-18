import type { NodePreview } from '@dinkster/canvas'
import type { DinksterValuesClient, RenditionOptions, RenditionResult } from '@dinkster/client'
import type { NodeViewState } from '@dinkster/core'
import { fetchPeekRendition, type PeekCandidate } from './peek-preview.js'

export type VideoPreferences = NonNullable<NodeViewState['video']>
export const DEFAULT_VIDEO_PREFERENCES: VideoPreferences = { loop: true, muted: true, autoplay: true }

type PeekMedia = Awaited<ReturnType<typeof fetchPeekRendition>>
export interface VideoInspection {
  readonly duration?: number
  readonly fps?: number
  readonly frameCount?: number
  readonly frameCountKind?: string
  readonly notice?: string
  readonly index: number
  readonly count: number
  readonly canSelectFrame: boolean
  readonly thumbnailCount?: number
  request(kind: 'frame' | 'thumbs', options: RenditionOptions): Promise<RenditionResult>
  select(index: number, signal?: AbortSignal): Promise<PeekMedia & { readonly inspection: VideoInspection }>
}

export type VideoNodePreview = NodePreview & { readonly videoInspection?: VideoInspection }
export const videoInspectionOf = (preview: NodePreview): VideoInspection | undefined =>
  (preview as VideoNodePreview).videoInspection

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

export function videoTiming(meta: Readonly<Record<string, unknown>> | undefined): {
  readonly duration?: number; readonly fps?: number; readonly frameCount?: number; readonly frameCountKind?: string
} {
  const effective = meta?.effective
  if (typeof effective !== 'object' || effective === null || Array.isArray(effective)) return {}
  const fields = effective as Record<string, unknown>
  const rational = (value: unknown): number | undefined => {
    if (!Array.isArray(value) || value.length !== 2) return undefined
    const n = positive(value[0]), d = positive(value[1])
    return n === undefined || d === undefined ? undefined : positive(n / d)
  }
  const duration = rational(fields.duration), fps = rational(fields.fps)
  const count = positive(fields.frame_count)
  return {
    ...(duration === undefined ? {} : { duration }),
    ...(fps === undefined ? {} : { fps }),
    ...(count === undefined || !Number.isSafeInteger(count) ? {} : { frameCount: count }),
    ...(typeof fields.frame_count_kind === 'string' && fields.frame_count_kind.length > 0
      ? { frameCountKind: fields.frame_count_kind } : {}),
  }
}

/** Retain the job's selectors, not original asset URLs, for every inspection. */
export async function videoInspectionFor(
  initial: PeekMedia,
  values: DinksterValuesClient,
  candidates: readonly PeekCandidate[],
  validate?: Parameters<typeof fetchPeekRendition>[3],
  signal?: AbortSignal,
): Promise<VideoInspection | undefined> {
  if (initial.video === undefined) return undefined
  signal?.throwIfAborted()
  const jobId = initial.video.query.jobId
  const videoCandidates = candidates.filter((candidate) => candidate.mediaKind === 'video' ||
    (candidate.node === initial.node && candidate.output === initial.output))
  const entries = await Promise.all(videoCandidates.map(async (candidate) => {
    const peek = await values.peek({ jobId, nodeId: candidate.node, outputId: candidate.output },
      signal === undefined ? undefined : { signal })
    return { candidate, count: peek.available ? peek.descriptor.length ?? 1 : 1 }
  }))
  signal?.throwIfAborted()
  const count = entries.reduce((sum, entry) => sum + entry.count, 0)
  const make = (result: PeekMedia, index: number): VideoInspection => {
    const capability = (kind: 'frame' | 'thumbs') => result.video?.renditions.find(
      (rendition) => rendition.kind === kind && rendition.parameters?.includes(kind) === true,
    )
    const thumbs = capability('thumbs')
    const defaultCount = Number(thumbs?.defaults?.['thumbs'])
    const limit = thumbs?.limits?.['maxCount'] ?? defaultCount
    const thumbnailCount = Number.isSafeInteger(defaultCount) && defaultCount > 0 && Number.isSafeInteger(limit) && limit > 0
      ? Math.min(defaultCount, limit) : undefined
    return {
      ...videoTiming(result.video?.descriptor.meta),
      ...(result.video?.notice === undefined ? {} : { notice: result.video.notice }),
      index, count,
      canSelectFrame: capability('frame') !== undefined,
      ...(thumbnailCount === undefined ? {} : { thumbnailCount }),
      request: (kind, options) => {
        const info = capability(kind)
        if (result.video === undefined || info === undefined) {
          return Promise.resolve({ available: false, status: 406, reason: 'unadvertised-rendition', error: `${kind} selector is not advertised` })
        }
        return values.rendition(result.video.query, kind, {
          ...options, ...(info.version === undefined ? {} : { rendererVersion: info.version }),
        })
      },
      select: async (selected, signal) => {
        if (!Number.isSafeInteger(selected) || selected < 0 || selected >= count) throw new Error('Video selection is out of range')
        let offset = selected
        for (const entry of entries) {
          if (offset < entry.count) {
            const result = await fetchPeekRendition(values, jobId, [entry.candidate], validate, {
              elementIndex: offset, ...(signal === undefined ? {} : { signal }),
            })
            return { ...result, inspection: make(result, selected) }
          }
          offset -= entry.count
        }
        throw new Error('Video selection unavailable')
      },
    }
  }
  let index = 0
  for (const entry of entries) {
    if (entry.candidate.node === initial.node && entry.candidate.output === initial.output) break
    index += entry.count
  }
  return make(initial, index)
}
