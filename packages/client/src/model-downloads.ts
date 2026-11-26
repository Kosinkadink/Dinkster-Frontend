import type { AssetRef, Json } from '@dinkster/core'

export interface ModelRequirement {
  readonly name: string
  readonly kind: string
}

export interface ModelDownloadRequirement extends ModelRequirement {
  readonly asset?: AssetRef
}

export class ModelDownloadBusyError extends Error {
  constructor() { super('The engine is busy downloading another model.') }
}

export type ModelPresence = ModelRequirement & (
  | { readonly status: 'local' | 'model-hidden' | 'duplicate' }
  | { readonly status: 'folder-disabled'; readonly disabledLocations: readonly string[] }
  | { readonly status: 'missing'; readonly plannable: boolean }
)

export interface ModelDownloadSelection extends ModelRequirement {
  readonly digest?: string
  readonly project: string
  readonly provider: 'huggingface' | 'civitai'
  readonly source: string
  readonly repo: string
  readonly revision: string
  readonly file: string
  readonly sha256: string
  readonly size: number
  readonly license: string
  readonly destination: string
  readonly mount: string
}

export type ModelDownloadSpace =
  | { readonly status: 'available'; readonly filesystem: string; readonly freeBytes: number }
  | { readonly status: 'unavailable' }

export type ModelDownloadPlan =
  | (ModelDownloadSelection & { readonly status: 'consent-required'; readonly planId: string
      readonly destinationSpace?: ModelDownloadSpace })
  | (ModelRequirement & { readonly status: 'local' })
  | { readonly status: 'folder-disabled'; readonly disabledLocations: readonly string[]; readonly detail: string }
  | { readonly status: 'picker-required'; readonly sources: readonly string[] }
  | { readonly status: 'destination-required' }
  | { readonly status: 'credential-required' | 'provider-grant-required' | 'civitai-access-required'
      readonly provider?: 'huggingface' | 'civitai'
      readonly source?: string }
  | { readonly status: 'model-hidden' | 'duplicate' }

export type ModelDownloadPhase = 'starting' | 'checking-existing' | 'downloading' | 'verifying' |
  'publishing' | 'indexing' | 'cancelling' | 'cancelled' | 'completed' | 'failed'

export interface ModelDownloadJob extends ModelDownloadSelection {
  readonly jobId: string
  readonly status: ModelDownloadPhase
  readonly received: number
  readonly error?: string
  readonly path?: string
  readonly reused?: boolean
  readonly renamed?: boolean
  readonly indexingPending?: boolean
  readonly asset?: Readonly<Record<string, Json>>
}

function record(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Malformed model download response')
  return raw as Record<string, unknown>
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Malformed model download ${key}`)
  return value
}

function count(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Malformed model download ${key}`)
  return value
}

function strings(row: Record<string, unknown>, key: string): readonly string[] {
  const value = row[key]
  if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string')) throw new Error(`Malformed model download ${key}`)
  return value as string[]
}

export function decodeModelPresence(raw: unknown, requested: readonly ModelRequirement[]): readonly ModelPresence[] {
  const rows = record(raw)['models']
  if (!Array.isArray(rows) || rows.length !== requested.length) throw new Error('Malformed model presence response')
  return requested.map((requirement, index) => {
    const row = record(rows[index])
    if (row['name'] !== requirement.name || row['kind'] !== requirement.kind) throw new Error('Mismatched model presence response')
    switch (row['status']) {
      case 'local':
      case 'model-hidden':
      case 'duplicate': return { ...requirement, status: row['status'] }
      case 'folder-disabled': return { ...requirement, status: 'folder-disabled', disabledLocations: strings(row, 'disabledLocations') }
      case 'missing':
        if (typeof row['plannable'] === 'boolean') return { ...requirement, status: 'missing', plannable: row['plannable'] }
        break
    }
    throw new Error('Malformed model presence status')
  })
}

function selection(row: Record<string, unknown>): ModelDownloadSelection {
  const provider = row['provider']
  if ((provider !== 'huggingface' && provider !== 'civitai') || !/^[a-f0-9]{64}$/.test(text(row, 'sha256')) ||
    !(provider === 'civitai' ? /^[1-9][0-9]*$/ : /^[a-f0-9]{40}$/).test(text(row, 'revision'))) throw new Error('Malformed immutable model selection')
  if (row['digest'] !== undefined && !/^blake3:[a-f0-9]{64}$/.test(text(row, 'digest')))
    throw new Error('Malformed exact model identity')
  return {
    name: text(row, 'name'), kind: text(row, 'kind'), project: text(row, 'project'),
    ...(row['digest'] === undefined ? {} : { digest: text(row, 'digest') }),
    provider, source: text(row, 'source'), repo: text(row, 'repo'),
    revision: text(row, 'revision'), file: text(row, 'file'), sha256: text(row, 'sha256'),
    size: count(row, 'size'), license: text(row, 'license'),
    destination: text(row, 'destination'), mount: text(row, 'mount'),
  }
}

