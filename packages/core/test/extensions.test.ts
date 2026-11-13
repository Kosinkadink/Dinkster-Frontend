/**
 * Extension manifests + gating host: packs enumerate contributions before
 * activating, the host registers only what gates admit, disabling
 * unregisters cleanly at every granularity, and deployment policy is
 * hard-off (user gates cannot override it). Nodes are untouched by design -
 * nothing here ever sees a schema.
 */
import { describe, expect, it } from 'vitest'
import { createMenuRegistry, type MenuContribution, type MenuContext } from '../src/menus/contract.js'
import { createSearchRegistry, type SearchContext, type SearchProvider } from '../src/search/contract.js'
import { decodeEffectiveExtensionSnapshot, frontendApiSatisfies, validateAuthoredManifest, validateManifest, type AuthoredPackManifest, type PackManifest } from '../src/extensions/manifest.js'
import { ExtensionHost, emptyGates, type GateState } from '../src/extensions/host.js'
import type { VirtualNodeKind } from '../src/virtual-node.js'
import type { PreviewRenderer, WidgetKind, WidgetRegistry, WidgetView } from '../src/widgets/contract.js'

/** Minimal contract-faithful widget registry (the real one lives in @dinkster/widgets). */
function fakeWidgets(): WidgetRegistry {
  const kinds = new Map<string, WidgetKind>()
  const views = new Map<string, WidgetView[]>()
  const editors = new Map<string, unknown>()
  const previews: PreviewRenderer[] = []
  return {
    registerKind(kind) {
      if (kinds.has(kind.type)) throw new Error(`dup kind ${kind.type}`)
      kinds.set(kind.type, kind)
      return () => void kinds.delete(kind.type)
    },
    registerView(view) {
      views.set(view.kind, [...(views.get(view.kind) ?? []), view])
      return () => views.set(view.kind, (views.get(view.kind) ?? []).filter((v) => v !== view))
    },
    registerEditor(widgetType, editor) {
      editors.set(widgetType, editor)
      return () => void editors.delete(widgetType)
    },
    registerPreviewRenderer(r) {
      previews.push(r)
      return () => void previews.splice(previews.indexOf(r), 1)
    },
    kind: (type) => kinds.get(type),
    viewsFor: (kindType) => views.get(kindType) ?? [],
    editorFor: (widgetType) => editors.get(widgetType),
    previewRendererFor: (channel) => previews.find((r) => r.canRender(channel)),
  }
}

const widgetKind = (type: string): WidgetKind => ({
  type,
  valueSchema: { version: 1, validate: (v): v is number => typeof v === 'number' },
  defaultValue: () => 0,
  validate: () => [],
  defaultView: () => `${type}.view`,
})

const menuContribution = (id: string): MenuContribution => ({
  id,
  targets: ['node'],
  group: '50-pack',
  resolve: () => [{ id: `${id}.item`, label: 'Pack item', action: { kind: 'host', action: 'noop' } }],
})

const nodeCtx = {
  target: { kind: 'node', nodeId: 'n1' },
  selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] },
  worldX: 0,
  worldY: 0,
} as unknown as MenuContext

const manifest = (over?: Partial<PackManifest>): PackManifest => ({
  id: 'rgthree',
  displayName: 'rgthree',
  contributions: [
    { id: 'rgthree.menu.muter', category: 'menu', label: 'Group muter menu' },
    { id: 'rgthree.widget.power', category: 'widgetKind', label: 'Power widget' },
  ],
  ...over,
})

function host(over?: { policy?: { allow?: string[]; deny?: string[] }; gates?: GateState }) {
  const menus = createMenuRegistry()
  const widgets = fakeWidgets()
  const textExtensions = new Map<string, { readonly id: string }>()
  const search = createSearchRegistry()
  const gateLog: GateState[] = []
  const h = new ExtensionHost({
    menus,
    widgets,
    registerTextEditorExtension: (extension) => {
      if (textExtensions.has(extension.id)) throw new Error(`dup text extension ${extension.id}`)
      textExtensions.set(extension.id, extension)
      return () => {
        if (textExtensions.get(extension.id) === extension) textExtensions.delete(extension.id)
      }
    },
    registerSearchProvider: (provider) => search.register(provider),
    beginRegistryBatch: () => search.beginBatch(),
    ...(over?.policy ? { policy: over.policy } : {}),
    initialGates: over?.gates ?? emptyGates,
    onGatesChanged: (g) => {
      gateLog.push(g)
    },
  })
  return { h, menus, widgets, textExtensions, search, gateLog }
}

