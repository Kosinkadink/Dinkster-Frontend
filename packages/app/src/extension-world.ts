import {
  CONTRIBUTION_CATEGORIES, createMenuRegistry, createSearchRegistry, diag, ExtensionHost, frontendContributionAuthorized, isPackJsonObject,
  type ConnectionId, type ContributionCategory, type Diagnostic, type EffectiveExtensionSnapshot, type EffectiveFrontendModule,
  type ExtensionEvent, type ExtensionHostOptions, type FrontendPrivilege, type PackActivationApi, type PackManifest, type PackJsonObject,
} from '@dinkster/core'
import { createTextWidgetEditorExtensionRegistry, createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors, type TextWidgetEditorExtension } from '@dinkster/widgets'
import { registerCoreWidgetEditors } from './editors/widget-editors.js'
import { HostUiContributionRegistry } from './host-ui.js'
import { CommandRegistry, KeybindingRegistry, SettingsRegistry } from './settings.js'

interface Projection {
  readonly register: () => () => void
  unregister?: (() => void) | undefined
}

export interface FrontendActivationContext extends PackActivationApi<TextWidgetEditorExtension> {
  readonly identity: Readonly<{ connection: ConnectionId; snapshotDigest: string; pack: string; version: string; entryPoint: string; moduleDigest: string }>
  readonly authorizedPrivileges: readonly FrontendPrivilege[]
  readonly contributions: EffectiveFrontendModule['contributions']
  queryRoute(id: string, request?: PackJsonObject): Promise<PackJsonObject>
  invalidateHostUi(id: string): void
}

export type FrontendModuleLoader = (module: EffectiveFrontendModule, baseUrl: string, signal: AbortSignal) => Promise<unknown>

