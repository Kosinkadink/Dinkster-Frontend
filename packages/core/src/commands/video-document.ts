import type { Diagnostic } from '../diagnostics.js'
import type { Json, JsonObject } from '../format/document.js'
import { ownJson } from '../format/json.js'
import { applyOps, invertOps, type PatchOp } from './patch.js'
import type { DocumentTypeAdapter } from './document-type.js'

export interface VideoDocument extends JsonObject {
  readonly version: 1
  readonly sources: JsonObject
  readonly settings: JsonObject & {
    readonly width: number
    readonly height: number
    readonly rate: number
  }
  readonly timeline: JsonObject
}

const videoProblem = (message: string): Diagnostic => ({
  severity: 'error',
  origin: 'validation',
  code: 'video.document.invalid',
  message,
})

const record = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined

function checkTimelineItem(
  value: unknown,
  depth: number,
  budget: { count: number },
): string | undefined {
  const item = record(value)
  if (item === undefined) return 'timeline items must be objects'
  budget.count += 1
  if (depth > 16 || budget.count > 4096)
    return 'timeline exceeds the nesting or item limit'
  const schema = item['OTIO_SCHEMA']
  if (
    typeof schema !== 'string' ||
    ![
      'Timeline.1',
      'Stack.1',
      'Track.1',
      'Clip.1',
      'Clip.2',
      'Gap.1',
      'Transition.1',
    ].includes(schema)
  )
    return 'timeline contains an unsupported OTIO schema'
  const kind = schema.split('.', 1)[0]
  if (kind === 'Timeline')
    return checkTimelineItem(item['tracks'], depth + 1, budget)
  if (kind !== 'Stack' && kind !== 'Track') return undefined
  if (
    kind === 'Track' &&
    item['kind'] !== 'Video' &&
    item['kind'] !== 'Audio'
  ) {
    return 'track kind must be Video or Audio'
  }
  const children = item['children']
  if (!Array.isArray(children))
    return 'timeline compositions require a children array'
  for (const child of children) {
    const problem = checkTimelineItem(child, depth + 1, budget)
    if (problem !== undefined) return problem
  }
  return undefined
}

export function checkVideoDocument(
  document: VideoDocument,
): readonly Diagnostic[] {
  const root = record(document)
  if (
    root === undefined ||
    Object.keys(root).sort().join(',') !== 'settings,sources,timeline,version'
  ) {
    return [videoProblem('expected version, sources, settings, and timeline')]
  }
  if (root['version'] !== 1)
    return [videoProblem('expected document version 1')]
  const sources = record(root['sources'])
  if (sources === undefined || Object.keys(sources).length > 256)
    return [videoProblem('sources must be an object with at most 256 entries')]
  const settings = record(root['settings'])
  if (
    settings === undefined ||
    Object.keys(settings).sort().join(',') !== 'height,rate,width'
  ) {
    return [videoProblem('settings must contain width, height, and rate')]
  }
  const width = settings['width']
  const height = settings['height']
  const rate = settings['rate']
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) < 1 ||
    (height as number) < 1 ||
    (width as number) > 8192 ||
    (height as number) > 8192
  ) {
    return [
      videoProblem('video dimensions must be integers from 1 through 8192'),
    ]
  }
  if (
    typeof rate !== 'number' ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > 240
  ) {
    return [videoProblem('video rate must be in (0, 240]')]
  }
  const timeline = record(root['timeline'])
  if (timeline?.['OTIO_SCHEMA'] !== 'Timeline.1')
    return [videoProblem('timeline must have a Timeline.1 root')]
  const timelineProblem = checkTimelineItem(timeline, 0, { count: 0 })
  return timelineProblem === undefined ? [] : [videoProblem(timelineProblem)]
}

export function loadVideoDocument(value: unknown): {
  readonly document?: VideoDocument
  readonly diagnostics: readonly Diagnostic[]
} {
  const owned = ownJson(value)
  if (!owned.ok) return { diagnostics: [videoProblem(owned.reason)] }
  if (
    new TextEncoder().encode(JSON.stringify(owned.value)).byteLength >=
    1024 * 1024
  ) {
    return { diagnostics: [videoProblem('document must be below 1 MiB')] }
  }
  const document = owned.value as VideoDocument
  const diagnostics = checkVideoDocument(document)
  return diagnostics.length === 0 ? { document, diagnostics } : { diagnostics }
}

export function createVideoDocument(name = 'Timeline'): VideoDocument {
  const loaded = loadVideoDocument({
    version: 1,
    sources: {},
    settings: { width: 1280, height: 720, rate: 24 },
    timeline: {
      OTIO_SCHEMA: 'Timeline.1',
      name,
      metadata: {},
      global_start_time: null,
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        name: 'tracks',
        metadata: {},
        source_range: null,
        effects: [],
        markers: [],
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            name: 'Video',
            kind: 'Video',
            children: [],
            source_range: null,
            effects: [],
            markers: [],
            metadata: {},
          },
        ],
      },
    },
  })
  if (loaded.document === undefined)
    throw new Error('internal video document did not validate')
  return loaded.document
}

export const videoDocumentTypeAdapter: DocumentTypeAdapter<VideoDocument> = {
  kind: 'dinkster.video',
  commandIds: new Set(['video.document.replace']),
  load: loadVideoDocument,
  check: checkVideoDocument,
  execute(document, invocation) {
    if (invocation.command !== 'video.document.replace') {
      return {
        ok: false,
        diagnostics: [
          videoProblem(`unknown video command '${invocation.command}'`),
        ],
      }
    }
    const params = record(invocation.params)
    const loaded = loadVideoDocument(params?.['document'])
    if (loaded.document === undefined)
      return { ok: false, diagnostics: loaded.diagnostics }
    const keys = ['version', 'sources', 'settings', 'timeline'] as const
    const forward: PatchOp[] = keys.flatMap((key): PatchOp[] =>
      JSON.stringify(document[key]) === JSON.stringify(loaded.document![key])
        ? []
        : [
            {
              op: 'replace',
              path: [key],
              oldValue: document[key] as Json,
              value: loaded.document![key] as Json,
            },
          ],
    )
    return {
      ok: true,
      doc: applyOps(document, forward) as VideoDocument,
      forward,
      inverse: invertOps(forward),
      diagnostics: [],
    }
  },
}