/** Install the standard two-contribution pack; returns what it contributed. */
function installPack(h: ExtensionHost) {
  return h.register(manifest(), (api) => {
    api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
    api.widgetKind('rgthree.widget.power', widgetKind('rgthree.widget.power'))
  })
}

describe('validateManifest', () => {

  it('rejects bad pack ids, reserved core, foreign/duplicate contribution ids, unknown categories', () => {
    const cases: [PackManifest, string][] = [
      [manifest({ id: 'Bad Pack' }), 'extension.pack-id-invalid'],
      [manifest({ id: 'core' }), 'extension.pack-id-reserved'],
      [manifest({ id: 'core.sub' }), 'extension.pack-id-reserved'],
      [
        manifest({ contributions: [{ id: 'other.menu.x', category: 'menu' }] }),
        'extension.contribution-id-invalid',
      ],
      [
        manifest({
          contributions: [
            { id: 'rgthree.a', category: 'menu' },
            { id: 'rgthree.a', category: 'menu' },
          ],
        }),
        'extension.contribution-duplicate',
      ],
      [
        manifest({ contributions: [{ id: 'rgthree.a', category: 'not-real' as never }] }),
        'extension.category-unknown',
      ],
      [manifest({ uses: ['rgthree.widget.power'] }), 'extension.uses-own'],
    ]
    for (const [m, code] of cases) {
      expect(validateManifest(m).map((d) => d.code)).toContain(code)
    }
  })
})

it('rejects virtual node kinds without a virtual port-free schema', () => {
  const base: VirtualNodeKind = {
    id: 'notes.callout', title: 'Callout', defaultValues: {},
    schema: {
      type: 'notes.callout', virtual: true, displayName: 'Callout', category: 'Notes',
      source: 'v3', isOutputNode: false, items: [],
    },
    render: () => ({ text: '', format: 'plain' }),
  }
  const register = (kind: VirtualNodeKind) => {
    const h = new ExtensionHost({ menus: createMenuRegistry(), widgets: fakeWidgets() })
    return h.register({
      id: 'notes', contributions: [{ id: kind.id, category: 'virtualNode' }],
    }, (api) => api.virtualNode(kind.id, kind))
  }
  const { virtual: _virtual, ...executableSchema } = base.schema
  expect(register({ ...base, schema: executableSchema })).toContainEqual(
    expect.objectContaining({ code: 'extension.activate-failed' }),
  )
  expect(register({
    ...base,
    schema: {
      ...base.schema,
      items: [{
        kind: 'output', id: 'out',
        type: { kind: 'concrete', name: 'STRING' },
      }],
    },
  })).toContainEqual(expect.objectContaining({ code: 'extension.activate-failed' }))
})