/** Only backend-selected immutable same-origin URLs enter the browser module graph. */
export const loadFrontendModule: FrontendModuleLoader = async (module, baseUrl, signal) => {
  const url = new URL(`${baseUrl}${module.moduleUrl}`, location.href)
  if (url.origin !== location.origin || url.search || url.hash || url.username || url.password) throw new Error('extension module must be same-origin')
  const response = await fetch(url, { signal, redirect: 'error', credentials: 'same-origin' })
  if (!response.ok || !/^(?:text|application)\/javascript(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
    !response.headers.get('cache-control')?.split(',').some((part) => part.trim() === 'immutable')) {
    throw new Error(`extension module '${module.id}' is not an immutable JavaScript asset`)
  }
  const bytes = await response.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const digest = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  if (digest !== module.moduleDigest) throw new Error(`extension module '${module.id}' digest mismatch`)
  signal.throwIfAborted()
  return import(/* @vite-ignore */ url.href)
}

interface EventConsumer {
  readonly consume: (event: ExtensionEvent) => void
  readonly queue: ExtensionEvent[]
  active: boolean
  draining: boolean
  failed: boolean
}

/** A snapshot owns registrations; only the selected world's shell projection is mounted. */
export class ExtensionWorld {
  readonly host: ExtensionHost<TextWidgetEditorExtension>
  readonly widgets = createWidgetRegistry()
  private readonly projections = new Set<Projection>()
  private readonly controller = new AbortController()
  private readonly eventBindings = new Map<string, { readonly pack: string; readonly event: string }>()
  private readonly consumers = new Map<string, EventConsumer>()
  readonly diagnostics: Diagnostic[] = []
  private selected = false

  constructor(
    readonly connection: ConnectionId,
    readonly digest: string,
    private readonly target: ExtensionHostOptions<TextWidgetEditorExtension>,
    private readonly report: (diagnostic: Diagnostic) => void = () => {},
  ) {
    registerCoreWidgets(widgetRegistrationDoors(this.widgets))
    registerCoreWidgetEditors(this.widgets)
    const menus = createMenuRegistry()
    const text = createTextWidgetEditorExtensionRegistry()
    const settings = new SettingsRegistry(undefined)
    const commands = new CommandRegistry()
    const bindings = new KeybindingRegistry(settings)
    const ui = new HostUiContributionRegistry()
    const search = createSearchRegistry()
    const stage = (local: () => () => void, register: () => () => void): (() => void) => {
      const removeLocal = local()
      const projection: Projection = { register }
      try {
        if (this.selected) projection.unregister = register()
        this.projections.add(projection)
      } catch (error) {
        removeLocal()
        throw error
      }
      return () => {
        this.projections.delete(projection)
        projection.unregister?.()
        projection.unregister = undefined
        removeLocal()
      }
    }
    this.host = new ExtensionHost({
      ...target,
      menus: { ...menus, register: (value) => stage(() => menus.register(value), () => target.menus.register(value)) },
      widgets: this.widgets,
      registerTextEditorExtension: (value) => stage(() => text.register(value), () => target.registerTextEditorExtension!(value)),
      registerSetting: (value) => stage(() => settings.register(value), () => target.registerSetting!(value)),
      registerCommand: (value) => stage(() => commands.register(value), () => target.registerCommand!(value)),
      registerKeybinding: (value) => stage(() => bindings.register(value), () => target.registerKeybinding!(value)),
      registerHostUi: (...args) => stage(() => ui.register(...args), () => target.registerHostUi!(...args)),
      registerSearchProvider: (value) => stage(() => search.register(value), () => target.registerSearchProvider!(value)),
      registerEditor: (value) => stage(() => () => {}, () => target.registerEditor!(value)),
      registerEditorBinding: (value) => stage(() => () => {}, () => target.registerEditorBinding!(value)),
      registerPanel: (value) => stage(() => () => {}, () => target.registerPanel!(value)),
      registerVirtualNode: (value) => stage(() => () => {}, () => target.registerVirtualNode!(value)),
      registerCanvasLayer: (value) => stage(() => () => {}, () => target.registerCanvasLayer!(value)),
      registerEventConsumer: (id, consume) => {
        if (!this.eventBindings.has(id)) throw new Error(`event consumer '${id}' has no snapshot declaration`)
        const consumer: EventConsumer = { consume, queue: [], active: true, draining: false, failed: false }
        this.consumers.set(id, consumer)
        return () => {
          consumer.active = false
          consumer.queue.length = 0
          this.consumers.delete(id)
        }
      },
    })
  }

  async activate(snapshot: EffectiveExtensionSnapshot, baseUrl: string, deniedPrivileges: readonly FrontendPrivilege[] = [], load: FrontendModuleLoader = loadFrontendModule): Promise<void> {
    for (const pack of snapshot.extensions) {
      if (!pack.frontend?.length) continue
      const frontend = pack.frontend.map((entry) => ({
        ...entry,
        contributions: entry.contributions.filter((contribution) => {
          if ((CONTRIBUTION_CATEGORIES as readonly string[]).includes(contribution.kind)) return true
          this.record(diag('warning', 'extension', 'extension.contribution-kind-skipped',
            `pack '${pack.id}' entry '${entry.id}' contribution '${contribution.id}' uses unimplemented or unknown kind '${contribution.kind}'; skipped`))
          return false
        }),
      }))
      const manifest: PackManifest = {
        id: pack.id,
        contributions: frontend.flatMap((entry) => entry.contributions)
          .map((contribution) => ({ id: contribution.id, category: contribution.kind as ContributionCategory })),
      }
      const required = new Set<string>()
      try {
        if (snapshot.frontendApi !== '1.0.0' && snapshot.frontendApi !== '1.1.0') {
          throw new Error(`unsupported frontend API '${snapshot.frontendApi}'`)
        }
        const admitted = frontend.filter((entry) => {
          if (entry.contributions.some((contribution) => !frontendContributionAuthorized(contribution.kind, entry.authorizedPrivileges))) {
            throw new Error(`entry '${entry.id}' lacks a required frontend privilege`)
          }
          return !entry.authorizedPrivileges.some((privilege) => deniedPrivileges.includes(privilege)) &&
            entry.contributions.some((contribution) => this.host.contributionEnabled(pack.id, {
              id: contribution.id, category: contribution.kind as ContributionCategory,
            }))
        })
        for (const entry of admitted) for (const contribution of entry.contributions) {
          required.add(contribution.id)
          if (contribution.kind === 'eventConsumer') {
            const producers = snapshot.extensions.filter((producer) => producer.events?.some((event) => event.name === contribution.event))
            if (producers.length !== 1) throw new Error(`consumer '${contribution.id}' requires one authorized event producer`)
            this.eventBindings.set(contribution.id, { pack: producers[0]!.id, event: contribution.event! })
          }
        }
        const modules = await Promise.all(admitted.map(async (entry) => ({ entry, module: await load(entry, baseUrl, this.controller.signal) })))
        this.controller.signal.throwIfAborted()
        const diagnostics = this.host.register(manifest, (api) => {
          for (const { entry, module } of modules) {
            const descriptor = (module as { frontendExtension?: { activate?: unknown } } | null)?.frontendExtension
            if (typeof descriptor?.activate !== 'function') throw new Error(`module '${entry.id}' must export frontendExtension.activate`)
            let violation = false
            const methods = Object.fromEntries(CONTRIBUTION_CATEGORIES.map((category) => [category, (id: string, ...args: unknown[]) => {
              if (!entry.contributions.some((contribution) => contribution.id === id && contribution.kind === category) ||
                !frontendContributionAuthorized(category, entry.authorizedPrivileges)) {
                violation = true
                throw new Error(`entry '${entry.id}' cannot register '${id}' as ${category}`)
              }
              Reflect.apply(api[category], undefined, [id, ...args])
            }])) as Pick<PackActivationApi<TextWidgetEditorExtension>, ContributionCategory>
            const signal = AbortSignal.any([api.signal, this.controller.signal])
            const requireApp = (): void => {
              signal.throwIfAborted()
              if (!entry.authorizedPrivileges.includes('app-workflow') || !entry.contributions.some((contribution) =>
                frontendContributionAuthorized(contribution.kind, ['app-workflow']) && this.host.contributionEnabled(pack.id, {
                  id: contribution.id, category: contribution.kind as ContributionCategory,
                }))) {
                violation = true
                throw new Error(`entry '${entry.id}' has no enabled app-workflow authority`)
              }
            }
            const context: FrontendActivationContext = Object.freeze({
              ...methods, signal: api.signal, onDispose: api.onDispose,
              identity: Object.freeze({ connection: this.connection, snapshotDigest: this.digest, pack: pack.id, version: pack.version, entryPoint: entry.id, moduleDigest: entry.moduleDigest }),
              authorizedPrivileges: Object.freeze([...entry.authorizedPrivileges]),
              contributions: Object.freeze(entry.contributions.map((contribution) => Object.freeze({ ...contribution }))),
              queryRoute: async (id: string, request: PackJsonObject = {}) => {
                requireApp()
                const route = pack.routes?.find((route) => route.id === id)
                if (!route || !isPackJsonObject(request, route.request)) throw new Error(`invalid or undeclared own-pack route '${id}'`)
                const input = { ...request }
                await Promise.resolve()
                requireApp()
                const url = new URL(`${baseUrl}/api/extensions/${pack.id}/routes/${route.id}`, location.href)
                if (url.origin !== location.origin || url.username || url.password || url.hash || url.search) throw new Error('extension route must be same-origin')
                const response = await fetch(url, {
                  method: route.method, signal, redirect: 'error', credentials: 'same-origin',
                  headers: { 'If-Match': this.digest, ...(route.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
                  ...(route.method === 'POST' ? { body: JSON.stringify(input) } : {}),
                })
                if (!response.ok || response.headers.get('X-Dinkster-Extension-Snapshot') !== this.digest ||
                  !/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')) throw new Error(`route '${id}' returned an unpaired response`)
                const text = await response.text()
                requireApp()
                if (new TextEncoder().encode(text).byteLength > 65536) throw new Error(`route '${id}' response is too large`)
                const value: unknown = JSON.parse(text)
                if (!isPackJsonObject(value, route.response)) throw new Error(`route '${id}' response does not match its schema`)
                return Object.freeze({ ...value })
              },
              invalidateHostUi: (id: string) => {
                if (!entry.authorizedPrivileges.includes('app-workflow') ||
                  !entry.contributions.some((contribution) => contribution.id === id && contribution.kind === 'hostUi')) {
                  violation = true
                  throw new Error(`entry '${entry.id}' cannot invalidate '${id}'`)
                }
                if (!signal.aborted && this.selected && this.host.contributionEnabled(pack.id, { id, category: 'hostUi' })) this.target.invalidateHostUi?.(id)
              },
            })
            const result: unknown = descriptor.activate(context)
            if (result !== undefined && result !== null && typeof (result as { then?: unknown }).then === 'function') {
              void Promise.resolve(result).catch(() => {})
              throw new Error(`entry '${entry.id}' activation must be synchronous`)
            }
            if (violation) throw new Error(`entry '${entry.id}' violated its declaration scope`)
          }
        }, required)
        diagnostics.forEach((diagnostic) => this.record(diagnostic))
      } catch (error) {
        if (this.controller.signal.aborted) return
        this.host.register(manifest, () => { throw error }).forEach((diagnostic) => this.record(diagnostic))
      }
    }
  }

  deliver(event: ExtensionEvent): void {
    if (event.execution.connection !== this.connection || event.extensionSnapshotDigest !== this.digest || this.controller.signal.aborted) return
    for (const [id, consumer] of this.consumers) {
      const binding = this.eventBindings.get(id)!
      if (binding.pack !== event.pack || binding.event !== event.event) continue
      if (consumer.queue.length === 64) consumer.queue.shift()
      consumer.queue.push(event)
      if (consumer.draining) continue
      consumer.draining = true
      queueMicrotask(() => { void this.drain(id, consumer) })
    }
  }

  private async drain(id: string, consumer: EventConsumer): Promise<void> {
    while (consumer.active && consumer.queue.length > 0) {
      try { await consumer.consume(consumer.queue.shift()!) } catch (error) {
        if (!consumer.failed) this.record(diag('error', 'extension', 'extension.consumer-failed', `consumer '${id}' failed: ${String(error)}`))
        consumer.failed = true
      }
    }
    consumer.draining = false
  }

  private record(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic)
    this.report(diagnostic)
  }

  select(selected: boolean): void {
    if (this.selected === selected) return
    const finish = this.target.beginRegistryBatch?.()
    try {
      if (selected) {
        try {
          for (const projection of this.projections) projection.unregister = projection.register()
        } catch (error) {
          this.unmount()
          throw error
        }
      } else this.unmount()
      this.selected = selected
    } finally {
      finish?.(this.selected === selected)
    }
  }

  dispose(): void {
    this.controller.abort()
    this.select(false)
    this.host.dispose()
  }

  private unmount(): void {
    for (const projection of [...this.projections].reverse()) {
      projection.unregister?.()
      projection.unregister = undefined
    }
  }
}
