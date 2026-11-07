import { decodeSearchHostAction, nodeSearchFields, rankSearch, scoreMatch, searchVisibilityOf, sha256Hex, t, type NodeSchema, type PackInfo, type SearchAction, type SearchProvider, type SearchResult } from '@dinkster/core'
import type { AppState } from './app-state.js'
import { RemoteNodeCatalog, type CatalogNode } from './node-catalog.js'
import { placementSchemaKey } from './palette-node-preview.js'
import type { SettingsRegistry } from './settings.js'
import { buildSettingsSearchIndex, querySettingsIndex, searchableSettingsDefinitions } from './settings-search.js'

export const SEARCH_RECENTS_SETTING = 'search.recentActivations'
const fields = (title: string, detail = '', keywords: readonly string[] = []) => [
  { text: title, weight: 3 }, { text: detail, weight: 1 }, ...keywords.map((text) => ({ text, weight: 1 })),
]
const catalogNodeKey = (entry: CatalogNode): string => sha256Hex(JSON.stringify([
  entry.pack.name, entry.pack.version, entry.pack.digest, placementSchemaKey(entry.schema),
]))
const result = (q: string, id: string, title: string, detail: string | undefined, action: SearchAction, keywords: readonly string[] = []): SearchResult | undefined => {
  const score = scoreMatch(q, fields(title, detail, keywords))
  return score === undefined ? undefined : { id, title, ...(detail !== undefined ? { detail } : {}), score, action, keywords }
}

/** Secondary context for node rows; canonical identity is added only when a display name collides. */
export function nodeSearchDetail(
  schema: Pick<NodeSchema, 'type' | 'displayName' | 'category' | 'pack'>,
  duplicateNames: ReadonlySet<string>,
  packs?: ReadonlyMap<string, Pick<PackInfo, 'displayName'>>,
): string {
  if (!duplicateNames.has(schema.displayName)) return schema.category
  const pack = schema.pack === undefined ? undefined : packs?.get(schema.pack)?.displayName ?? schema.pack
  return [...(pack === undefined ? [] : [pack]), schema.category, schema.type].join(' - ')
}