describe('F0 authored and effective manifests', () => {
  const authored: AuthoredPackManifest = {
    id: 'comfy.monitor',
    version: '1.2.0',
    requires: { frontendApi: '>=1.0.0 <2.0.0' },
    entryPoints: { frontend: [{
      id: 'comfy.monitor.frontend.status',
      module: './dist/status.js',
      privileges: ['app-workflow'],
      contributions: [
        { id: 'comfy.monitor.ui.status', kind: 'hostUi' },
        { id: 'comfy.monitor.search.status', kind: 'searchProvider' },
      ],
    }] },
  }

  it('validates package-relative authored entry points, namespaces, privileges, and API ranges', () => {
    expect(validateAuthoredManifest(authored)).toEqual([])
    expect(frontendApiSatisfies('1.3.0', authored.requires.frontendApi)).toBe(true)
    expect(frontendApiSatisfies('2.0.0', authored.requires.frontendApi)).toBe(false)
    expect(validateAuthoredManifest({
      ...authored,
      entryPoints: { frontend: [{ ...authored.entryPoints.frontend[0]!, module: 'https://evil.test/code.js' }] },
    }).map((problem) => problem.code)).toContain('extension.module-path-invalid')
    expect(frontendApiSatisfies('0.3.0', '^0.2.3')).toBe(false)
    expect(frontendApiSatisfies('0.0.4', '^0.0.3')).toBe(false)
    expect(frontendApiSatisfies('1.0.0-alpha', '>=0.9.0')).toBe(false)
    expect(frontendApiSatisfies('1.0.0-alpha.01', '>=1.0.0-alpha')).toBe(false)
  })

  it('owns immutable backend module/event declarations and rejects asset identity drift', () => {
    const digest = `sha256:${'a'.repeat(64)}`
    const module = {
      id: 'demo.frontend', moduleUrl: `/api/extension-assets/demo/${digest}/demo.frontend.js`, moduleDigest: digest,
      authorizedPrivileges: ['event-consumer'], contributions: [{ id: 'demo.consumer', kind: 'eventConsumer', event: 'demo.initialized' }],
    }
    const decode = (entry = module) => decodeEffectiveExtensionSnapshot({
      format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{
        id: 'demo', version: '1.0.0', packageDigest: digest, contributionIds: [], selectorResolutions: [], serviceProviders: [],
        capabilities: ['accelerator', 'artifacts'], behaviorConfiguration: [], frontend: [entry],
        events: [{ name: 'demo.initialized', payload: { count: 'integer' } }],
      }],
    })
    const result = decode()
    expect(result.diagnostics).toEqual([])
    expect(result.snapshot?.extensions[0]?.frontend?.[0]).toEqual(module)
    expect(Object.isFrozen(result.snapshot?.extensions[0]?.frontend?.[0]?.contributions)).toBe(true)
    for (const change of [
      { moduleUrl: 'https://external.test/code.js' }, { moduleUrl: `${module.moduleUrl}?version=2` },
      { moduleDigest: `sha256:${'b'.repeat(64)}` }, { id: 'other.frontend' },
      { authorizedPrivileges: ['event-consumer', 'event-consumer'] }, { authorizedPrivileges: ['admin'] },
      { contributions: [{ id: 'demo.consumer', kind: 'eventConsumer', event: 'unnamespaced' }] },
    ]) expect(decode({ ...module, ...change }).snapshot).toBeUndefined()
    module.contributions[0]!.event = 'demo.changed'
    expect(result.snapshot?.extensions[0]?.frontend?.[0]?.contributions[0]?.event).toBe('demo.initialized')
  })
})

