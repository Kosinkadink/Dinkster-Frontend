/**
 * The app's built-in collection sources, in the common CollectionSource
 * vocabulary (packs today, execution history alongside; templates/assets
 * arrive with their backend surfaces). Sources are LIVE - each derives a
 * fresh corpus per page request from state the app already holds - and
 * query ranking goes through the shared scorer via localCollectionSource,
 * so searching here behaves exactly like the palette.
 */

import {
  formatByteSize,
  formatDate,
  formatNumber,
  localCollectionSource,
  t,
  type CollectionEntry,
  type CollectionSource,
  type BoardCardSource,
} from '@dinkster/core'
import { HISTORY_STATES, type ExecutionState, type HistoryPage, type HistoryRunRecord, type LibraryRecord, type TemplateDescriptor } from '@dinkster/client'
import { LIBRARY_SCOPE, WORKFLOW_LABEL, type AppState, type Backend } from './app-state.js'
import { RemoteTemplateCatalog, type RemoteTemplateDescriptor } from './template-catalog.js'

const COLLECTION_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
}

export const formatCollectionDate = (value: number): string => formatDate(value, {
  ...COLLECTION_DATE_OPTIONS, hour: 'numeric', minute: '2-digit',
})

export const formatCollectionRowDate = (value: number): string => {
  const date = new Date(value)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? t('collection.date.today', { time: formatDate(value, { hour: 'numeric', minute: '2-digit' }) })
    : formatDate(value, COLLECTION_DATE_OPTIONS)
}

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

export { formatByteSize } from '@dinkster/core'

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
        const pack = s.pack ?? 'core'
        nodeCounts.set(pack, (nodeCounts.get(pack) ?? 0) + 1)
      }
      const entries: CollectionEntry[] = []
      for (const [packId, info] of reg.packs) {
        const count = nodeCounts.get(packId) ?? 0
        if (count === 0) continue
        const assetCount = info.assets?.length ?? 0
        entries.push({
          id: packId,
          title: info.displayName,
          diagnostics: JSON.stringify({ ...info, packId, backend: backend?.label }, null, 2),
          ...(info.icon !== undefined && backend !== undefined
            ? { thumbRender: async (signal?: AbortSignal) => {
                if (signal === undefined) throw new Error('Pack preview request unavailable')
                const blob = await backend.connection.fetchPackIcon(packId, signal)
                signal.throwIfAborted()
                const url = URL.createObjectURL(blob)
                signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true })
                return url
              } }
            : {}),
          details: [
            { label: 'nodes', text: String(count) },
            ...(assetCount > 0 ? [{ label: 'assets', text: String(assetCount) }] : []),
            ...(info.assets ?? []).map((asset) => ({
              label: `asset: ${asset.name}`,
              text: [asset.kind, asset.size !== undefined ? formatByteSize(asset.size) : undefined].filter(Boolean).join(' - '),
            })),
            ...(info.version !== undefined ? [{ label: 'version', text: info.version }] : []),
            ...(info.publisher !== undefined ? [{ label: 'publisher', text: info.publisher }] : []),
          ],
        })
      }
      return entries.sort((a, b) => a.title.localeCompare(b.title))
    },
  })
}

/** Resolve template pack-local asset ids for display, preserving dangling ids defensively. */
export function templateAssetLines(descriptor: TemplateDescriptor, backend: Pick<TemplateCollectionBackend, 'registry'> | undefined): string[] {
  const assets = backend?.registry.get()?.packs?.get(descriptor.pack)?.assets ?? []
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  return (descriptor.assets ?? []).map((id) => {
    const asset = byId.get(id)
    if (!asset) return id
    return [asset.name, asset.kind, asset.size !== undefined ? formatByteSize(asset.size) : undefined].filter(Boolean).join(' - ')
  })
}

export type TemplateCollectionRef = (
  | { readonly kind: 'local'; readonly pack: string; readonly id: string; readonly template: TemplateDescriptor }
  | { readonly kind: 'remote'; readonly template: RemoteTemplateDescriptor }
) & {
  readonly models: readonly { readonly name: string; readonly here: boolean; readonly size?: number }[]
}

export type TemplateCollectionBackend = Pick<Extract<Backend, { protocol: 'dinkster' }>, 'id' | 'label' | 'connection'> & {
  readonly registry: Pick<Backend['registry'], 'get'>
}

const allLocalTemplates = async (
  backend: TemplateCollectionBackend,
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

const templateModels = (template: TemplateDescriptor, backend: TemplateCollectionBackend): readonly string[] => [...new Set([
  ...(template.models ?? []),
  ...(template.assets ?? []).map((id) =>
    backend.registry.get()?.packs?.get(template.pack)?.assets?.find((asset) => asset.id === id)?.name ?? id),
])]

export const normalizeTemplateSearch = (value: string): string => value
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '')

