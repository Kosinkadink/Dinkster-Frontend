/**
 * The app's built-in collection sources, in the common CollectionSource
 * vocabulary (packs today, execution history alongside; templates/assets
 * arrive with their backend surfaces). Sources are LIVE - each derives a
 * fresh corpus per page request from state the app already holds - and
 * query ranking goes through the shared scorer via localCollectionSource,
 * so searching here behaves exactly like the palette.
 */

import {
  formatDate,
  localCollectionSource,
  type CollectionEntry,
  type CollectionSource,
} from '@dinkster/core'
import { HISTORY_STATES, type ExecutionState, type HistoryRunRecord, type LibraryRecord, type TemplateDescriptor } from '@dinkster/client'
import { LIBRARY_SCOPE, WORKFLOW_LABEL, type AppState, type Backend } from './app-state.js'
import { runAttributionLabel, type RunAttribution } from './run-attribution.js'
import { RemoteTemplateCatalog, type RemoteTemplateDescriptor } from './template-catalog.js'

const COLLECTION_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
}

export const formatCollectionDate = (value: number): string => formatDate(value, COLLECTION_DATE_OPTIONS)

/**
 * Bind a remote page cursor to the backend that minted it. A keyset cursor
 * is only meaningful against the exact server that served the previous
 * page; the library backend follows the ACTIVE tab, so a continuation
 * clicked after a tab switch could otherwise hand backend A's cursor to
 * backend B. Decoding a cursor owned by another backend throws - the
 * browser keeps its loaded items and drops the continuation (its refresh
 * tick re-pages from the new backend) - instead of serving a foreign or
 * mixed-backend page.
 */
const encodeOwnedCursor = (owner: string, cursor: string | undefined): string | undefined =>
  cursor !== undefined ? JSON.stringify([owner, cursor]) : undefined

const decodeOwnedCursor = (owner: string, cursor: string | undefined): string | undefined => {
  if (cursor === undefined) return undefined
  const [minted, raw] = JSON.parse(cursor) as [string, string]
  if (minted !== owner) throw new Error('collection continuation belongs to another backend')
  return raw
}

/**
 * Derived-initials fallback for entries without a thumbnail: first letters
 * of the first two words ('Video Helper Suite' -> 'VH'), or the first two
 * characters of a single word. Presentation derivation is deliberately
 * frontend-owned (the backend never synthesizes presentation).
 */