describe('ExtensionHost activation', () => {
  it('registers declared contributions into the real registries', () => {
    const { h, menus, widgets } = host()
    expect(installPack(h)).toEqual([])
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toContain('rgthree.menu.muter.item')
    expect(widgets.kind('rgthree.widget.power')).toBeDefined()
  })

  it('owns, bounds, gates, and disposes typed search-provider data', () => {
    const { h, search } = host()
    const contexts: SearchContext[] = []
    const raw = [{
      id: 'open-demo', title: 'Open demo', detail: 'Extension result', score: 1,
      action: { kind: 'host', action: 'settings.open', params: { category: 'demo' } },
      keywords: ['demo'],
      preview: { version: 1, description: 'Host-rendered detail', fields: [{ label: 'Source', value: 'Demo pack' }] },
    }]
    const searchManifest = manifest({ contributions: [
      { id: 'rgthree.search.demo', category: 'searchProvider' },
    ] })
    expect(h.register(searchManifest, (api) => {
      api.searchProvider('rgthree.search.demo', {
        id: 'rgthree.search.demo', label: 'Demo results', prefix: '?', priority: 25,
        query: (_query, context) => { contexts.push(context); return raw as never },
      })
    })).toEqual([])
    expect(search.list().map((provider) => provider.id)).toEqual(['rgthree.search.demo'])
    const controller = new AbortController()
    const request = search.query('? open', {
      activeTab: { id: 'tab-1', title: 'Workflow' }, selection: { nodes: ['node-1'] }, signal: controller.signal,
    })[0]!
    const results = request.results as readonly { readonly title: string; readonly preview?: object }[]
    raw[0]!.title = 'mutated after return'
    expect(results[0]?.title).toBe('Open demo')
    expect(Object.isFrozen(results)).toBe(true)
    expect(Object.isFrozen(results[0])).toBe(true)
    expect(Object.isFrozen(results[0]?.preview)).toBe(true)
    expect(Object.keys(contexts[0]!).sort()).toEqual(['activeTab', 'selection', 'signal'])
    expect(Object.keys(contexts[0]!.selection)).toEqual(['nodes'])
    expect(Object.isFrozen(contexts[0])).toBe(true)
    expect(Object.isFrozen(contexts[0]!.selection.nodes)).toBe(true)
    expect(contexts[0]!.signal).toBe(controller.signal)
    expect('document' in contexts[0]!).toBe(false)
    expect('canvas' in contexts[0]!).toBe(false)
    expect('socket' in contexts[0]!).toBe(false)

    h.setContributionEnabled('rgthree.search.demo', false)
    expect(search.list()).toEqual([])
    h.setContributionEnabled('rgthree.search.demo', true)
    expect(search.list().map((provider) => provider.id)).toEqual(['rgthree.search.demo'])
    h.unregister('rgthree')
    expect(search.list()).toEqual([])
  })

  it('rejects provider-owned presentation and malformed result data', () => {
    const badMetadata = host()
    const metadataOut = badMetadata.h.register(manifest({ contributions: [
      { id: 'rgthree.search.demo', category: 'searchProvider' },
    ] }), (api) => {
      api.searchProvider('rgthree.search.demo', {
        id: 'rgthree.search.demo', label: 'Demo', priority: 1, query: () => [], className: 'pack-ui',
      } as SearchProvider)
    })
    expect(metadataOut.map((problem) => problem.code)).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
    expect(badMetadata.search.list()).toEqual([])

    const malformed = host()
    expect(malformed.h.register(manifest({ contributions: [
      { id: 'rgthree.search.demo', category: 'searchProvider' },
    ] }), (api) => {
      api.searchProvider('rgthree.search.demo', {
        id: 'rgthree.search.demo', label: 'Demo', priority: 1,
        query: () => [{
          id: 'bad', title: 'Bad result', score: 1,
          action: { kind: 'host', action: 'settings.open' },
          preview: { version: 1, description: 'detail', className: 'pack-ui' },
        }] as never,
      })
    })).toEqual([])
    expect(() => malformed.search.query('', { selection: { nodes: [] }, signal: new AbortController().signal })).toThrow('invalid results')

    for (const action of [
      { kind: 'host', action: 'node.armPlacement', params: { type: 7, schemaKey: {}, backendId: [] } },
      { kind: 'host', action: 'settings.open', params: { category: 7, id: [] } },
      { kind: 'host', action: 'settings.open', params: { category: 'General', extra: 'unowned' } },
      { kind: 'host', action: 'unknown', params: { id: 'value' } },
    ]) {
      const boundary = host()
      expect(boundary.h.register(manifest({ contributions: [
        { id: 'rgthree.search.demo', category: 'searchProvider' },
      ] }), (api) => {
        api.searchProvider('rgthree.search.demo', {
          id: 'rgthree.search.demo', label: 'Demo', priority: 1,
          query: () => [{ id: 'bad', title: 'Bad result', score: 1, action }] as never,
        })
      })).toEqual([])
      expect(() => boundary.search.query('', { selection: { nodes: [] }, signal: new AbortController().signal })).toThrow('invalid results')
    }
  })

  it('refuses undeclared, mismatched, and doubled contributions with diagnostics', () => {
    const { h, menus, widgets } = host()
    const out = h.register(manifest(), (api) => {
      api.menu('rgthree.menu.ghost', menuContribution('rgthree.menu.ghost')) // undeclared
      api.widgetKind('rgthree.menu.muter', widgetKind('rgthree.menu.muter')) // declared as menu, not widgetKind
      api.menu('rgthree.menu.muter', menuContribution('rgthree.other.id')) // payload id mismatch
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter')) // twice
    })
    expect(out.map((d) => d.code)).toEqual([
      'extension.contribution-undeclared',
      'extension.contribution-undeclared',
      'extension.contribution-id-mismatch',
      'extension.contribution-twice',
      'extension.rollback-complete',
    ])
    // One invalid declaration rejects the transaction; no valid sibling leaks.
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(widgets.kind('rgthree.menu.muter')).toBeUndefined()
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
  })

  it('refuses manifests with errors wholesale (activate never runs) and duplicate packs', () => {
    const { h } = host()
    let ran = false
    const out = h.register(manifest({ id: 'core' }), () => {
      ran = true
    })
    expect(out.some((d) => d.code === 'extension.pack-id-reserved')).toBe(true)
    expect(ran).toBe(false)
    expect(installPack(h)).toEqual([])
    expect(h.register(manifest(), () => {}).map((d) => d.code)).toContain('extension.pack-duplicate')
  })

  it('activation throw aborts and rolls back every staged contribution and disposer', () => {
    const { h, menus } = host()
    const order: string[] = []
    const out = h.register(manifest(), (api) => {
      api.onDispose(() => order.push(`dispose:${api.signal.aborted}`))
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
      throw new Error('pack bug')
    })
    expect(out.map((d) => d.code)).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
    expect(order).toEqual(['dispose:true'])
  })

  it('requires every admitted snapshot contribution before committing', () => {
    const { h, menus } = host()
    const out = h.register(manifest(), (api) => {
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
    }, true)
    expect(out.map((d) => d.code)).toEqual(['extension.contribution-missing', 'extension.rollback-complete'])
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
  })

  it('unregister aborts and disposes resources in LIFO order', () => {
    const { h } = host()
    const order: string[] = []
    h.register(manifest(), (api) => {
      api.onDispose(() => order.push(`first:${api.signal.aborted}`))
      api.onDispose(() => order.push(`second:${api.signal.aborted}`))
    })
    h.unregister('rgthree')
    h.unregister('rgthree')
    expect(order).toEqual(['second:true', 'first:true'])
    expect(h.packs()).toEqual([])
  })

  it('continues deactivation after unregister and disposer failures', () => {
    const events: string[] = []
    const h = new ExtensionHost({
      menus: createMenuRegistry(), widgets: fakeWidgets(),
      registerSetting: () => () => { events.push('unregister-setting'); throw new Error('unregister failed') },
      registerCommand: () => () => events.push('unregister-command'),
    })
    const out = h.register({ id: 'cleanup', contributions: [
      { id: 'cleanup.setting', category: 'setting' },
      { id: 'cleanup.command', category: 'command' },
    ] }, (api) => {
      api.setting('cleanup.setting', { id: 'cleanup.setting', name: 'Setting', type: 'boolean', defaultValue: false })
      api.command('cleanup.command', { id: 'cleanup.command', label: 'Command', run() {} })
      api.onDispose(() => { events.push(`dispose-first:${api.signal.aborted}`) })
      api.onDispose(() => { events.push(`dispose-second:${api.signal.aborted}`); throw new Error('dispose failed') })
    })
    expect(out).toEqual([])
    h.unregister('cleanup')
    expect(events).toEqual(['unregister-command', 'unregister-setting', 'dispose-second:true', 'dispose-first:true'])
    expect(h.packs()).toEqual([])
  })

  it('closes the activation API after activate returns', () => {
    const { h } = host()
    let captured: Parameters<Parameters<ExtensionHost['register']>[1]>[0] | undefined
    expect(h.register(manifest(), (api) => { captured = api })).toEqual([])
    expect(() => captured!.onDispose(() => {})).toThrow('activation scope is closed')
    expect(() => captured!.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))).toThrow('activation scope is closed')
  })

  it("missing 'uses' providers warn by name; present providers stay silent", () => {
    const { h, widgets } = host()
    widgets.registerKind(widgetKind('kj.curve'))
    const out = h.register(manifest({ uses: ['kj.curve', 'kj.spline'] }), () => {})
    expect(out).toHaveLength(1)
    expect(out[0]!.severity).toBe('warning')
    expect(out[0]!.code).toBe('extension.uses-missing')
    expect(out[0]!.message).toContain('kj.spline')
  })
})

