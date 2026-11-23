import { createSignal } from 'solid-js'
import {
  buttonAvailability,
  coreCommandRegistry,
  documentNodeResolver,
  documentResolver,
  isAssetWidgetInput,
  normalizeComboOption,
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
  type WorkflowDocument,
} from '@dinkster/core'
import type { LookupArg, LookupCall, LookupEntry } from '@dinkster/client'
import type { AppState, Tab } from './app-state.js'
import { pastedImageName, readClipboardImage } from './clipboard-image.js'
import { desktopSaveBridge } from './desktop-bridge.js'

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
    args: request.args as readonly LookupArg[],
  })

  /** The backend's lookup client, partitioned by the schema epoch the tab resolves against. */
  const lookupsOf = (tab: Tab) => {
    const backend = app.backendForTab(tab)
    const lookups = backend.connection.lookups
    lookups.setPartition({ backend: String(backend.id), epoch: app.registryForTab(tab)?.epoch ?? 0, principal: 0 })
    return lookups
  }

  /** What `buttonAvailability` reads; cheap enough for every repaint and hover. */
  const lookOf = (place: ButtonPlace): Pick<ActionHost, 'schemaOf' | 'editorFor'> => {
    const { tab } = place
    const resolve = resolverOf(tab)
    const editorFor = (field: ElaboratedInput) => {
      const spec = field.spec.widget
      if (spec === undefined || NO_HOST_EDITOR.has(spec.widgetType) || isAssetWidgetInput(field.spec)) return undefined
      if (app.widgetRegistryForTab(tab).kind(spec.widgetType) === undefined) return undefined
      return (signal: AbortSignal) => surfaces.edit({
        place,
        label: field.spec.displayName ?? field.spec.id,
        spec,
        initial: tab.store.doc.graphs[place.graphId]?.nodes[place.nodeId]?.values[field.spec.id],
      }, signal)
    }
    return {
      schemaOf: (doc, graphId, node) => documentNodeResolver(doc, resolve)(graphId, node, place.instancePath as readonly NodeId[] | undefined),
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
      schemaResolverFor: (doc: WorkflowDocument) => documentResolver(doc, resolve),
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
        // With noopener the browser answers null whether or not the tab opened, so a block cannot be told.
        window.open(address.href, '_blank', 'noopener,noreferrer')
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
        const outcome = await runPress(store, targetOf(place), hostFor(place), {
          signal: controller.signal,
          onProgress: (progress) => update(key, progress === undefined ? { place } : { place, busy: progress.text }),
          stillCurrent: () => app.tabs.get().some((tab) => tab.store === store),
        })
        report(place, outcome)
      } catch (error) {
        report(place, { kind: 'failed', warning: true, message: `Nothing was changed. ${error instanceof Error ? error.message : String(error)}`, skipped: [], notes: [] })
      } finally {
        running.delete(key)
      }
    },
    cancel(place: ButtonPlace): void {
      running.get(buttonKey(place))?.abort()
    },
    /** The next click clears every result box. */
    dismissBoxes(): void {
      if ([...states().values()].some((state) => state.box !== undefined)) {
        setStates(new Map([...states()].filter(([, state]) => state.box === undefined)))
      }
    },
  }
}

export type ButtonPresses = ReturnType<typeof createButtonPresses>