export function initialsOf(title: string): string {
  const parts = title.split(/[\s._-]+/).filter((w) => w.length > 0)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

/**
 * Persisted list/grid mode for a collection surface. Each surface passes
 * its own storage key so preference scope is a host decision (the asset
 * picker deliberately shares one global key across all its embeddings).
 * The legacy asset-browser value 'tile' reads as 'grid' so a stored
 * preference survives the surface unification.
 */
export type CollectionViewMode = 'grid' | 'list'

/**
 * Accessing the localStorage GLOBAL can itself throw (storage-blocked or
 * opaque-origin contexts raise SecurityError from the property getter, so
 * the getItem/setItem try/catches below are never reached). An
 * inaccessible store reads as absent.
 */
export function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function readCollectionViewMode(
  storage: Pick<Storage, 'getItem'> | undefined,
  key: string,
  fallback: CollectionViewMode,
): CollectionViewMode {
  try {
    const value = storage?.getItem(key)
    if (value === 'grid' || value === 'list') return value
    return value === 'tile' ? 'grid' : fallback
  } catch {
    return fallback
  }
}

export function writeCollectionViewMode(
  storage: Pick<Storage, 'setItem'> | undefined,
  key: string,
  mode: CollectionViewMode,
): void {
  try {
    storage?.setItem(key, mode)
  } catch {
    /* storage is optional */
  }
}

export function formatByteSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Installed packs of the ACTIVE tab's backend: the packs table joined with
 * per-pack node counts from the schema table. Thumbnails ride the digest
 * ETag-cached icon endpoint (descriptor presence is the only fetch signal).
 */
export function packsSource(app: AppState): CollectionSource {
  return localCollectionSource({
    id: 'packs',
    label: 'Packs',
    corpus: (): CollectionEntry[] => {
      const tab = app.tabs.get().find((t) => t.id === app.activeTabId.get())
      const backend = tab ? app.backendForTab(tab) : app.backends.get()[0]
      const reg = backend?.registry.get()
      if (!reg?.packs) return []
      const nodeCounts = new Map<string, number>()
      for (const s of reg.schemas.values()) {
        if (s.pack !== undefined) nodeCounts.set(s.pack, (nodeCounts.get(s.pack) ?? 0) + 1)
      }
      const entries: CollectionEntry[] = []
      for (const [packId, info] of reg.packs) {
        const count = nodeCounts.get(packId) ?? 0
        const sourceKind = info.source?.split(':', 1)[0]
        const assetCount = info.assets?.length ?? 0
        entries.push({
          id: packId,
          title: info.displayName,
          subtitle: packId,
          badges: [
            ...(info.abbr !== undefined ? [info.abbr] : []),
            ...(info.version !== undefined ? [`v${info.version}`] : []),
            ...(sourceKind !== undefined ? [sourceKind] : []),
            `${count} node${count === 1 ? '' : 's'}`,
            ...(assetCount > 0 ? [`${assetCount} asset${assetCount === 1 ? '' : 's'}`] : []),
          ],
          ...(info.icon !== undefined && backend !== undefined
            ? { thumbUrl: `${backend.baseUrl}/api/packs/${encodeURIComponent(packId)}/icon` }
            : {}),
          details: [
            { label: 'pack id', text: packId },
            ...(backend !== undefined ? [{ label: 'backend', text: backend.label }] : []),
            { label: 'nodes', text: String(count) },
            ...(assetCount > 0 ? [{ label: 'assets', text: String(assetCount) }] : []),
            ...(info.assets ?? []).map((asset) => ({
              label: `asset: ${asset.name}`,
              text: [asset.kind, asset.size !== undefined ? formatByteSize(asset.size) : undefined].filter(Boolean).join(' - ') || asset.digest,
            })),
            ...(info.version !== undefined ? [{ label: 'version', text: info.version }] : []),
            ...(info.source !== undefined ? [{ label: 'source', text: info.source }] : []),
            ...(info.publisher !== undefined ? [{ label: 'publisher', text: info.publisher }] : []),
            ...(info.artifactDigest !== undefined ? [{ label: 'digest', text: info.artifactDigest }] : []),
          ],
        })
      }
      return entries.sort((a, b) => a.title.localeCompare(b.title))
    },
  })
}

/** Resolve template pack-local asset ids for display, preserving dangling ids defensively. */
export function templateAssetLines(descriptor: TemplateDescriptor, backend: Backend | undefined): string[] {
  const assets = backend?.registry.get()?.packs?.get(descriptor.pack)?.assets ?? []
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  return (descriptor.assets ?? []).map((id) => {
    const asset = byId.get(id)
    if (!asset) return id
    return [asset.name, asset.kind, asset.size !== undefined ? formatByteSize(asset.size) : undefined].filter(Boolean).join(' - ')
  })
}

export type TemplateCollectionRef =
  | { readonly kind: 'local'; readonly pack: string; readonly id: string }
  | { readonly kind: 'remote'; readonly template: RemoteTemplateDescriptor }

const allLocalTemplates = async (
  backend: Extract<Backend, { protocol: 'dinkster' }>,
): Promise<readonly TemplateDescriptor[]> => {
  const templates: TemplateDescriptor[] = []
  let cursor: string | undefined
  do {
    const page = await backend.connection.listTemplates({ limit: 200, ...(cursor === undefined ? {} : { cursor }) })
    templates.push(...page.templates)
    cursor = page.cursor
  } while (cursor !== undefined)
  return templates
}

const templateModels = (template: TemplateDescriptor, backend: Backend): readonly string[] => [
  ...(template.models ?? []),
  ...templateAssetLines(template, backend).map((line) => line.split(' - ', 1)[0]!),
]

const normalizeTemplateSearch = (value: string): string => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '')

const templateSearchTerms = (value: string): readonly string[] => {
  const normalized = normalizeTemplateSearch(value)
  const alias = normalizeTemplateSearch(value.replace(/\bstable[^a-z0-9]+diffusion\b/gi, 'sd'))
  return alias === normalized ? [normalized] : [normalized, alias]
}