describe('gating', () => {
  it('pack gate: disabling unregisters everything; re-enabling restores it', () => {
    const { h, menus, widgets, gateLog } = host()
    installPack(h)
    h.setPackEnabled('rgthree', false)
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
    h.setPackEnabled('rgthree', true)
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toEqual(['rgthree.menu.muter.item'])
    expect(widgets.kind('rgthree.widget.power')).toBeDefined()
    expect(gateLog).toHaveLength(2) // persistence hook saw both flips
  })

  it('category gate: all menus off, widgets untouched', () => {
    const { h, menus, widgets } = host()
    installPack(h)
    h.setCategoryEnabled('rgthree', 'menu', false)
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(widgets.kind('rgthree.widget.power')).toBeDefined()
  })

  it('contribution gate: one feature off, siblings untouched', () => {
    const { h, menus, widgets } = host()
    installPack(h)
    h.setContributionEnabled('rgthree.widget.power', false)
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toEqual(['rgthree.menu.muter.item'])
  })

  it('initial gates apply before activation registers anything', () => {
    const { h, menus } = host({
      gates: { packs: {}, categories: {}, contributions: { 'rgthree.menu.muter': false } },
    })
    installPack(h)
    expect(menus.resolve(nodeCtx)).toEqual([])
  })

  it('gate flips are idempotent and never double-register', () => {
    const { h, menus } = host()
    installPack(h)
    h.setPackEnabled('rgthree', true) // already on: no-op
    h.setContributionEnabled('rgthree.menu.muter', true)
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toEqual(['rgthree.menu.muter.item'])
  })

})

