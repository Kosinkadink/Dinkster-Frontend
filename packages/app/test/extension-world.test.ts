import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildDinksterRegistry, type DinksterSubmitResult } from '@dinkster/client'
import { asConnectionId, asPromptId, createMenuRegistry, createSearchRegistry, createSignal, type EffectiveExtensionSnapshot, type ExtensionEvent, type ExtensionHostOptions, type FrontendContributionKind, type FrontendPrivilege } from '@dinkster/core'
import { createTextWidgetEditorExtensionRegistry, createWidgetRegistry, type TextWidgetEditorExtension } from '@dinkster/widgets'
import { ExtensionWorld, type FrontendActivationContext } from '../src/extension-world.js'
import { HostUiContributionRegistry } from '../src/host-ui.js'
import { CommandRegistry, KeybindingRegistry, SettingsRegistry } from '../src/settings.js'
import { AppState, type Backend, type Tab } from '../src/app-state.js'

function setup() {
  const settings = new SettingsRegistry(undefined)
  const commands = new CommandRegistry()
  const bindings = new KeybindingRegistry(settings)
  const ui = new HostUiContributionRegistry()
  const text = createTextWidgetEditorExtensionRegistry()
  const search = createSearchRegistry()
  const editors: unknown[] = []
  const editorBindings: unknown[] = []
  const panels: unknown[] = []
  const target: ExtensionHostOptions<TextWidgetEditorExtension> = {
    menus: createMenuRegistry(), widgets: createWidgetRegistry(), changedSignal: createSignal(0),
    registerSetting: (value) => settings.register(value),
    registerCommand: (value) => commands.register(value),
    registerKeybinding: (value) => bindings.register(value),
    registerHostUi: (...args) => ui.register(...args),
    invalidateHostUi: (id) => ui.invalidate(id),
    registerTextEditorExtension: (value) => text.register(value),
    registerSearchProvider: (value) => search.register(value),
    registerEditor: (value) => { editors.push(value); return () => { editors.splice(editors.indexOf(value), 1) } },
    registerEditorBinding: (value) => { editorBindings.push(value); return () => { editorBindings.splice(editorBindings.indexOf(value), 1) } },
    registerPanel: (value) => { panels.push(value); return () => { panels.splice(panels.indexOf(value), 1) } },
  }
  return { target, commands, ui, editors, editorBindings, panels }
}

const digest = `sha256:${'a'.repeat(64)}`
function snapshotFor(kind: FrontendContributionKind, privilege: FrontendPrivilege): EffectiveExtensionSnapshot {
  return {
    format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{
      id: 'demo', version: '1.0.0', packageDigest: digest, contributionIds: [], selectorResolutions: [], serviceProviders: [], capabilities: [], behaviorConfiguration: [],
      events: [{ name: 'demo.event', payload: { value: 'integer' } }],
      frontend: [{ id: 'demo.entry', moduleUrl: `/api/extension-assets/demo/${digest}/demo.entry.js`, moduleDigest: digest, authorizedPrivileges: [privilege],
        contributions: [{ id: 'demo.contribution', kind, ...(kind === 'eventConsumer' ? { event: 'demo.event' } : {}) }],
      }],
    }],
  }
}

const extensionEvent = (seq: number): ExtensionEvent => ({
  kind: 'extensionEvent', execution: { connection: asConnectionId('a'), prompt: asPromptId('job') }, timestamp: 0,
  extensionSnapshotDigest: digest, event: 'demo.event', pack: 'demo', schemaVersion: 1, data: { value: seq }, seq,
})

