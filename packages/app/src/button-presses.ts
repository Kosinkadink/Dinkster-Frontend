import { createSignal } from 'solid-js'
import {
  asNodeId,
  buttonAvailability,
  coreCommandRegistry,
  documentNodeResolver,
  documentResolver,
  isAssetWidgetInput,
  normalizeComboOption,
  occurrenceDynamicView,
  runPress,
  type ActionHost,
  type AskRequest,
  type ButtonAvailability,
  type ElaboratedInput,
  type Json,
  type LookupRequest,
  type NodeId,
  type LookupResult,
  type NormalizedComboOption,
  type PickRequest,
  type PressOutcome,
  type PressTarget,
  type WidgetSpec,
} from '@dinkster/core'
import type { LookupCall, LookupEntry } from '@dinkster/client'
import { buildScene, defaultTokens, linkBounds, type Scene } from '@dinkster/canvas'
import type { AppState, Tab } from './app-state.js'
import { canvasMeasures } from './canvas-measures.js'
import { pastedImageName, readClipboardImage } from './clipboard-image.js'
import { desktopSaveBridge } from './desktop-bridge.js'
import { RequestFailure } from '@dinkster/client'
import { failureMessage } from './request-failure.js'

/** The box under a button's line: a note or skip (circled i), or a failure (warning triangle). */
export interface ButtonBox {
  readonly tone: 'info' | 'warn'
  readonly message: string
}

/** One button on one node of one tab's graph. */
export interface ButtonPlace {
  readonly tab: Tab
  readonly graphId: string
  readonly nodeId: string
  readonly button: string
  readonly menu?: true
  readonly instancePath?: readonly string[]
  /** The button's words, for the list or editor it opens. */
  readonly label?: string
}

export interface ButtonState {
  readonly place: ButtonPlace
  /** Words while the press works; the host adds the three dots. */
  readonly busy?: string
  readonly box?: ButtonBox
}

/** A host editor opened for a press: it hands its value back instead of writing the document. */
export interface LocalEditRequest {
  readonly place: ButtonPlace
  readonly label: string
  readonly spec: WidgetSpec
  readonly initial: Json | undefined
  /** A Pick's lookup list that is not ready, with Try again for a stale or failed one. */
  readonly list?: { readonly state: 'stale' | 'failed' | 'paused'; readonly retry?: () => void }
  /** A clipboard image the asset picker starts uploading at once. */
  readonly stagedFile?: File
}

/** The surfaces a press opens at its button; each settles undefined when the user closes it. */
export interface ButtonSurfaces {
  /** Include the tab's visible preview/text body regions in a staged measurement scene. */
  projectScene?(place: ButtonPlace, scene: Scene): Scene
  edit(request: LocalEditRequest, signal: AbortSignal): Promise<Json | undefined>
  ask(place: ButtonPlace, request: AskRequest, signal: AbortSignal): Promise<Readonly<Record<string, Json>> | undefined>
  /** Shows a field-built address before its tab opens. */
  confirmLink(place: ButtonPlace, url: string, signal: AbortSignal): Promise<boolean>
}

/** One press at a time per button: a menu button and each subgraph instance are their own. */
export const buttonKey = (place: Pick<ButtonPlace, 'tab' | 'graphId' | 'nodeId' | 'button' | 'menu' | 'instancePath'>): string =>
  JSON.stringify([place.tab.id, place.graphId, place.instancePath ?? [], place.nodeId, place.menu === true, place.button])

const targetOf = (place: ButtonPlace): PressTarget => ({
  graphId: place.graphId,
  nodeId: place.nodeId,
  button: place.button,
  ...(place.menu ? { menu: true } : {}),
  ...(place.instancePath ? { instancePath: place.instancePath } : {}),
  ...(place.instancePath?.length ? { occurrence: [...place.instancePath, place.nodeId].join('/') } : {}),
})

/**
 * Editors a step may not open yet. An asset field's own editing (the mask and
 * other image editing) waits for the replacement image surface; its picker is
 * OpenPicker.
 */
const NO_HOST_EDITOR = new Set(['COMPOSITOR', 'CURVE', 'PAINTER', 'MASK', 'IMAGE_COMPARE'])

/**
 * Runs declared buttons for the canvas: one press at a time per button, its
 * working words and Cancel, and the box it leaves until the next click.
 */