describe('deployment policy', () => {
  it('deny is hard-off: user gates cannot re-enable', () => {
    const { h, widgets } = host({ policy: { deny: ['rgthree.widget.power'] } })
    installPack(h)
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
    h.setContributionEnabled('rgthree.widget.power', true)
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
    const status = h.packs()[0]!.contributions.find((c) => c.decl.id === 'rgthree.widget.power')!
    expect(status.policyBlocked).toBe(true)
    expect(status.active).toBe(false)
  })

  it('deny at category and pack granularity', () => {
    const a = host({ policy: { deny: ['rgthree/menu'] } })
    installPack(a.h)
    expect(a.menus.resolve(nodeCtx)).toEqual([])
    expect(a.widgets.kind('rgthree.widget.power')).toBeDefined()

    const b = host({ policy: { deny: ['rgthree'] } })
    installPack(b.h)
    expect(b.menus.resolve(nodeCtx)).toEqual([])
    expect(b.widgets.kind('rgthree.widget.power')).toBeUndefined()
  })

  it('nonempty allow list admits only what it names', () => {
    const { h, menus, widgets } = host({ policy: { allow: ['rgthree/menu'] } })
    installPack(h)
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toEqual(['rgthree.menu.muter.item'])
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
  })

})

describe('registry identity conflicts', () => {
  it('a taken identity rolls back the whole initial registry commit', () => {
    const { h, menus, widgets } = host()
    const freeIdentity = widgets.registerKind(widgetKind('rgthree.widget.power')) // direct registrant got there first
    const out = installPack(h)
    expect(out.map((d) => d.code)).toEqual(['extension.contribution-conflict', 'extension.rollback-complete'])
    expect(out[0]!.message).toContain('rgthree.widget.power')
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
    freeIdentity()
    expect(installPack(h)).toEqual([])
    expect(widgets.kind('rgthree.widget.power')).toBeDefined()
    expect(h.packs()).toHaveLength(1)
    expect(h.packs()[0]).toMatchObject({ registered: true, active: true })
  })
})