describe('connection extension worlds', () => {
  it.each([
    ['widgetKind', 'schema-widget'], ['menu', 'graph-editor-canvas'], ['setting', 'app-workflow'], ['eventConsumer', 'event-consumer'],
  ] as const)('restricts %s before importing code without widening another privilege', async (kind, privilege) => {
    const { target } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), digest, target)
    const load = vi.fn()
    await world.activate(snapshotFor(kind, privilege), '', [privilege], load)
    expect(load).not.toHaveBeenCalled()
    expect(world.host.packs()[0]?.registered).toBe(true)
    expect(world.host.packs()[0]?.contributions[0]?.active).toBe(false)
    const unauthorized = new ExtensionWorld(asConnectionId('b'), digest, target)
    await unauthorized.activate(snapshotFor(kind, privilege === 'event-consumer' ? 'app-workflow' : 'event-consumer'), '', [], load)
    expect(load).not.toHaveBeenCalled()
    expect(unauthorized.host.packs()[0]?.registered).toBe(false)
    world.dispose()
    unauthorized.dispose()
  })

  it('delivers only declared producer events asynchronously and cancels queued delivery on gate changes', async () => {
    const { target } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), digest, target)
    const received: ExtensionEvent[] = []
    await world.activate(snapshotFor('eventConsumer', 'event-consumer'), '', [], async () => ({
      frontendExtension: { activate(context: FrontendActivationContext) {
        expect(Object.isFrozen(context.identity)).toBe(true)
        context.eventConsumer('demo.contribution', (event) => received.push(event))
      } },
    }))
    world.deliver({ ...extensionEvent(0), pack: 'wrong' })
    world.deliver({ ...extensionEvent(0), execution: { connection: asConnectionId('b'), prompt: asPromptId('job') } })
    world.deliver({ ...extensionEvent(0), extensionSnapshotDigest: 'wrong' })
    world.deliver(extensionEvent(1))
    expect(received).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received.map((event) => event.seq)).toEqual([1])
    world.deliver(extensionEvent(2))
    world.host.setContributionEnabled('demo.contribution', false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received.map((event) => event.seq)).toEqual([1])
    world.host.setContributionEnabled('demo.contribution', true)
    for (let seq = 3; seq < 103; seq++) world.deliver(extensionEvent(seq))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received.map((event) => event.seq)).toEqual([1, ...Array.from({ length: 64 }, (_, index) => index + 39)])
    world.dispose()
    world.deliver(extensionEvent(103))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toHaveLength(65)
  })

  it('rolls back a caught scope violation instead of admitting sibling registrations', async () => {
    const { target } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), digest, target)
    await world.activate(snapshotFor('eventConsumer', 'event-consumer'), '', [], async () => ({
      frontendExtension: { activate(context: FrontendActivationContext) {
        context.eventConsumer('demo.contribution', () => {})
        try { context.command('demo.command', { id: 'demo.command', label: 'Forbidden', run() {} }) } catch {}
      } },
    }))
    expect(world.host.packs()[0]?.registered).toBe(false)
    expect(world.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
    world.dispose()
  })

  it('does not activate a module that finishes loading after disposal', async () => {
    const { target } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), digest, target)
    let resolve!: (value: unknown) => void
    const activate = vi.fn()
    const loading = world.activate(snapshotFor('eventConsumer', 'event-consumer'), '', [], () => new Promise((done) => { resolve = done }))
    world.dispose()
    resolve({ frontendExtension: { activate } })
    await loading
    expect(activate).not.toHaveBeenCalled()
    expect(world.host.packs()).toEqual([])
  })

  it.each(['GET', 'POST'] as const)('confines %s queries to typed own-pack snapshot routes and tears them down', async (method) => {
    const { target, ui } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), digest, target)
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { href: 'http://test/', origin: 'http://test' } })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"count":4}', { headers: {
      'Content-Type': 'application/json', 'X-Dinkster-Extension-Snapshot': digest,
    } }))
    let context!: FrontendActivationContext
    const base = snapshotFor('hostUi', 'app-workflow')
    const input = method === 'POST' ? { count: 4 } : {}
    try {
      await world.activate({ ...base, extensions: [{ ...base.extensions[0]!, routes: [{
        id: 'policy', method, handler: 'demo:policy', request: method === 'POST' ? { count: 'integer' } : {}, response: { count: 'integer' },
      }] }] }, '/a', [], async () => ({ frontendExtension: { activate(api: FrontendActivationContext) {
        context = api
        api.hostUi('demo.contribution', 'status.trailing', () => ({ version: 1, root: { kind: 'text', key: 'text', text: 'Preview' } }))
      } } }))
      world.select(true)
      const before = ui.list('status.trailing')[0]
      context.invalidateHostUi('demo.contribution')
      expect(ui.list('status.trailing')[0]).not.toBe(before)
      expect(() => context.invalidateHostUi('other.contribution')).toThrow('cannot invalidate')
      await expect(context.queryRoute('other.policy', { count: 4 })).rejects.toThrow('undeclared own-pack')
      await expect(context.queryRoute('policy', { count: 4.5 })).rejects.toThrow('undeclared own-pack')
      expect(fetch).not.toHaveBeenCalled()
      const result = await context.queryRoute('policy', input)
      expect(result).toEqual({ count: 4 })
      expect(Object.isFrozen(result)).toBe(true)
      const [url, init] = fetch.mock.calls[0]!
      expect(String(url)).toBe('http://test/a/api/extensions/demo/routes/policy')
      expect(init?.method).toBe(method)
      expect(init?.headers).toMatchObject({ 'If-Match': digest })
      expect(init?.body).toBe(method === 'POST' ? '{"count":4}' : undefined)
      fetch.mockResolvedValueOnce(new Response('{"count":4}', { headers: { 'Content-Type': 'application/json', 'X-Dinkster-Extension-Snapshot': 'other' } }))
      await expect(context.queryRoute('policy', input)).rejects.toThrow('unpaired response')
      fetch.mockResolvedValueOnce(new Response('{"count":"bad"}', { headers: { 'Content-Type': 'application/json', 'X-Dinkster-Extension-Snapshot': digest } }))
      await expect(context.queryRoute('policy', input)).rejects.toThrow('does not match')
      fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      }))
      const pending = context.queryRoute('policy', input)
      await Promise.resolve()
      world.dispose()
      await expect(pending).rejects.toThrow('cancelled')
      expect(init?.signal?.aborted).toBe(true)
      expect(() => context.invalidateHostUi('demo.contribution')).not.toThrow()
    } finally {
      world.dispose()
      fetch.mockRestore()
      if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
      else Reflect.deleteProperty(globalThis, 'location')
    }
  })

  it('never grants a route query or UI invalidation to an event-only consumer', async () => {
    const { target } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), digest, target)
    let context!: FrontendActivationContext
    await world.activate(snapshotFor('eventConsumer', 'event-consumer'), '', [], async () => ({ frontendExtension: { activate(api: FrontendActivationContext) {
      context = api
      api.eventConsumer('demo.contribution', () => {})
    } } }))
    await expect(context.queryRoute('policy')).rejects.toThrow('app-workflow authority')
    expect(() => context.invalidateHostUi('demo.contribution')).toThrow('cannot invalidate')
    world.dispose()
  })

  it('isolates a throwing consumer without blocking sibling queues', async () => {
    const { target } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), digest, target)
    const base = snapshotFor('eventConsumer', 'event-consumer')
    const pack = base.extensions[0]!
    const entry = pack.frontend![0]!
    const consume = vi.fn()
    await world.activate({ ...base, extensions: [{ ...pack, frontend: [{ ...entry, contributions: [
      ...entry.contributions, { id: 'demo.other', kind: 'eventConsumer', event: 'demo.event' },
    ] }] }] }, '', [], async () => ({ frontendExtension: { activate(context: FrontendActivationContext) {
      context.eventConsumer('demo.contribution', () => { throw new Error('bad observer') })
      context.eventConsumer('demo.other', consume)
    } } }))
    world.deliver(extensionEvent(1))
    world.deliver(extensionEvent(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(consume).toHaveBeenCalledTimes(2)
    expect(world.diagnostics.map((item) => item.code)).toEqual(['extension.consumer-failed'])
    world.dispose()
  })

  it('selects the paired connection world when a live tab changes backend', async () => {
    ;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }
    const app = new AppState()
    try {
      const tab = app.tabs.get()[0]!
      const a = app.addBackend('/a', 'A', false, 'dinkster')!
      const b = app.addBackend('/b', 'B', false, 'dinkster')!
      for (const backend of [a, b]) {
        vi.spyOn(backend, 'refreshDiagnostics').mockImplementation(() => {})
        vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue({
          connection: backend.id, hash: 'hash', schemas: new Map(), diagnostics: [], resolve: () => undefined,
          extensionSnapshotPair: {
            digest: `sha256:${'a'.repeat(64)}`,
            snapshot: { format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [] },
          },
        })
        await app.refreshBackendSchemas(backend)
        app.setTabTarget(tab.id, backend.id)
        expect(app.extensions.register({ id: 'demo', contributions: [{ id: 'demo.command', category: 'command' }] }, (api) => {
          api.command('demo.command', { id: 'demo.command', label: backend.label, run: () => {} })
        })).toEqual([])
        expect(app.commands.get('demo.command')?.label).toBe(backend.label)
      }
      app.setTabTarget(tab.id, a.id)
      expect(app.commands.get('demo.command')?.label).toBe('A')
      app.removeBackend(a.id)
      expect(app.commands.get('demo.command')).toBeUndefined()
      app.setTabTarget(tab.id, b.id)
      expect(app.commands.get('demo.command')?.label).toBe('B')
    } finally {
      app.dispose()
    }
  })

  it('retains the compiled world for a frozen run and disposes it after eviction', async () => {
    ;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }
    const app = new AppState()
    try {
      const tab = app.tabs.get()[0]!
      const backend = app.addBackend('/frozen', 'Frozen', false, 'dinkster')!
      const nodes = JSON.parse(readFileSync(new URL('../../core/fixtures/dinkster-nodes-comfy.json', import.meta.url), 'utf8'))
      const registry = buildDinksterRegistry(backend.id, nodes)
      const snapshot: EffectiveExtensionSnapshot = { format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [] }
      const fetch = vi.spyOn(backend.connection, 'fetchSchemas')
      vi.spyOn(backend, 'refreshDiagnostics').mockImplementation(() => {})
      fetch.mockResolvedValue({ ...registry, extensionSnapshotPair: { digest, snapshot } })
      await app.refreshBackendSchemas(backend)
      app.setTabTarget(tab.id, backend.id)
      const oldHost = app.extensions
      const dispose = vi.fn()
      oldHost.register({ id: 'demo', contributions: [{ id: 'demo.command', category: 'command' }] }, (api) => {
        api.command('demo.command', { id: 'demo.command', label: 'Frozen version', run() {} })
        api.onDispose(dispose)
      })
      const compiled = app.compileTab(tab)
      if (!compiled?.ok) throw new Error('fixture compile failed')
      const ref = { connection: backend.id, prompt: asPromptId('frozen') }
      app.registerRun(tab, ref, compiled.artifact)
      app.store.apply({ kind: 'completed', execution: ref, timestamp: 1 })
      expect(app.openExecutionView(ref)).toBe(true)
      const frozenTab = app.activeTab()!
      fetch.mockResolvedValue({ ...registry, extensionSnapshotPair: { digest: `sha256:${'b'.repeat(64)}`, snapshot } })
      await app.refreshBackendSchemas(backend)
      expect(app.extensions).toBe(oldHost)
      expect(app.commands.get('demo.command')?.label).toBe('Frozen version')
      expect(dispose).not.toHaveBeenCalled()
      app.activeTabId.set(tab.id)
      expect(app.extensions).not.toBe(oldHost)
      expect(app.commands.get('demo.command')).toBeUndefined()
      app.closeTab(frozenTab.id)
      const now = Date.now()
      for (let i = 0; i < 201; i++) {
        const churn = { connection: backend.id, prompt: asPromptId(`churn-${i}`) }
        app.store.apply({ kind: 'started', execution: churn, timestamp: now + i })
        app.store.apply({ kind: 'completed', execution: churn, timestamp: now + i })
      }
      expect(app.store.get(ref)).toBeUndefined()
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally { app.dispose() }
  })

  it('keeps conflicting versions isolated and switches presentation without reactivation', () => {
    const { target, commands } = setup()
    const a = new ExtensionWorld(asConnectionId('a'), 'snapshot-a', target)
    const b = new ExtensionWorld(asConnectionId('b'), 'snapshot-b', target)
    let activations = 0
    for (const [world, label] of [[a, 'A'], [b, 'B']] as const) {
      expect(world.host.register({ id: 'demo', contributions: [{ id: 'demo.command', category: 'command' }] }, (api) => {
        activations++
        api.command('demo.command', { id: 'demo.command', label, run: () => {} })
      })).toEqual([])
    }
    expect(commands.get('demo.command')).toBeUndefined()
    a.select(true)
    expect(commands.get('demo.command')?.label).toBe('A')
    a.select(false)
    b.select(true)
    expect(commands.get('demo.command')?.label).toBe('B')
    b.select(false)
    a.select(true)
    expect(commands.get('demo.command')?.label).toBe('A')
    expect(activations).toBe(2)
    a.dispose()
    b.dispose()
    expect(commands.get('demo.command')).toBeUndefined()
  })

  it('rolls back failed activation and aborts/disposes only its own instance', () => {
    const { target, commands } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), 'snapshot-a', target)
    const calls: string[] = []
    const diagnostics = world.host.register({ id: 'demo', contributions: [{ id: 'demo.command', category: 'command' }] }, (api) => {
      api.onDispose(() => calls.push(`first:${api.signal.aborted}`))
      api.onDispose(() => calls.push(`second:${api.signal.aborted}`))
      api.command('demo.command', { id: 'demo.command', label: 'Bad', run: () => {} })
      throw new Error('activation failed')
    })
    expect(diagnostics.map((item) => item.code)).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
    world.select(true)
    expect(commands.get('demo.command')).toBeUndefined()
    expect(calls).toEqual(['second:true', 'first:true'])
    world.dispose()
    expect(calls).toHaveLength(2)
  })

  it('projects contribution gates only for the selected world', () => {
    const { target, commands } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), 'snapshot-a', target)
    world.host.register({ id: 'demo', contributions: [{ id: 'demo.command', category: 'command' }] }, (api) => {
      api.command('demo.command', { id: 'demo.command', label: 'A', run: () => {} })
    })
    world.host.setPackEnabled('demo', false)
    world.select(true)
    expect(commands.get('demo.command')).toBeUndefined()
    world.host.setPackEnabled('demo', true)
    expect(commands.get('demo.command')?.label).toBe('A')
    world.select(false)
    world.host.setPackEnabled('demo', false)
    world.host.setPackEnabled('demo', true)
    expect(commands.get('demo.command')).toBeUndefined()
    world.dispose()
  })

  it('projects API 1.1 editor doors only while the snapshot world is selected', async () => {
    const { target, editors, editorBindings, panels } = setup()
    const world = new ExtensionWorld(asConnectionId('a'), digest, target)
    const base = snapshotFor('editor', 'app-workflow')
    const pack = base.extensions[0]!
    const entry = pack.frontend![0]!
    const contributions = [
      { id: 'demo.editor', kind: 'editor' as const },
      { id: 'demo.binding', kind: 'editorBinding' as const },
      { id: 'demo.panel', kind: 'panel' as const },
    ]
    await world.activate({
      ...base,
      frontendApi: '1.1.0',
      extensions: [{ ...pack, frontend: [{ ...entry, contributions }] }],
    }, '', [], async () => ({ frontendExtension: { activate(api: FrontendActivationContext) {
      const provider = () => ({ version: 1 as const, root: { kind: 'text' as const, key: 'proof', text: 'Pack surface' } })
      api.editor('demo.editor', { id: 'demo.editor', title: 'Demo editor', provider })
      api.editorBinding('demo.binding', { id: 'demo.binding', editor: 'demo.editor', match: { editorRole: 'demo' } })
      api.panel('demo.panel', 'sidebar.right', provider, 10, 'Demo panel')
    } } }))
    expect([editors, editorBindings, panels].map((values) => values.length)).toEqual([0, 0, 0])
    world.select(true)
    expect([editors, editorBindings, panels].map((values) => values.length)).toEqual([1, 1, 1])
    world.select(false)
    expect([editors, editorBindings, panels].map((values) => values.length)).toEqual([0, 0, 0])
    world.dispose()
  })
})