export function decodeModelDownloadPlan(raw: unknown): ModelDownloadPlan {
  const row = record(raw)
  switch (row['status']) {
    case 'consent-required': {
      let destinationSpace: ModelDownloadSpace | undefined
      if (row['destinationSpace'] !== undefined) {
        const space = record(row['destinationSpace'])
        switch (space['status']) {
          case 'available': destinationSpace = { status: 'available',
            filesystem: text(space, 'filesystem'), freeBytes: count(space, 'freeBytes') }; break
          case 'unavailable': destinationSpace = { status: 'unavailable' }; break
          default: throw new Error('Malformed model download destination space')
        }
      }
      return { ...selection(row), status: 'consent-required', planId: text(row, 'planId'),
        ...(destinationSpace === undefined ? {} : { destinationSpace }),
      }
    }
    case 'local': return { status: 'local', name: text(row, 'name'), kind: text(row, 'kind') }
    case 'folder-disabled': return { status: 'folder-disabled', disabledLocations: strings(row, 'disabledLocations'), detail: text(row, 'detail') }
    case 'picker-required': return { status: 'picker-required', sources: strings(row, 'sources') }
    case 'destination-required': return { status: 'destination-required' }
    case 'credential-required':
    case 'provider-grant-required':
    case 'civitai-access-required': {
      const provider = row['provider']
      if (provider !== undefined && provider !== 'huggingface' && provider !== 'civitai')
        throw new Error('Malformed model download provider')
      return { status: row['status'],
        ...(provider === undefined ? {} : { provider }),
        ...(row['source'] === undefined ? {} : { source: text(row, 'source') }),
      }
    }
    case 'model-hidden':
    case 'duplicate': return { status: row['status'] }
    default: throw new Error('Unknown model download plan state')
  }
}

const phases: readonly string[] = ['starting', 'checking-existing', 'downloading', 'verifying',
  'publishing', 'indexing', 'cancelling', 'cancelled', 'completed', 'failed']

export function decodeModelDownloadJob(raw: unknown): ModelDownloadJob {
  const row = record(raw)
  const status = text(row, 'status')
  if (!phases.includes(status)) throw new Error('Unknown model download phase')
  const selected = selection(row)
  const received = count(row, 'received')
  if (received > selected.size) throw new Error('Model download progress exceeds size')
  const job: ModelDownloadJob = {
    ...selected, jobId: text(row, 'jobId'), status: status as ModelDownloadPhase, received,
    ...(row['error'] !== undefined ? { error: text(row, 'error') } : {}),
    ...(row['path'] !== undefined ? { path: text(row, 'path') } : {}),
  }
  for (const key of ['reused', 'renamed', 'indexingPending'] as const) {
    if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new Error(`Malformed model download ${key}`)
  }
  if (status === 'completed') {
    const asset = record(row['asset'])
    if (!/^blake3:[a-f0-9]{64}$/.test(text(asset, 'digest')) ||
      (selected.digest !== undefined && asset['digest'] !== selected.digest) ||
      count(asset, 'size') !== selected.size || typeof row['reused'] !== 'boolean' ||
      typeof row['renamed'] !== 'boolean') throw new Error('Malformed verified model result')
    return { ...job, path: text(row, 'path'), reused: row['reused'], renamed: row['renamed'],
      ...(row['indexingPending'] === true ? { indexingPending: true } : {}),
      asset: { digest: text(asset, 'digest'), name: text(asset, 'name'), size: count(asset, 'size'),
        mediaType: text(asset, 'mediaType'), virtualPath: text(asset, 'virtualPath') } }
  }
  return job
}

export function decodeModelDownloadJobs(raw: unknown): { readonly instance: string; readonly jobs: readonly ModelDownloadJob[] } {
  const row = record(raw)
  if (!Array.isArray(row['jobs'])) throw new Error('Malformed model download jobs')
  return { instance: text(row, 'instance'), jobs: row['jobs'].map(decodeModelDownloadJob) }
}
