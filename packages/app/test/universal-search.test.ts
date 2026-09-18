import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DinksterNodesPayload, SearchResult } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { KeybindingRegistry, SettingsRegistry } from '../src/settings.js'
import { nodeSearchDetail, recordSearchRecent, registerCoreSearchProviders, runSearchAction, SEARCH_RECENTS_SETTING, searchRecents } from '../src/universal-search.js'

beforeAll(() => { Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true }) })

const settings = () => {
  const values = new Map<string, string>()
  const registry = new SettingsRegistry({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) })
  registry.register({ id: SEARCH_RECENTS_SETTING, name: 'Recents', type: 'string', defaultValue: '[]' })
  return registry
}

describe('universal search model', () => {
  it('distinguishes duplicate node display names without changing canonical result identity', () => {
    const schemas = [
      { type: 'dinkster.preview_any', displayName: 'Preview as Text', category: 'utilities', pack: 'core' },
      { type: 'comfy.PreviewAny', displayName: 'Preview as Text', category: 'comfy/utilities', pack: 'comfy' },
      { type: 'dinkster.save_target', displayName: 'Save Target', category: 'utilities', pack: 'core' },
    ] as const
    const packs = new Map([
      ['core', { displayName: 'Dinkster Core' }],
      ['comfy', { displayName: 'ComfyUI' }],
    ])
    const duplicates = new Set(['Preview as Text'])

    expect(nodeSearchDetail(schemas[0], duplicates, packs)).toBe('Dinkster Core - utilities - dinkster.preview_any')
    expect(nodeSearchDetail(schemas[1], duplicates, packs)).toBe('ComfyUI - comfy/utilities - comfy.PreviewAny')
    expect(nodeSearchDetail(schemas[2], duplicates, packs)).toBe('utilities')
    expect(schemas.map((schema) => schema.type)).toEqual(['dinkster.preview_any', 'comfy.PreviewAny', 'dinkster.save_target'])
  })

  it('persists unique, capped frecency activations', () => {
    const registry = settings()
    for (let i = 0; i < 25; i++) recordSearchRecent(registry, `item-${i}`)
    recordSearchRecent(registry, 'item-10')
    expect(searchRecents(registry)).toHaveLength(20)
    expect(searchRecents(registry)[0]).toBe('item-10')
    expect(new Set(searchRecents(registry)).size).toBe(20)
  })
  it('search.open is an ordinary rebindable keybinding', () => {
    const registry = settings(); const bindings = new KeybindingRegistry(registry)
    bindings.register({ command: 'search.open', combo: 'Ctrl+K' })
    expect(bindings.combo('search.open')).toBe('ctrl+k')
    bindings.set('search.open', 'Alt+K')
    expect(bindings.combo('search.open')).toBe('alt+k')
  })
  it('AppState registers search.open with default Ctrl+K and supports rebinding', () => {
    const app = new AppState()
    expect(app.commands.get('search.open')?.label).toBe('Search Dinkster')
    expect(app.keybindings.combo('search.open')).toBe('ctrl+k')
    app.keybindings.set('search.open', 'Alt+K')
    expect(app.keybindings.combo('search.open')).toBe('alt+k')
  })
  it('commands provider displays the effective shortcut including overrides', () => {
    const app = new AppState(); app.keybindings.set('search.open', 'Alt+K')
    const dispose = registerCoreSearchProviders(app)
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.commands')!
    const rows = provider.query('Search Dinkster', { selection: { nodes: [] }, signal: new AbortController().signal }) as readonly SearchResult[]
    expect(rows.find((row) => row.id === 'search.open')?.detail).toBe('alt+k')
    dispose.forEach((fn) => fn())
  })
  it('commands provider discovers and activates Customize layout', () => {
    const app = new AppState(); const dispose = registerCoreSearchProviders(app)
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.commands')!
    const rows = provider.query('Customize layout', { selection: { nodes: [] }, signal: new AbortController().signal }) as readonly SearchResult[]
    const row = rows.find((item) => item.id === 'layout.customize')!
    expect(row.title).toBe('Customize layout')
    expect(runSearchAction(app, row.action)).toBe(true)
    expect(app.modalPanel.get()).toBe('customize-layout')
    dispose.forEach((fn) => fn())
  })
  it('commands provider discovers the create-empty-subgraph action', () => {
    const app = new AppState(); const dispose = registerCoreSearchProviders(app)
    const createEmptySubgraph = vi.fn(() => true)
    app.canvasBridge.set({ createEmptySubgraph } as never)
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.commands')!
    const rows = provider.query('Create empty subgraph', { selection: { nodes: [] }, signal: new AbortController().signal }) as readonly SearchResult[]
    const row = rows.find((item) => item.id === 'subgraph.createEmpty')!
    expect(row.title).toBe('Create empty subgraph')
    expect(runSearchAction(app, row.action)).toBe(true)
    expect(createEmptySubgraph).toHaveBeenCalledOnce()
    dispose.forEach((fn) => fn())
  })
  it('discovers lifecycle actions, gates them through the canvas bridge, and invokes their shortcuts', () => {
    const app = new AppState(); const dispose = registerCoreSearchProviders(app)
    const extractSubgraph = vi.fn(() => true)
    const flattenSubgraph = vi.fn(() => true)
    app.canvasBridge.set({
      extractSubgraph, flattenSubgraph,
      canExtractSubgraph: () => true,
      canFlattenSubgraph: () => false,
    } as never)
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.commands')!
    const context = { selection: { nodes: [] }, signal: new AbortController().signal }
    const extract = (provider.query('Extract selection as subgraph', context) as readonly SearchResult[]).find((item) => item.id === 'subgraph.extract')!
    const flatten = (provider.query('Flatten selected subgraph', context) as readonly SearchResult[]).find((item) => item.id === 'subgraph.flatten')!
    expect(extract.detail).toBe('ctrl+shift+e')
    expect(flatten.detail).toBe('ctrl+shift+f')
    expect(app.commands.get('subgraph.extract')?.enabled?.()).toBe(true)
    expect(app.commands.get('subgraph.flatten')?.enabled?.()).toBe(false)
    expect(runSearchAction(app, extract.action)).toBe(true)
    app.commands.get('subgraph.flatten')!.run()
    expect(extractSubgraph).toHaveBeenCalledOnce()
    expect(flattenSubgraph).toHaveBeenCalledOnce()
    dispose.forEach((fn) => fn())
  })
  it('commands provider automatically discovers workflow file import and export', () => {
    const app = new AppState(); const dispose = registerCoreSearchProviders(app)
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.commands')!
    const context = { selection: { nodes: [] }, signal: new AbortController().signal }
    const importRows = provider.query('Import workflow from file', context) as readonly SearchResult[]
    const exportRows = provider.query('Export workflow', context) as readonly SearchResult[]
    expect(importRows.find((item) => item.id === 'workflow.importFile')?.title).toBe('Import workflow from file')
    expect(exportRows.find((item) => item.id === 'workflow.export')?.title).toBe('Export workflow')
    dispose.forEach((fn) => fn())
  })
  it('commands provider opens the Backends panel for runtime settings discovery', () => {
    const app = new AppState(); const dispose = registerCoreSearchProviders(app)
    const unregister = app.panels.register({
      id: 'backends', title: 'Backends', placement: 'dock', allowedPlacements: ['dock'], order: 1,
      component: () => undefined,
    })
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.commands')!
    const rows = provider.query('Open Backends', { selection: { nodes: [] }, signal: new AbortController().signal }) as readonly SearchResult[]
    const row = rows.find((item) => item.id === 'backend.open')!
    expect(runSearchAction(app, row.action)).toBe(true)
    expect(app.dock.effective().zones.left).toMatchObject({
      sections: [{ activeTab: 'backends' }],
      open: true,
    })
    unregister()
    dispose.forEach((fn) => fn())
  })
  it('settings provider reuses the index action and opens focused category request', () => {
    const app = new AppState(); const dispose = registerCoreSearchProviders(app)
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.settings')!
    const rows = provider.query('grid', { selection: { nodes: [] }, signal: new AbortController().signal }) as readonly SearchResult[]
    const row = rows.find((item) => item.id === 'canvas.grid.visible')!
    runSearchAction(app, row.action)
    expect(app.modalPanel.get()).toBe('settings')
    expect(app.settingsOpenRequest.get()).toEqual({ category: 'canvas.grid', id: 'canvas.grid.visible' })
    expect((provider.query('recent activations', { selection: { nodes: [] }, signal: new AbortController().signal }) as readonly SearchResult[]).some((item) => item.id === SEARCH_RECENTS_SETTING)).toBe(false)
    dispose.forEach((fn) => fn())
  })
  it('tabs provider activation selects the requested tab', () => {
    const app = new AppState(); const before = app.createWorkflow(); const after = app.createWorkflow()
    app.activeTabId.set(before.id)
    expect(runSearchAction(app, { kind: 'host', action: 'tab.activate', params: { id: after.id } })).toBe(true)
    expect(app.activeTabId.get()).toBe(after.id)
    expect(runSearchAction(app, { kind: 'host', action: 'tab.activate', params: { id: 'gone' } })).toBe(false)
  })
  it('nodes provider emits placement actions that survive strict host-action decoding', () => {
    // Real catalog schemas serialize far past the search contract's string
    // param cap; the emitted schemaKey must stay a short digest or every
    // activation dies inside decodeSearchHostAction.
    const nodesPayload = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../core/fixtures/dinkster-nodes-comfy.json'), 'utf8',
    )) as DinksterNodesPayload
    const app = new AppState()
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
    const armNodePlacement = vi.fn(() => true)
    app.canvasBridge.set({ armNodePlacement } as never)
    const dispose = registerCoreSearchProviders(app)
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.nodes')!
    const rows = provider.query('Empty Image', { selection: { nodes: [] }, signal: new AbortController().signal }) as readonly SearchResult[]
    const row = rows.find((item) => item.id === 'comfy.EmptyImage')!
    expect(runSearchAction(app, row.action)).toBe(true)
    expect(armNodePlacement).toHaveBeenCalledWith('comfy.EmptyImage', {
      schemaKey: expect.stringMatching(/^[0-9a-f]{16}$/) as string,
      backendId: backend.id,
    })
    dispose.forEach((fn) => fn())
  })
  it('forwards the Search result schema and backend snapshot to placement arming', () => {
    const app = new AppState()
    const armNodePlacement = vi.fn(() => true)
    app.canvasBridge.set({ armNodePlacement } as never)

    expect(runSearchAction(app, {
      kind: 'host',
      action: 'node.armPlacement',
      params: { type: 'KSampler', schemaKey: 'schema-a', backendId: 'backend-a' },
    })).toBe(true)
    expect(armNodePlacement).toHaveBeenCalledWith('KSampler', {
      schemaKey: 'schema-a',
      backendId: 'backend-a',
    })
  })
  it('rejects malformed host actions before settings or canvas effects', () => {
    const app = new AppState()
    const armNodePlacement = vi.fn(() => true)
    app.canvasBridge.set({ armNodePlacement } as never)
    const initialRequest = app.settingsOpenRequest.get()
    const initialModal = app.modalPanel.get()

    expect(runSearchAction(app, {
      kind: 'host', action: 'node.armPlacement',
      params: { type: 7, schemaKey: {}, backendId: [] },
    } as never)).toBe(false)
    expect(runSearchAction(app, {
      kind: 'host', action: 'node.armPlacement',
      params: { type: undefined, schemaKey: undefined, backendId: undefined },
    } as never)).toBe(false)
    expect(runSearchAction(app, {
      kind: 'host', action: 'settings.open',
      params: { category: 7, id: [] },
    } as never)).toBe(false)
    expect(runSearchAction(app, {
      kind: 'host', action: 'settings.open',
      params: { category: undefined },
    } as never)).toBe(false)
    expect(runSearchAction(app, {
      kind: 'host', action: 'settings.open',
      params: { category: 'General', extra: 'unowned' },
    } as never)).toBe(false)
    expect(armNodePlacement).not.toHaveBeenCalled()
    expect(app.settingsOpenRequest.get()).toBe(initialRequest)
    expect(app.modalPanel.get()).toBe(initialModal)
  })
})