export function templatesSource(app: AppState, resolveBackend = () => app.libraryBackend()): CollectionSource {
  return templateCollectionSource(resolveBackend, () => app.settings.list().some((setting) => setting.id === 'templates.registryUrl')
    ? app.settings.get<string>('templates.registryUrl') : '')
}

/** The same collection can be read from Projects without constructing an editor. */
export function templateCollectionSource(resolveBackend: () => TemplateCollectionBackend | undefined, registryUrl: () => string): CollectionSource {
  return {
    id: 'templates',
    label: 'Templates',
    filters: [{
      id: 'pack',
      label: 'Packs',
      options: () => [...(resolveBackend()?.registry.get()?.packs ?? new Map())]
        .map(([value, info]) => ({ value, label: info.displayName }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }],
    page: async (req) => {
      const backend = resolveBackend()
      if (!backend) return { items: [], total: 0 }
      const rawOffset = decodeOwnedCursor(backend.id, req.cursor)
      const offset = rawOffset === undefined ? 0 : Number(rawOffset)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid template continuation')
      const pack = req.filters?.['pack']
      const catalog = new RemoteTemplateCatalog(registryUrl())
      const [local, remote] = await Promise.all([allLocalTemplates(backend), catalog.list()])
      const query = normalizeTemplateSearch(req.query.trim())
      const templates = [
        ...local.map((template) => ({ template, ref: { kind: 'local' as const, pack: template.pack, id: template.id, template } })),
        ...remote.map((template) => ({ template, ref: { kind: 'remote' as const, template } })),
      ].filter(({ template }) =>
        (pack === undefined || pack === '' || template.pack === pack) &&
        (query === '' || [template.id, template.name, template.description ?? '', template.family ?? '', ...(template.tags ?? [])]
          .some((value) => normalizeTemplateSearch(value).includes(query))))
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
          const packName = backend.registry.get()?.packs?.get(template.pack)?.displayName
          const assets = backend.registry.get()?.packs?.get(template.pack)?.assets ?? []
          const declared = assets.filter((asset) => template.assets?.includes(asset.id))
          const remoteTemplate = ref.kind === 'remote' ? ref.template : undefined
          const thumbUrl = remoteTemplate === undefined ? undefined : catalog.thumbnailUrl(remoteTemplate)
          return {
            id: ref.kind === 'remote'
              ? `remote/${template.pack}/${remoteTemplate!.version}/${template.id}`
              : `${template.pack}/${template.id}`,
            owner: backend.id,
            title: template.name,
            ...(template.description === undefined ? {} : { description: template.description }),
            ...(packName === undefined ? {} : { subtitle: `From ${packName}` }),
            badges: template.tags ?? [],
            diagnostics: JSON.stringify({ ...template, backend: backend.label }, null, 2),
            ...(thumbUrl === undefined ? {} : { thumbUrl }),
            ...(remoteTemplate === undefined && template.thumbnail !== undefined ? {
              thumbRender: async (signal?: AbortSignal) => {
                if (signal === undefined) throw new Error('Template preview request unavailable')
                const blob = await backend.connection.fetchTemplateThumbnail(template.pack, template.id, signal)
                signal.throwIfAborted()
                const url = URL.createObjectURL(blob)
                signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true })
                return url
              },
            } : {}),
            details: [
              ...(template.family !== undefined ? [{ label: 'family', text: template.family }] : []),
              ...(remoteTemplate !== undefined ? [{ label: 'version', text: remoteTemplate.version }] : []),
              ...templateAssetLines(template, backend).map((text) => ({ label: 'requires', text })),
              ...models.map((model) => ({ label: held.get(model) ? 'model ready' : 'model missing', text: model })),
            ],
            actions: [{ id: 'open', label: 'Open template' }],
            ref: {
              ...ref,
              models: models.map((name) => {
                const size = declared.find((asset) => asset.name === name)?.size
                return { name, here: held.get(name) === true, ...(size === undefined ? {} : { size }) }
              }),
            } satisfies TemplateCollectionRef,
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
  kind: 'workflow',
  subtitle: `Modified ${formatCollectionRowDate(r.modified * 1000)}`,
  badges: r.labels.filter((l) => l !== WORKFLOW_LABEL),
  diagnostics: JSON.stringify({ ...r, backend: backend.label }, null, 2),
  details: [
    { label: 'modified', text: formatDate(r.modified * 1000, { ...COLLECTION_DATE_OPTIONS, hour: 'numeric', minute: '2-digit' }) },
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
export function workflowsSource(app: AppState,
  backendForPage = () => app.libraryBackend(),
  project?: string,
): CollectionSource {
  return {
    id: 'workflows',
    label: 'Workflows',
    page: async (req) => {
      const backend = backendForPage()
      if (!backend) return { items: [], total: 0 }
      const cursor = decodeOwnedCursor(backend.id, req.cursor)
      const page = await backend.connection.listLibrary({
        scope: LIBRARY_SCOPE,
        query: req.query,
        label: WORKFLOW_LABEL,
        limit: req.limit,
        ...(project === undefined ? {} : { project }),
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

/** Saved project and enabled-pack blueprints share one ungrouped picker. */
export function boardBlueprintsSource(backendForPage: () => Backend | undefined, project: string): CollectionSource {
  return {
    id: 'board-blueprints', label: 'Blueprints',
    page: async (req) => {
      const backend = backendForPage()
      if (!backend) return { items: [], total: 0 }
      const cursor = decodeOwnedCursor(backend.id, req.cursor)
      const items: CollectionEntry[] = []
      const errors: string[] = []
      try {
        let next: string | undefined
        do {
          req.signal?.throwIfAborted()
          const page = await backend.connection.listLibrary({ scope: LIBRARY_SCOPE, project,
            label: 'blueprint', limit: 200, ...(next === undefined ? {} : { cursor: next }) })
          items.push(...page.records.map((record): CollectionEntry => ({
            id: `saved:${record.id}`, owner: backend.id, title: record.name,
            kind: 'blueprint',
            subtitle: `Modified ${formatCollectionRowDate(record.modified * 1000)}`,
            badges: record.labels.filter((label) => label !== 'blueprint'),
            diagnostics: JSON.stringify({ ...record, backend: backend.label }, null, 2),
            details: [{ label: 'modified', text: formatCollectionDate(record.modified * 1000) },
              ...(record.folder === undefined ? [] : [{ label: 'folder', text: record.folder }])],
            ref: { kind: 'library', recordId: record.id } satisfies BoardCardSource,
          })))
          next = page.cursor
        } while (next !== undefined)
      } catch (reason) { errors.push(reason instanceof Error ? reason.message : String(reason)) }
      const registry = backend.registry.get()
      if (!registry) errors.push('Blueprint packs are unavailable')
      for (const [packId, pack] of registry?.packs ?? []) {
        for (const blueprint of pack.blueprints ?? []) items.push({
          id: `pack:${JSON.stringify([packId, blueprint.id])}`, owner: backend.id, title: blueprint.name,
          kind: 'blueprint',
          subtitle: `From ${pack.displayName}`, badges: blueprint.tags ?? [],
          ...(blueprint.description === undefined ? {} : { description: blueprint.description }),
          diagnostics: JSON.stringify({ ...blueprint, pack: packId, backend: backend.label }, null, 2),
          ref: { kind: 'pack', packId, blueprintId: blueprint.id, digest: blueprint.digest } satisfies BoardCardSource,
        })
      }
      req.signal?.throwIfAborted()
      const page = await localCollectionSource({ id: 'board-blueprints', label: 'Blueprints', corpus: () => items })
        .page({ ...req, ...(cursor === undefined ? {} : { cursor }) })
      const next = encodeOwnedCursor(backend.id, page.cursor)
      return { ...page, owner: backend.id, ...(next === undefined ? {} : { cursor: next }),
        ...(errors.length === 0 ? {} : { error: errors.join('; ') }) }
    },
  }
}

export function boardsSource(app: AppState): CollectionSource {
  return {
    id: 'boards',
    label: 'Boards',
    page: async (req) => {
      const backend = app.libraryBackend()
      if (!backend) return { items: [], total: 0 }
      const cursor = decodeOwnedCursor(backend.id, req.cursor)
      const page = await backend.connection.listLibrary({
        scope: LIBRARY_SCOPE,
        query: req.query,
        label: 'board',
        limit: req.limit,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      const nextCursor = encodeOwnedCursor(backend.id, page.cursor)
      return {
        owner: backend.id,
        items: page.records.map((record): CollectionEntry => ({
          id: record.id,
          owner: backend.id,
          title: record.name,
          kind: 'board',
          subtitle: `Modified ${formatCollectionRowDate(record.modified * 1000)}`,
          badges: record.labels.filter((label) => label !== 'board'),
          diagnostics: JSON.stringify({ ...record, backend: backend.label }, null, 2),
          details: [
            { label: 'modified', text: formatCollectionDate(record.modified * 1000) },
            ...(record.folder === undefined ? [] : [{ label: 'folder', text: record.folder }]),
          ],
        })),
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      }
    },
  }
}

const timeText = (epoch: number): string => formatCollectionDate(epoch * 1000)
const localTimeText = (epoch: number): string => formatCollectionDate(epoch)
const titleCase = (value: string): string => value[0]!.toUpperCase() + value.slice(1)

/** Text-first display of one durable run record. */
const runEntry = (r: HistoryRunRecord, backend: Pick<Backend, 'id' | 'label'>): CollectionEntry => ({
  id: r.runId,
  ref: r,
  owner: backend.id,
  title: r.workflowName ?? `${titleCase(r.state)} run`,
  subtitle: `${titleCase(r.state)}, ${formatCollectionRowDate(r.finishedAt * 1000)}`,
  diagnostics: JSON.stringify({ ...r, backend: backend.label }, null, 2),
  details: [
    { label: 'state', text: titleCase(r.state) },
    ...(r.startedAt !== undefined ? [{ label: 'started', text: timeText(r.startedAt) }] : []),
    ...(r.startedAt === undefined ? [] : [{ label: 'duration', text: formatNumber(Math.max(0, r.finishedAt - r.startedAt), { style: 'unit', unit: 'second', unitDisplay: 'narrow' }) }]),
    { label: 'nodes', text: t('runs.chosen.nodesText', { ran: r.executed, cached: r.cached }) },
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

/** The durable record stays attached to grouped rows without loading job outputs. */
export const historyRunOfEntry = (entry: CollectionEntry): HistoryRunRecord | undefined =>
  typeof entry.ref === 'object' && entry.ref !== null && 'runId' in entry.ref
    ? entry.ref as HistoryRunRecord : undefined

/** Resolve the durable run id carried through a synthetic grouped row. */
export const runIdOfEntry = (entry: CollectionEntry): string =>
  historyRunOfEntry(entry)?.runId ?? entry.id

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

const runRowEntry = (row: RunHistoryRow, backend: Pick<Backend, 'id' | 'label'>): CollectionEntry => {
  const latest = runEntry(row.latest, backend)
  if (row.members.length === 1) return latest
  return {
    ...latest,
    id: row.id,
    subtitle: `${latest.subtitle}, ${row.members.length} runs`,
    diagnostics: JSON.stringify({ ...row.latest, groupedRuns: row.members, backend: backend.label }, null, 2),
    details: [
      ...(latest.details ?? []),
      { label: 'grouped runs', text: String(row.members.length) },
    ],
    children: row.members.map((member) => runEntry(member, backend)),
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
      if (!backend) return { items: [], total: 0, disabledActions: ['clear'] }
      const cursor = decodeOwnedCursor(backend.id, req.cursor)
      const filter = runsFilterOf(req.query)
      const listing: Promise<HistoryPage> = filter === undefined ? Promise.resolve({ records: [] }) : backend.connection.listHistory({
        scope: LIBRARY_SCOPE,
        ...filter,
        limit: req.limit,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      // A query or continuation can hide every row without emptying the backend.
      const corpus = req.query.trim() === '' && cursor === undefined ? listing
        : backend.connection.listHistory({ scope: LIBRARY_SCOPE, limit: 1 })
      const [page, unfiltered] = await Promise.all([listing, corpus])
      const nextCursor = encodeOwnedCursor(backend.id, page.cursor)
      return {
        owner: backend.id,
        disabledActions: unfiltered.records.length === 0 ? ['clear'] : [],
        items: groupNoOpHistoryRuns(page.records).map((row) => runRowEntry(row, backend)),
        ...(filter === undefined ? { total: 0 } : {}),
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      }
    },
  }
}

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
          subtitle: `${titleCase(statusText === 'error' ? 'failed' : statusText)}, ${formatCollectionRowDate(exec.queuedAt)}`,
          diagnostics: JSON.stringify({ ...exec, artifact: exec.artifact === undefined ? undefined : { scope: exec.artifact.scope, lineage: exec.artifact.snapshot.lineage } }, null, 2),
          details: [
            { label: 'state', text: titleCase(statusText === 'error' ? 'failed' : statusText) },
            ...(exec.startedAt !== undefined ? [{ label: 'started', text: localTimeText(exec.startedAt) }] : []),
            ...(exec.startedAt === undefined || exec.endedAt === undefined ? [] : [{ label: 'duration', text: formatNumber(Math.max(0, (exec.endedAt - exec.startedAt) / 1000), { style: 'unit', unit: 'second', unitDisplay: 'narrow' }) }]),
            { label: 'nodes', text: t('runs.chosen.nodesText', { ran: Object.values(exec.nodes).filter((node) => node.state === 'done').length, cached: Object.values(exec.nodes).filter((node) => node.state === 'cached').length }) },
          ],
        }
      }),
  })
}