export function createButtonPresses(app: AppState, surfaces: ButtonSurfaces) {
  const [states, setStates] = createSignal<ReadonlyMap<string, ButtonState>>(new Map())
  const running = new Map<string, AbortController>()

  const update = (key: string, next: ButtonState | undefined): void => {
    const copy = new Map(states())
    if (next === undefined) copy.delete(key)
    else copy.set(key, next)
    setStates(copy)
  }

  const resolverOf = (tab: Tab) => app.registryForTab(tab)?.resolve ?? (() => undefined)

  const lookupCall = (request: LookupRequest): LookupCall => ({
    nodeType: request.nodeType,
    node: request.node,
    function: request.function,
    args: request.args,
    typedArgs: true,
  })

  /** The backend's one lookup client; it follows the schema epoch the backend holds. */
  const lookupsOf = (tab: Tab) => app.backendForTab(tab).lookups

  /** What `buttonAvailability` reads; cheap enough for every repaint and hover. */
  const lookOf = (place: ButtonPlace): Pick<ActionHost, 'schemaOf' | 'schemaResolverFor' | 'editorFor'> => {
    const { tab } = place
    const resolve = resolverOf(tab)
    const editorFor = (field: ElaboratedInput) => {
      const spec = field.spec.widget
      if (spec === undefined || NO_HOST_EDITOR.has(spec.widgetType) || isAssetWidgetInput(field.spec)) return undefined
      if (app.widgetRegistryForTab(tab).kind(spec.widgetType) === undefined) return undefined
      return (signal: AbortSignal, initial: Json | undefined) =>
        surfaces.edit({ place, label: field.spec.displayName ?? field.spec.id, spec, initial }, signal)
    }
    return {
      schemaOf: (doc, graphId, node) => documentNodeResolver(doc, resolve)(graphId, node, place.instancePath as readonly NodeId[] | undefined),
      schemaResolverFor: (doc) => documentResolver(doc, resolve),
      editorFor,
    }
  }

  const hostFor = (place: ButtonPlace): ActionHost => {
    const { tab } = place
    const resolve = resolverOf(tab)
    const backend = app.backendForTab(tab)
    return {
      ...lookOf(place),
      commands: coreCommandRegistry([], resolve),
      positionAddedNode(doc, target, node, to, source) {
        const graph = doc.graphs[target.graphId]!
        const measuring = { ...doc, graphs: { ...doc.graphs, [target.graphId]: { ...graph, nodes: { ...graph.nodes, [node.id]: node } } } }
        const resolver = documentResolver(measuring, resolve)
        const measures = canvasMeasures(() => app.widgetRegistryForTab(tab))
        const path = target.instancePath ?? []
        const measured = buildScene({ document: measuring, graphId: target.graphId, resolve: resolver,
          tokens: defaultTokens, ...measures,
          occurrenceView: occurrenceDynamicView(measuring, resolver, path, path.length === 0 ? target.graphId : doc.root),
          ...(path.length === 0 ? {} : { occurrence: {
            owner: { instancePath: path.slice(0, -1).map(asNodeId), node: asNodeId(path.at(-1)!) }, plannerAvailable: true,
          } }),
        })
        const scene = surfaces.projectScene?.(place, measured) ?? measured
        const destination = scene.nodes.find((item) => item.id === target.nodeId)!
        const layout = scene.nodes.find((item) => item.id === node.id)!.layout
        const gap = defaultTokens.rowHeight * 2
        const driver = source === undefined ? undefined : scene.links.find((link) =>
          link.to.kind === 'port' && link.to.node === target.nodeId && link.to.port === to)
        let x = destination.x - layout.width - gap
        const obstacles = [...scene.nodes.filter((item) => item.id !== node.id), ...scene.boundaryNodes].map((item) => ({
          x: item.x, y: item.y, width: item.layout.width, height: item.layout.height,
        }))
        for (const link of scene.links) {
          // The old delivery is replaced by the insertion, not an obstacle.
          if (link.hidden || (link.to.kind === 'port' && link.to.node === target.nodeId && link.to.port === to)) continue
          const bounds = linkBounds(link.x1, link.y1, link.x2, link.y2)
          obstacles.push({ x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY })
        }
        const clear = (y: number): boolean => !obstacles.some((item) => x < item.x + item.width + gap && x + layout.width + gap > item.x &&
            y < item.y + item.height + gap && y + layout.height + gap > item.y)
        if ((driver === undefined || x >= driver.x1 + gap) && clear(destination.y)) return { x, y: destination.y }
        // Existing positions belong to every use of the definition. Only the
        // new node moves to a clear lane when the horizontal gap is too small.
        if (driver !== undefined) x = driver.x1 + gap
        const targetY = destination.y + (destination.layout.pins.find((pin) => pin.direction === 'in' && pin.portId === to)?.y ?? 0)
        const wiredInputs = new Map(scene.links.flatMap((link) => !link.hidden && link.to.kind === 'port' && link.to.node === target.nodeId && link.to.port !== to
          ? [[link.to.port, link.y2] as const] : []))
        const crossings = (y: number): number => [...wiredInputs.values()].filter((inputY) =>
          inputY > Math.min(y + layout.height / 2, targetY) && inputY < Math.max(y + layout.height / 2, targetY)).length
        const candidates = obstacles.flatMap((item) => [item.y - layout.height - gap, item.y + item.height + gap])
          .sort((a, b) => crossings(a) - crossings(b) || Math.abs(a - destination.y) - Math.abs(b - destination.y) || b - a)
        return { x, y: candidates.find(clear)! }
      },
      async lookup(request, signal): Promise<LookupResult> {
        const lookups = lookupsOf(tab)
        if (request.use === 'value') return lookups.resolve(lookupCall(request), 'value', { signal })
        // A Pick's list is offered stale, as a field's list is.
        const entry: LookupEntry = await lookups.request(lookupCall(request), { signal, askedBy: 'press' })
        if (entry.state === 'ready' || entry.state === 'stale') return { state: entry.state, value: entry.answer }
        if (entry.state === 'paused') return { state: 'paused' }
        return { state: 'failed', reason: entry.state === 'loading' ? 'failed' : entry.reason }
      },
      call: (request, progress, signal) => backend.connection.callPackFunction(request, progress, signal),
      pick: (request, signal) => pick(place, request, signal),
      ask: (request, signal) => surfaces.ask(place, request, signal),
      openPicker: (field, signal) => {
        const spec = field.spec.widget
        if (spec === undefined) return Promise.reject(new Error(`${field.spec.id} has no picker.`))
        return surfaces.edit({ place, label: field.spec.displayName ?? field.spec.id, spec, initial: undefined }, signal)
      },
      async pasteImage(field, signal) {
        const spec = field.spec.widget
        if (spec === undefined) throw new Error(`${field.spec.id} does not take an image.`)
        const image = await readClipboardImage(() => navigator.clipboard.read())
        if (image === undefined) throw new Error('The clipboard holds no image.')
        const stagedFile = new File([image.blob], pastedImageName(image.mediaType), { type: image.mediaType })
        const value = await surfaces.edit({ place, label: field.spec.displayName ?? field.spec.id, spec, initial: undefined, stagedFile }, signal)
        if (value === undefined) throw new Error('The image was not stored.')
        return value
      },
      copy: (text) => navigator.clipboard.writeText(text),
      async download(filename, content) {
        // Desktop shows its own Save As dialog and says whether it was closed; a browser saves an ordinary download.
        const native = desktopSaveBridge()
        if (native !== undefined) {
          const result = await native.saveFile(typeof content === 'string' ? new TextEncoder().encode(content) : content, filename)
          return result.status
        }
        const blob = new Blob([typeof content === 'string' ? content : content.slice()], {
          type: typeof content === 'string' ? 'text/plain;charset=utf-8' : 'application/octet-stream',
        })
        const url = URL.createObjectURL(blob)
        try {
          const link = document.createElement('a')
          link.href = url
          link.download = filename
          document.body.append(link)
          link.click()
          link.remove()
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
        return 'saved'
      },
      async queue(toHere) {
        app.queueRefusal.set(undefined)
        if (toHere) await app.queueSelection(tab, [toHere.nodeId])
        else await app.queue(tab)
        if (app.queueRefusal.get() !== undefined) throw new Error('The run was not queued; see Problems.')
      },
      async interrupt() {
        const executions = [...app.store.executions.get().values()]
          .filter((execution) => execution.status === 'running' && execution.ref.connection === backend.id)
        if (executions.length === 0) throw new Error('Nothing is running.')
        await Promise.all(executions.map((execution) => app.cancelExecution(execution.ref)))
      },
      async openLink(url, confirm, signal) {
        let address: URL
        try {
          address = new URL(url)
        } catch {
          throw new Error(`${url} is not a web address.`)
        }
        if (address.protocol !== 'https:' && address.protocol !== 'http:') throw new Error('Only web addresses open in a new tab.')
        if (confirm && !await surfaces.confirmLink(place, address.href, signal)) throw new Error('The link was not opened.')
        // A blank same-origin tab gives an observable refusal. Sever its opener
        // before navigating, and suppress the referrer on that navigation.
        const opened = window.open('about:blank', '_blank')
        if (opened === null) throw new Error('The browser blocked the new tab.')
        try {
          opened.opener = null
          const link = opened.document.createElement('a')
          link.href = address.href
          link.rel = 'noreferrer noopener'
          link.referrerPolicy = 'no-referrer'
          link.target = '_self'
          opened.document.body.append(link)
          link.click()
          link.remove()
        } catch (error) {
          opened.close()
          throw error
        }
      },
      random: Math.random,
    }
  }

  /** The list of a Pick: the ordinary choice list at the button, Try again on a stale or failed lookup. */
  const pick = (place: ButtonPlace, request: PickRequest, signal: AbortSignal): Promise<string | number | boolean | undefined> => {
    const open = (options: readonly NormalizedComboOption[], state: PickRequest['state']): Promise<Json | undefined> => {
      let retried: Promise<Json | undefined> | undefined
      const retry = request.lookup === undefined ? undefined : () => {
        retried = (async () => {
          const entry = await lookupsOf(place.tab).request(lookupCall(request.lookup!), { signal, askedBy: 'press', refresh: true })
          const next = entry.state === 'ready' || entry.state === 'stale' ? entry.answer : undefined
          const list = Array.isArray(next) ? next.flatMap((item: unknown) => {
            const option = normalizeComboOption(typeof item === 'bigint' ? Number(item) : item)
            return option === undefined ? [] : [option]
          }) : []
          return open(list, entry.state === 'ready' || entry.state === 'stale' || entry.state === 'paused' ? entry.state : 'failed')
        })()
      }
      const shown = surfaces.edit({
        place,
        label: place.label ?? 'Pick',
        spec: { widgetType: 'COMBO', options: { options: options as unknown as Json[] } },
        initial: undefined,
        ...(state === 'ready' ? {} : { list: { state, ...(retry && state !== 'paused' ? { retry } : {}) } }),
      }, signal)
      return shown.then((value) => value === undefined && retried !== undefined ? retried : value)
    }
    return open(request.options, request.state) as Promise<string | number | boolean | undefined>
  }

  const availability = (place: ButtonPlace): ButtonAvailability =>
    buttonAvailability(place.tab.store.doc, targetOf(place), lookOf(place))

  const report = (place: ButtonPlace, outcome: PressOutcome): void => {
    // A press that went through already ends its message with its notes; a failed one does not.
    const parts = outcome.kind === 'failed' ? [outcome.message, ...outcome.notes] : [outcome.message]
    const message = parts.filter((part): part is string => part !== undefined && part !== '').join(' ')
    if (outcome.kind === 'cancelled' || message === '') {
      update(buttonKey(place), undefined)
      return
    }
    const tone = outcome.warning ? 'warn' : 'info'
    update(buttonKey(place), { place, box: { tone, message } })
    app.recordHostLog(outcome.warning ? 'warn' : 'info', 'button', message)
  }

  return {
    states,
    availability,
    isBusy: (place: ButtonPlace): boolean => running.has(buttonKey(place)),
    /** Press a button; a button already working is not pressed twice. */
    async press(place: ButtonPlace): Promise<void> {
      const key = buttonKey(place)
      if (running.has(key)) return
      const controller = new AbortController()
      running.set(key, controller)
      update(key, { place })
      const store = place.tab.store
      try {
        const backend = app.backendForTab(place.tab)
        const registry = app.registryForTab(place.tab)
        const schemaState = backend.schemaState.get()
        const outcome = await runPress(store, targetOf(place), hostFor(place), {
          signal: controller.signal,
          onProgress: (progress) => update(key, progress === undefined ? { place } : { place, busy: progress.text }),
          stillCurrent: () => app.tabs.get().includes(place.tab) && place.tab.store === store &&
            app.backendForTab(place.tab) === backend && app.registryForTab(place.tab) === registry &&
            backend.schemaState.get() === schemaState,
        })
        report(place, outcome)
      } catch (error) {
        report(place, { kind: 'failed', warning: true, message: error instanceof RequestFailure ? failureMessage(error, 'Nothing was changed.') : `Nothing was changed. ${error instanceof Error ? error.message : String(error)}`, skipped: [], notes: [] })
      } finally {
        running.delete(key)
        // Focused buttons read both the result and whether a press is still running.
        setStates(new Map(states()))
      }
    },
    cancel(place: ButtonPlace): void {
      running.get(buttonKey(place))?.abort()
    },
    /** The next click clears every result box. */
    dismissBoxes(shown: readonly ButtonState[] = [...states().values()]): void {
      if (shown.some((state) => state.box !== undefined)) {
        setStates(new Map([...states()].filter(([, state]) => state.box === undefined || !shown.includes(state))))
      }
    },
  }
}

export type ButtonPresses = ReturnType<typeof createButtonPresses>