export function searchRecents(settings: SettingsRegistry): readonly string[] {
  try { const value = JSON.parse(settings.get<string>(SEARCH_RECENTS_SETTING)); return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').slice(0, 20) : [] } catch { return [] }
}
export function recordSearchRecent(settings: SettingsRegistry, key: string): void {
  settings.set(SEARCH_RECENTS_SETTING, JSON.stringify([key, ...searchRecents(settings).filter((id) => id !== key)].slice(0, 20)))
}

export function registerCoreSearchProviders(app: AppState): readonly (() => void)[] {
  const providers: SearchProvider[] = [
    { id: 'core.commands', label: 'Commands', prefix: '>', priority: 40, query: (q) => app.commands.list().flatMap((command) => {
      const match = result(q, command.id, command.label, app.keybindings.combo(command.id), { kind: 'host', action: 'command.run', params: { id: command.id } })
      return match ? [match] : []
    }) },
    { id: 'core.settings', label: 'Settings', prefix: '#', priority: 30, query: (q) => querySettingsIndex(buildSettingsSearchIndex(searchableSettingsDefinitions(app.settings.list()), (d) => app.settings.categoryOf(d), app.commands.list()), q).flatMap((group) => group.matches.map((match) => ({
      id: match.id, title: match.name, detail: group.category, score: match.score,
      action: { kind: 'host' as const, action: 'settings.open', params: { category: match.action.category, id: match.action.id } },
    }))) },
    { id: 'core.nodes', label: 'Nodes', prefix: '@', priority: 20, query: (q) => {
      const tab = app.activeTab()
      const registry = tab && tab.execution === undefined && app.canvasBridge.get() ? app.registryForTab(tab) : undefined
      const external = tab === undefined || tab.execution !== undefined || !app.canvasBridge.get() ? [] : app.searchCatalog.get().filter((entry) =>
        !registry?.schemas.has(entry.schema.type) && !registry?.packs?.has(entry.pack.name))
      const externalByType = new Map(external.map((entry) => [entry.schema.type, entry]))
      const schemas = [...(registry?.schemas.values() ?? []), ...[...externalByType.values()].map((entry) => entry.schema)].filter((schema) => searchVisibilityOf(schema) === 'normal')
      const duplicateNames = duplicateNodeNames(schemas)
      const backendId = tab === undefined ? '' : app.backendForTab(tab).id
      return rankSearch(q, schemas, nodeSearchFields).map((schema) => {
        const entry = externalByType.get(schema.type)
        return {
        id: schema.type, title: schema.displayName, detail: entry === undefined ? nodeSearchDetail(schema, duplicateNames, registry?.packs)
          : `${entry.pack.displayName} - ${t('search.notInstalled')} - ${schema.category}`,
        score: scoreMatch(q, nodeSearchFields(schema)) ?? 0,
        preview: { version: 1 as const, title: schema.displayName, ...(schema.description === undefined ? {} : { description: schema.description }) },
        action: { kind: 'host' as const, action: entry === undefined ? 'node.armPlacement' as const : 'node.previewInstall' as const, params: {
          type: schema.type,
          schemaKey: entry === undefined ? placementSchemaKey(schema) : catalogNodeKey(entry),
          backendId,
        } },
      }})
    } },
    { id: 'core.tabs', label: 'Tabs', prefix: '~', priority: 10, query: (q) => app.tabs.get().flatMap((tab) => {
      const match = result(q, tab.id, tab.title, 'Open tab', { kind: 'host', action: 'tab.activate', params: { id: tab.id } })
      return match ? [match] : []
    }) },
  ]
  const disposers = providers.map((provider) => app.searchRegistry.register(provider))
  const nodesProvider = providers.find((provider) => provider.id === 'core.nodes')!
  let unregisterNodes = disposers[2]!
  disposers[2] = () => unregisterNodes()
  disposers.push(app.searchCatalog.subscribe(() => {
    const finish = app.searchRegistry.beginBatch()
    unregisterNodes()
    unregisterNodes = app.searchRegistry.register(nodesProvider)
    finish(true)
  }))
  return disposers
}

/** Fetch outside query dispatch, so unavailable mirrors never delay installed search. */
export function bindSearchCatalog(app: AppState): () => void {
  let catalog: RemoteNodeCatalog | undefined
  let disposed = false
  const refresh = (revalidate = false) => {
    const baseUrl = app.settings.get<string>('search.registryUrl').trim().replace(/\/+$/, '')
    if (catalog?.baseUrl === baseUrl && !revalidate) return
    if (catalog?.baseUrl !== baseUrl) {
      catalog = new RemoteNodeCatalog(baseUrl)
      app.searchCatalog.set(catalog.cached())
    }
    const current = catalog!
    if (!app.searchOpen.get()) return
    void current.refresh().then((nodes) => {
      if (!disposed && catalog === current) app.searchCatalog.set(nodes)
    })
  }
  refresh()
  const stop = app.settings.changed.subscribe(() => refresh())
  const stopOpen = app.searchOpen.subscribe((open) => { if (open) refresh(true) })
  return () => { disposed = true; stop(); stopOpen() }
}

export function searchNodeSchema(app: AppState, action: SearchAction): NodeSchema | undefined {
  const decoded = decodeSearchHostAction(action)
  if (decoded === undefined || (decoded.action !== 'node.armPlacement' && decoded.action !== 'node.previewInstall')) return undefined
  const tab = app.activeTab()
  if (tab === undefined || tab.execution !== undefined || app.backendForTab(tab).id !== decoded.params.backendId) return undefined
  const installed = app.registryForTab(tab)?.resolve(decoded.params.type)
  if (decoded.action === 'node.armPlacement') return installed !== undefined && placementSchemaKey(installed) === decoded.params.schemaKey ? installed : undefined
  if (installed !== undefined) return undefined
  const entry = app.searchCatalog.get().find((entry) => entry.schema.type === decoded.params.type)
  return entry !== undefined && catalogNodeKey(entry) === decoded.params.schemaKey ? entry.schema : undefined
}

function duplicateNodeNames(schemas: readonly Pick<NodeSchema, 'type' | 'displayName'>[]): ReadonlySet<string> {
  const owner = new Map<string, string>()
  const duplicates = new Set<string>()
  for (const schema of schemas) {
    const prior = owner.get(schema.displayName)
    if (prior !== undefined && prior !== schema.type) duplicates.add(schema.displayName)
    else if (prior === undefined) owner.set(schema.displayName, schema.type)
  }
  return duplicates
}

export function runSearchAction(app: AppState, action: SearchAction): boolean {
  if (action.kind === 'command') {
    const tab = app.activeTab()
    return tab !== undefined && app.dispatchTo(tab, action.invocation).ok
  }
  const decoded = decodeSearchHostAction(action)
  if (decoded === undefined) return false
  if (decoded.action === 'command.run') {
    const command = app.commands.get(decoded.params.id)
    if (!command) return false
    command.run()
    return true
  }
  else if (decoded.action === 'settings.open') {
    app.settingsOpenRequest.set({ category: decoded.params.category, id: decoded.params.id ?? '' })
    app.modalPanel.set('settings')
    return true
  }
  else if (decoded.action === 'tab.activate') {
    const id = decoded.params.id
    if (!app.tabs.get().some((tab) => tab.id === id)) return false
    app.activeTabId.set(id)
    return true
  }
  else if (decoded.action === 'node.armPlacement') {
    return app.canvasBridge.get()?.armNodePlacement(decoded.params.type, {
      schemaKey: decoded.params.schemaKey,
      backendId: decoded.params.backendId,
    }) ?? false
  }
  else if (decoded.action === 'node.previewInstall') {
    const schema = searchNodeSchema(app, decoded)
    const tab = app.activeTab()
    if (schema === undefined || tab === undefined) return false
    const registry = app.registryForTab(tab)
    if (registry?.resolve(schema.type) !== undefined) return false
    const entry = app.searchCatalog.get().find((entry) => entry.schema === schema)
    if (entry === undefined || registry?.packs?.has(entry.pack.name)) return false
    app.nodeInstallRequest.set({ ...entry, backendId: decoded.params.backendId })
    return true
  }
  return false
}