describe('submission-owned extension world lifetime', () => {
  let app: AppState
  let backend: Extract<Backend, { protocol: 'dinkster' }>
  let tab: Tab
  let oldHost: AppState['extensions']
  let oldWidgets: ReturnType<AppState['widgetRegistryForTab']>
  let disposed: ReturnType<typeof vi.fn>
  const snapshot: EffectiveExtensionSnapshot = { format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [] }
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }
  const refresh = async (letter: string) => {
    const nodes = JSON.parse(readFileSync(new URL('../../core/fixtures/dinkster-nodes-comfy.json', import.meta.url), 'utf8'))
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue({
      ...buildDinksterRegistry(backend.id, nodes), extensionSnapshotPair: { digest: `sha256:${letter.repeat(64)}`, snapshot },
    })
    await app.refreshBackendSchemas(backend)
  }
  const accepted = (job = 'held'): Extract<DinksterSubmitResult, { ok: true }> => ({
    ok: true, execution: { connection: backend.id, prompt: asPromptId(job) },
  })
  const missing = (retryWithAssets: Extract<DinksterSubmitResult, { assetsMissing: unknown }>['retryWithAssets']): DinksterSubmitResult => ({
    ok: false, diagnostics: [], assetsMissing: { error: 'assets-missing', assets: [] }, retryWithAssets,
  })
  const expectFrozenWorld = (job = 'held') => {
    const ref = accepted(job).execution
    expect(app.registryForExecution(ref)?.extensionSnapshotPair?.digest).toBe(digest)
    expect(app.openExecutionView(ref)).toBe(true)
    expect(app.extensions).toBe(oldHost)
    expect(app.widgetRegistryForTab(app.activeTab()!)).toBe(oldWidgets)
    expect(app.commands.get('demo.command')?.label).toBe('Snapshot A')
    expect(disposed).not.toHaveBeenCalled()
  }

  beforeEach(async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = new AppState()
    const added = app.addBackend('/lease', 'Lease', false, 'dinkster', false)
    if (!added || added.protocol !== 'dinkster') throw new Error('expected native backend')
    backend = added
    vi.spyOn(backend, 'refreshDiagnostics').mockImplementation(() => {})
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:source')
    await refresh('a')
    tab = app.tabs.get()[0]!
    app.setTabTarget(tab.id, backend.id)
    oldHost = app.extensions
    oldWidgets = app.widgetRegistryForTab(tab)
    disposed = vi.fn()
    expect(oldHost.register({ id: 'demo', contributions: [{ id: 'demo.command', category: 'command' }] }, (api) => {
      api.command('demo.command', { id: 'demo.command', label: 'Snapshot A', run() {} })
      api.onDispose(disposed)
    })).toEqual([])
  })
  afterEach(() => {
    app.dispose()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['source upload', 'submit response'])('retains compile-time world across a held %s and transfers it to the frozen run', async (phase) => {
    const upload = deferred<string>()
    const response = deferred<DinksterSubmitResult>()
    if (phase === 'source upload') vi.spyOn(backend.connection, 'uploadAsset').mockReturnValue(upload.promise)
    const submit = vi.spyOn(backend.connection, 'submit').mockReturnValue(response.promise)
    const queued = app.queue(tab)
    if (phase === 'submit response') await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    else expect(submit).not.toHaveBeenCalled()
    await refresh('b')
    expect(disposed).not.toHaveBeenCalled()
    expect(app.widgetRegistryForTab(tab)).not.toBe(oldWidgets)
    upload.resolve('blake3:source')
    response.resolve(accepted())
    await queued
    expectFrozenWorld()
  })

  it.each(['rejection', 'transport failure', 'closed before POST'])('releases a held submission on %s', async (outcome) => {
    const upload = deferred<string>()
    const response = deferred<DinksterSubmitResult>()
    if (outcome === 'closed before POST') vi.spyOn(backend.connection, 'uploadAsset').mockReturnValue(upload.promise)
    const submit = vi.spyOn(backend.connection, 'submit').mockReturnValue(response.promise)
    const queued = app.queue(tab)
    if (outcome !== 'closed before POST') await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    await refresh('b')
    expect(disposed).not.toHaveBeenCalled()
    if (outcome === 'closed before POST') {
      app.closeTab(tab.id)
      expect(disposed).toHaveBeenCalledOnce()
      upload.resolve('blake3:source')
    } else if (outcome === 'rejection') response.resolve({ ok: false, diagnostics: [] })
    else response.reject(new Error('transport failed'))
    await queued
    expect(disposed).toHaveBeenCalledOnce()
    if (outcome === 'closed before POST') expect(submit).not.toHaveBeenCalled()
  })

  it('retains an already-posted job after its originating tab closes', async () => {
    const response = deferred<DinksterSubmitResult>()
    const submit = vi.spyOn(backend.connection, 'submit').mockReturnValue(response.promise)
    const queued = app.queue(tab)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    app.closeTab(tab.id)
    await refresh('b')
    expect(disposed).not.toHaveBeenCalled()
    response.resolve(accepted())
    await queued
    expectFrozenWorld()
  })

  it.each(['cancel', 'close tab', 'replace tab', 'deny', 'dispose'])('releases idle consent ownership on %s after queue returns', async (action) => {
    const retry = vi.fn(async (): Promise<DinksterSubmitResult> => ({ ok: false, diagnostics: [] }))
    vi.spyOn(backend.connection, 'submit').mockResolvedValue(missing(retry))
    await app.queue(tab)
    const request = app.assetConsent.get()!
    expect(request).toBeDefined()
    await refresh('b')
    expect(disposed).not.toHaveBeenCalled()
    if (action === 'cancel') app.assetConsent.set(undefined)
    else if (action === 'close tab') app.closeTab(tab.id)
    else if (action === 'replace tab') app.openDocument(tab.store.doc, 'Replacement')
    else if (action === 'deny') await request.retry([])
    else app.dispose()
    expect(app.assetConsent.get()).toBeUndefined()
    expect(disposed).toHaveBeenCalledOnce()
    await request.retry([])
    expect(retry).toHaveBeenCalledTimes(action === 'deny' ? 1 : 0)
  })

  it('keeps a dismissed in-flight consent retry until its accepted run owns the world', async () => {
    const response = deferred<DinksterSubmitResult>()
    vi.spyOn(backend.connection, 'submit').mockResolvedValue(missing(() => response.promise))
    await app.queue(tab)
    const retried = app.assetConsent.get()!.retry([])
    app.assetConsent.set(undefined)
    await refresh('b')
    expect(disposed).not.toHaveBeenCalled()
    response.resolve(accepted())
    await retried
    expectFrozenWorld()
  })

  it('releases only the finished submission when two queues share a world', async () => {
    const first = deferred<DinksterSubmitResult>()
    const second = deferred<DinksterSubmitResult>()
    const submit = vi.spyOn(backend.connection, 'submit').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const queued = [app.queue(tab), app.queue(tab)]
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
    await refresh('b')
    first.resolve({ ok: false, diagnostics: [] })
    await queued[0]
    expect(disposed).not.toHaveBeenCalled()
    second.resolve(accepted())
    await queued[1]
    expectFrozenWorld()
  })

  it('drops app-disposed submissions without installing a late accepted run', async () => {
    const response = deferred<DinksterSubmitResult>()
    const submit = vi.spyOn(backend.connection, 'submit').mockReturnValue(response.promise)
    const queued = app.queue(tab)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    app.dispose()
    expect(disposed).toHaveBeenCalledOnce()
    response.resolve(accepted())
    await queued
    expect(app.store.get(accepted().execution)).toBeUndefined()
  })

  it('resolves pane-owned kinds, validators, views, previews and core fallbacks instead of the shell registry', async () => {
    const register = (host: AppState['extensions'], version: number) => {
      expect(host.register({ id: 'widgets', contributions: [
        { id: 'widgets.kind', category: 'widgetKind' }, { id: 'widgets.view', category: 'widgetView' },
        { id: 'widgets.preview', category: 'previewRenderer' },
      ] }, (api) => {
        api.widgetKind('widgets.kind', {
          type: 'widgets.kind', valueSchema: { version: 1, validate: (value): value is number => typeof value === 'number' },
          defaultValue: () => version, defaultView: () => 'widgets.view',
          validate: () => [{ severity: 'warning', origin: 'schema', code: 'widgets.version', message: String(version) }],
        })
        api.widgetView('widgets.view', { id: 'widgets.view', kind: 'widgets.kind', isCompatible: () => true,
          measure: () => ({ rows: version }), drawCompact() {} })
        api.previewRenderer('widgets.preview', { id: 'widgets.preview', mediaKind: version === 1 ? 'image' : 'video',
          canRender: (channel) => channel === 'widgets/preview', drawCompact() {} })
      })).toEqual([])
    }
    register(oldHost, 1)
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('fixture compile failed')
    app.registerRun(tab, accepted().execution, compiled.artifact)
    expect(app.openExecutionView(accepted().execution)).toBe(true)
    const frozen = app.activeTab()!
    app.activeTabId.set(tab.id)
    await refresh('b')
    register(app.extensions, 2)
    for (const focused of [frozen, tab]) {
      app.activeTabId.set(focused.id)
      for (const [pane, version] of [[frozen, 1], [tab, 2]] as const) {
        const registry = app.widgetRegistryForTab(pane)
        const spec = { widgetType: 'widgets.kind', options: {} }
        expect(registry.kind(spec.widgetType)?.defaultValue(spec)).toBe(version)
        expect(registry.kind(spec.widgetType)?.validate(0, spec)[0]?.message).toBe(String(version))
        expect(registry.viewsFor(spec.widgetType)[0]?.measure(spec).rows).toBe(version)
        expect(registry.previewRendererFor('widgets/preview')?.mediaKind).toBe(version === 1 ? 'image' : 'video')
        expect(registry.kind('INT')).toBeDefined()
      }
      expect(app.widgetRegistry.kind('widgets.kind')).toBeUndefined()
      expect(app.widgetRegistryForTab(undefined)).toBe(app.widgetRegistry)
    }
  })
})