export function templatesSource(app: AppState): CollectionSource {
  return {
    id: 'templates',
    label: 'Templates',
    filters: [{
      id: 'pack',
      label: 'Packs',
      options: () => [...(app.libraryBackend()?.registry.get()?.packs ?? new Map())]
        .map(([value, info]) => ({ value, label: info.displayName }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }],
    page: async (req) => {
      const backend = app.libraryBackend()
      if (!backend) return { items: [], total: 0 }
      const rawOffset = decodeOwnedCursor(backend.id, req.cursor)
      const offset = rawOffset === undefined ? 0 : Number(rawOffset)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid template continuation')
      const pack = req.filters?.['pack']
      const catalog = new RemoteTemplateCatalog(app.settings.get<string>('templates.registryUrl'))
      const [local, remote] = await Promise.all([allLocalTemplates(backend), catalog.list()])
      const query = templateSearchTerms(req.query.trim())
      const templates = [
        ...local.map((template) => ({ template, ref: { kind: 'local', pack: template.pack, id: template.id } as TemplateCollectionRef })),
        ...remote.map((template) => ({ template, ref: { kind: 'remote', template } as TemplateCollectionRef })),
      ].filter(({ template }) =>
        (pack === undefined || pack === '' || template.pack === pack) &&
        (query[0] === '' || [template.id, template.name, template.description ?? '', template.family ?? '', ...(template.tags ?? [])]
          .some((value) => templateSearchTerms(value)
            .some((candidate) => query.some((term) => candidate.includes(term))))))
      const modelNames = [...new Set(templates.flatMap(({ template }) => templateModels(template, backend)))]
      const matches = modelNames.length > 0 ? await backend.connection.guessAssets(modelNames) : []
      const held = new Map(matches.map((match) => [match.query, match.candidates.some((candidate) => candidate.held)]))
      const nextOffset = offset + req.limit
      const nextCursor = encodeOwnedCursor(
        backend.id,
        nextOffset < templates.length ? String(nextOffset) : undefined,
      )
      return {
        owner: backend.id,
        total: templates.length,
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        items: templates.slice(offset, nextOffset).map(({ template, ref }) => {
          const models = templateModels(template, backend)
          const missing = models.filter((model) => !held.get(model))
          const remoteTemplate = ref.kind === 'remote' ? ref.template : undefined
          const thumbUrl = remoteTemplate === undefined
            ? template.thumbnail === undefined
              ? undefined
              : `${backend.baseUrl}/api/packs/${encodeURIComponent(template.pack)}/templates/${encodeURIComponent(template.id)}/thumbnail`
            : catalog.thumbnailUrl(remoteTemplate)
          return {
            id: ref.kind === 'remote'
              ? `remote/${template.pack}/${remoteTemplate!.version}/${template.id}`
              : `${template.pack}/${template.id}`,
            owner: backend.id,
            title: template.name,
            ...(template.description !== undefined ? { subtitle: template.description } : {}),
            badges: [
              template.family ?? template.pack,
              ref.kind === 'remote' ? 'remote' : 'built-in',
              ...(missing.length > 0 ? [`${missing.length} model${missing.length === 1 ? '' : 's'} missing`] : []),
            ],
            ...(thumbUrl === undefined ? {} : { thumbUrl }),
            details: [
              { label: 'template id', text: template.id },
              { label: 'pack', text: template.pack },
              ...(template.family !== undefined ? [{ label: 'family', text: template.family }] : []),
              ...(remoteTemplate !== undefined ? [{ label: 'version', text: remoteTemplate.version }] : []),
              { label: 'backend', text: backend.label },
              { label: 'digest', text: template.digest },
              ...(template.tags?.length ? [{ label: 'tags', text: template.tags.join(', ') }] : []),
              ...templateAssetLines(template, backend).map((text) => ({ label: 'requires', text })),
              ...models.map((model) => ({ label: held.get(model) ? 'model ready' : 'model missing', text: model })),
            ],
            actions: [{ id: 'open', label: 'Open template' }],
            ref,
          }
        }),
      }
    },
  }
}

/** Text-first display of one saved-workflow record. */
const workflowEntry = (r: LibraryRecord, backend: Backend): CollectionEntry => ({
  id: r.id,
  owner: backend.id,
  title: r.name,
  subtitle: `Modified ${formatCollectionDate(r.modified * 1000)}`,
  badges: [...r.labels.filter((l) => l !== WORKFLOW_LABEL), `rev ${r.revision}`],
  details: [
    { label: 'workflow id', text: r.id },
    { label: 'backend', text: backend.label },
    { label: 'digest', text: r.digest },
    { label: 'media type', text: r.mediaType },
    { label: 'modified', text: formatCollectionDate(r.modified * 1000) },
    { label: 'revision', text: String(r.revision) },
    ...(r.folder !== undefined ? [{ label: 'folder', text: r.folder }] : []),
  ],
  // 'copy-link' puts a shareable dinkster:// link on the clipboard; the
  // desktop shell opens such links into the right project and workflow.
  actions: [{ id: 'copy-link', label: 'Copy link' }],
})

/**
 * Saved workflows from the active backend's scoped library - the first
 * REMOTE source: the server owns query ranking and keyset paging
 * (cursor bound to its query by contract), this side never filters a
 * loaded page. A V1 backend has no library surface; the source renders
 * its text-first empty state.
 */
export function workflowsSource(app: AppState): CollectionSource {
  return {
    id: 'workflows',
    label: 'Workflows',
    page: async (req) => {
      const backend = app.libraryBackend()
      if (!backend) return { items: [], total: 0 }
      const cursor = decodeOwnedCursor(backend.id, req.cursor)
      const page = await backend.connection.listLibrary({
        scope: LIBRARY_SCOPE,
        query: req.query,
        label: WORKFLOW_LABEL,
        limit: req.limit,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      const nextCursor = encodeOwnedCursor(backend.id, page.cursor)
      return {
        owner: backend.id,
        items: page.records.map((r) => workflowEntry(r, backend)),
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      }
    },
  }
}

const timeText = (epoch: number): string => formatCollectionDate(epoch * 1000)
const localTimeText = (epoch: number): string => formatCollectionDate(epoch)
const titleCase = (value: string): string => value[0]!.toUpperCase() + value.slice(1)

const armReceiptBadges = (r: HistoryRunRecord): string[] => {
  const counts = new Map<string, number>()
  for (const receipt of r.nodeReceipts ?? []) {
    if (receipt.executionArm === undefined) continue
    counts.set(receipt.executionArm, (counts.get(receipt.executionArm) ?? 0) + 1)
  }
  return [...counts].map(([arm, count]) => `${count} ${arm === 'native' ? 'Native' : 'ComfyUI'}`)
}

const workerReceiptBadges = (r: HistoryRunRecord): string[] => {
  const counts = new Map<string, number>()
  for (const receipt of r.nodeReceipts ?? []) {
    if (receipt.worker === undefined) continue
    counts.set(receipt.worker, (counts.get(receipt.worker) ?? 0) + 1)
  }
  return [...counts].map(([worker, count]) => `${count} on ${worker}`)
}

const nodeExecutionText = (
  disposition: string,
  executionArm?: 'native' | 'comfyui',
  worker?: string,
  provider?: string,
  pack?: string,
): string => [
  disposition,
  ...(executionArm === undefined ? [] : [executionArm === 'native' ? 'Native' : 'ComfyUI']),
  ...(provider === undefined ? [] : [`provider ${provider}`]),
  ...(pack === undefined ? [] : [`pack ${pack}`]),
  ...(worker === undefined ? [] : [worker]),
].join(' - ')

const attributionBadges = (attribution: RunAttribution): string[] => {
  const label = runAttributionLabel(attribution)
  return [
    ...(label !== undefined ? [label] : []),
    ...(attribution.kind === 'agent' ? ['agent'] : []),
  ]
}

/**
 * The sweep phase of an interrupted record: 'running' means the server
 * died mid-execution, anything else means the job never started.
 */
const interruptedPhaseText = (r: HistoryRunRecord): string =>
  r.error?.['phase'] === 'running' ? 'was running' : 'never started'

/** Text-first display of one durable run record. */
const runEntry = (r: HistoryRunRecord, owner: string): CollectionEntry => ({
  id: r.runId,
  ref: r.runId,
  owner,
  title: `${titleCase(r.state)} run`,
  subtitle: `${timeText(r.finishedAt)} - ${r.jobId}`,
  badges: [
    ...attributionBadges({ principalId: r.principalId, kind: r.principalKind }),
    'Durable record',
    r.state,
    ...(r.state === 'interrupted' ? [interruptedPhaseText(r)] : []),
    `${r.executed} run / ${r.cached} cached`,
    ...armReceiptBadges(r),
    ...workerReceiptBadges(r),
    ...(r.skipped > 0 ? [`${r.skipped} skipped`] : []),
    ...(r.sourceDocument !== undefined ? ['Source recorded'] : ['Source unavailable']),
  ],
  details: [
    { label: 'run id', text: r.runId },
    { label: 'job id', text: r.jobId },
    { label: 'client', text: r.clientId },
    ...(r.state === 'interrupted' ? [{ label: 'interrupted', text: interruptedPhaseText(r) }] : []),
    { label: 'submitted', text: timeText(r.submittedAt) },
    ...(r.startedAt !== undefined ? [{ label: 'started', text: timeText(r.startedAt) }] : []),
    { label: 'finished', text: timeText(r.finishedAt) },
    ...(r.sourceDocument !== undefined
      ? [{ label: 'source document', text: r.sourceDocument }]
      : [{ label: 'source document', text: 'none (unstamped submission)' }]),
    ...(r.nodeReceipts ?? []).map((receipt) => ({
      label: `node ${receipt.nodeId}`,
      text: nodeExecutionText(receipt.disposition, receipt.executionArm, receipt.worker, receipt.provider, receipt.pack),
    })),
    ...(r.error?.message !== undefined ? [{ label: 'error', text: r.error.message }] : []),
  ],
  actions: [
    // Resubmission is a fresh submission of the exact producing document
    // through the normal compile/queue pipeline - never a resume. Only
    // stamped records can offer it: without sourceDocument there is
    // nothing to resubmit.
    ...(r.state === 'interrupted' && r.sourceDocument !== undefined
      ? [{ id: 'resubmit', label: 'Resubmit' }]
      : []),
    ...(r.sourceDocument !== undefined ? [{ id: 'open', label: 'Open workflow' }] : []),
    { id: 'delete', label: 'Delete record' },
  ],
})

export interface RunHistoryRow {
  /** Most recent record; the durable API orders records newest-first. */
  readonly latest: HistoryRunRecord
  /** Newest-first and consecutive, matching the history chronology. */
  readonly members: readonly HistoryRunRecord[]
  /** Stable while newer members join: the oldest member anchors the row. */
  readonly id: string
}

/** Resolve the durable run id carried through a synthetic grouped row. */
export const runIdOfEntry = (entry: CollectionEntry): string =>
  typeof entry.ref === 'string' ? entry.ref : entry.id

const noOpIdentity = (record: HistoryRunRecord): string | undefined =>
  record.state === 'completed' && record.executed === 0 && record.cached > 0
    ? record.sourceDocument
    : undefined

/**
 * Collapse consecutive successful all-cached runs of the exact same
 * submitted workflow document revision. sourceDocument is the strongest
 * stable identity retained by durable history: it is a content digest of
 * the producing document. Execution targets are not persisted, so this is
 * deliberately document identity rather than a claim of execution identity.
 * Unstamped records cannot be compared safely and remain individual.
 *
 * Input and member order are newest-first, exactly as /api/history serves
 * them. Any non-no-op record (including failed and cancelled records)
 * closes the current group, so chronology and terminal-state boundaries
 * cannot be crossed.
 */
export function groupNoOpHistoryRuns(records: readonly HistoryRunRecord[]): readonly RunHistoryRow[] {
  const rows: RunHistoryRow[] = []
  for (const record of records) {
    const identity = noOpIdentity(record)
    const previous = rows.at(-1)
    const previousIdentity = previous === undefined ? undefined : noOpIdentity(previous.latest)
    if (previous !== undefined && identity !== undefined && identity === previousIdentity) {
      const members = [...previous.members, record]
      rows[rows.length - 1] = {
        latest: previous.latest,
        members,
        id: `noop:${identity}:${record.runId}`,
      }
    } else {
      rows.push({ latest: record, members: [record], id: record.runId })
    }
  }
  return rows
}

const runRowEntry = (row: RunHistoryRow, owner: string): CollectionEntry => {
  const latest = runEntry(row.latest, owner)
  if (row.members.length === 1) return latest
  return {
    ...latest,
    id: row.id,
    badges: [...(latest.badges ?? []), 'No-op group', `${row.members.length} runs`],
    details: [
      ...(latest.details ?? []),
      { label: 'grouped runs', text: String(row.members.length) },
    ],
    children: row.members.map((member) => runEntry(member, owner)),
  }
}

/**
 * Map the search box onto the server's EXACT-match filter vocabulary -
 * /api/history has no free-text search, and faking one by filtering a
 * loaded page is exactly the bug the collection contract bans. A query
 * that unambiguously prefixes a terminal state filters on it; a full
 * blake3 digest filters on sourceDocument; anything else matches nothing.
 */
export const runsFilterOf = (
  query: string,
): { state?: string; sourceDocument?: string } | undefined => {
  const q = query.trim().toLowerCase()
  if (q === '') return {}
  if (/^blake3:[0-9a-f]{64}$/.test(q)) return { sourceDocument: q }
  const states = HISTORY_STATES.filter((s) => s.startsWith(q))
  return states.length === 1 ? { state: states[0]! } : undefined
}

/**
 * Durable terminal runs from the active backend's persistent history -
 * remote, newest-finished first, server-owned keyset paging (cursor bound
 * to its query by contract). Entry click selects (details + actions);
 * the 'open' action reopens the exact producing workflow via
 * sourceDocument (stamped runs only), and 'delete' removes the RECORD
 * only (asset bytes and library records are never touched, by contract).
 * Actions are explicit because click-as-activation would make delete
 * unreachable: selecting an entry would open a tab and close the panel.
 */
export function runsSource(app: AppState): CollectionSource {
  return {
    id: 'runs',
    label: 'Runs',
    page: async (req) => {
      const backend = app.libraryBackend()
      if (!backend) return { items: [], total: 0 }
      const cursor = decodeOwnedCursor(backend.id, req.cursor)
      const filter = runsFilterOf(req.query)
      if (filter === undefined) return { owner: backend.id, items: [], total: 0 }
      const page = await backend.connection.listHistory({
        scope: LIBRARY_SCOPE,
        ...filter,
        limit: req.limit,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      const nextCursor = encodeOwnedCursor(backend.id, page.cursor)
      return {
        owner: backend.id,
        items: groupNoOpHistoryRuns(page.records).map((row) => runRowEntry(row, backend.id)),
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      }
    },
  }
}

const historyBadges = (exec: ExecutionState, statusText: string): string[] => [
  ...(exec.artifact === undefined ? ['External execution'] : ['Local snapshot']),
  statusText,
  ...(exec.artifact?.scope.kind === 'partial' ? ['Partial run'] : []),
  ...(exec.artifact === undefined ? ['Snapshot unavailable'] : []),
  ...(exec.errors.length > 0 ? [`${exec.errors.length} error${exec.errors.length === 1 ? '' : 's'}`] : []),
]

/**
 * Execution history from the shared store (newest first, all backends).
 * Entry ids are execution keys, so a collection click can open the frozen
 * view through app.openExecutionView.
 */
export function historySource(app: AppState): CollectionSource {
  return localCollectionSource({
    id: 'history',
    label: 'History',
    corpus: (): CollectionEntry[] =>
      app.executionList().map((exec) => {
        // `queued` is a claim the store cannot back for an entry admitted
        // from mid-run chatter, so such an entry is labeled truthfully
        // until a run start confirms it.
        const statusText =
          exec.status === 'queued' && app.store.isUnconfirmed(exec.ref) ? 'unconfirmed' : exec.status
        return {
          id: exec.key,
          title: app.tabTitleFor(exec.ref),
          subtitle: `${localTimeText(exec.queuedAt)} - ${exec.ref.prompt}`,
          badges: [
            ...attributionBadges({
              principalId: exec.submittedBy?.principalId,
              kind: exec.submittedBy?.kind,
            }),
            ...historyBadges(exec, statusText),
          ],
          details: [
            { label: 'prompt', text: exec.ref.prompt },
            { label: 'backend', text: exec.ref.connection },
            { label: 'status', text: statusText },
            { label: 'queued', text: localTimeText(exec.queuedAt) },
            ...(exec.startedAt !== undefined ? [{ label: 'started', text: localTimeText(exec.startedAt) }] : []),
            ...(exec.endedAt !== undefined ? [{ label: 'finished', text: localTimeText(exec.endedAt) }] : []),
            ...(exec.artifact !== undefined
              ? [{ label: 'source lineage', text: exec.artifact.snapshot.lineage }]
              : []),
            ...Object.entries(exec.nodes).map(([nodeId, node]) => ({
              label: `node ${nodeId}`,
              text: nodeExecutionText(node.state, node.executionArm, node.worker, node.provider, node.pack),
            })),
            ...(exec.errors.length > 0 ? [{ label: 'errors', text: String(exec.errors.length) }] : []),
          ],
        }
      }),
  })
}
