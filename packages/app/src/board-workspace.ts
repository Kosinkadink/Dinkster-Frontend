import {
  BOARD_MAX_NAME, BOARD_MEDIA_TYPE, DocumentStore, assetMultiSelect, boardMediaKindOf, buildGraphConnectivity, connectSharedBoardSession, coreCommandRegistry, createLocalBoardSession, createSignal, defaultValuesOf, documentResolver, elabInputsOf, elaborateInterface, exposedKey, exposedToJson, isAssetWidgetInput, isValidCollabTitle, jsonSameValue, loadBoard, loadDocument, planBoardCommand, t, valueKeyOf,
  type AssetRef, type BoardAsset, type BoardCardItem, type BoardCardSource, type BoardDocument, type BoardItemInput, type BoardRect, type BoardSession, type CollabSessionDescriptor, type ControllerMode, type Json, type NodeSchema, type SharedBoardSession, type WorkflowDocument,
} from '@dinkster/core'
import type { AssetUploadDestination, DinksterConnection, LibraryRecord } from '@dinkster/client'
import type { CollabTransport } from './collab.js'
import { buildParamRows } from './app-view-rows.js'
import { isCompatible } from './asset-browser/helpers.js'
import { assetGuessCandidateToRef } from './dialog-requests.js'

type BoardConnection = Pick<DinksterConnection, 'uploadMediaAsset' | 'checkAssetAvailability' |
  'uploadAsset' | 'createLibraryRecord' | 'patchLibraryRecord' | 'getLibraryRecord' | 'fetchAssetText' |
  'listLocalAssets' | 'guessAssets'> &
  Partial<Pick<DinksterConnection, 'fetchBlueprintBody'>>

export interface BoardMediaFile {
  readonly file: File
  readonly width?: number
  readonly height?: number
  readonly duration?: number
}

export interface BoardEntry {
  readonly id: string
  readonly title: string
  readonly name: string | undefined
  readonly baseUrl: string
  readonly session: BoardSession
  readonly shared?: {
    readonly descriptor: CollabSessionDescriptor
    readonly session: SharedBoardSession
  }
}

/** Compatibility follows the exposed face, not node names or hidden inputs. */
function cardMediaInput(document: WorkflowDocument, asset: BoardAsset,
  resolve: (type: string) => NodeSchema | undefined,
) {
  return buildParamRows(document, documentResolver(document, resolve)).find((row) => {
    if (row.kind !== 'live' || row.linked || row.derived || row.spec === undefined || !isAssetWidgetInput(row.item.spec) || row.spec.selection === true) return false
    const accept = row.spec.options['accept']
    return isCompatible({ ...asset, id: asset.digest, source: { id: 'board', label: 'Board' } },
      Array.isArray(accept) ? accept.filter((value): value is string => typeof value === 'string') : [], row.spec.kind)
  })
}

function cardFace(document: WorkflowDocument, kind: BoardCardItem['kind'], name: string,
  resolve: (type: string) => NodeSchema | undefined,
): WorkflowDocument {
  if (kind !== 'blueprint') return document
  let root = 'board-root'
  while (document.graphs[root]) root += '-copy'
  const schema = documentResolver(document, resolve)(`#${document.root}`)
  if (!schema) throw new Error('Blueprint inputs are unavailable')
  const values = defaultValuesOf(schema) as Record<string, Json>
  const wrapped = loadDocument({
    ...document, root,
    graphs: { ...document.graphs, [root]: {
      id: root, name, nodes: { n0: { id: 'n0', type: `#${document.root}`, values } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
    } },
    view: { graphs: { ...document.view.graphs, [root]: { nodes: { n0: { position: { x: 0, y: 0 } } } } } },
    ext: { ...document.ext, 'dinkster.exposed': exposedToJson(elabInputsOf(elaborateInterface(schema,
      { values },
    )).map((input) => ({ graphId: root, nodeId: 'n0', inputId: input.spec.id }))) },
  })
  if (!wrapped.document) throw new Error(wrapped.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  return wrapped.document
}

/** Apply exposed overrides and private advancing controls without changing source bytes. */
export function applyCardInputs(document: WorkflowDocument, values: Readonly<Record<string, Json>>,
  resolve: (type: string) => NodeSchema | undefined,
  controllers: Readonly<Record<string, ControllerMode>> = {},
): WorkflowDocument {
  const store = new DocumentStore(document, coreCommandRegistry([], documentResolver(document, resolve)))
  const pending = new Set(Object.keys(values))
  while (pending.size > 0) {
    const row = buildParamRows(store.doc, documentResolver(store.doc, resolve))
      .find((candidate) => pending.has(exposedKey(candidate.entry)))
    if (!row) {
      const controller = cardControllerInputs(store.doc, resolve)
        .find((input) => !input.fixed && (pending.has(input.key) || pending.has(exposedKey(input))))
      if (!controller) break
      const key = pending.has(controller.key) ? controller.key : exposedKey(controller)
      pending.delete(key)
      const result = store.dispatch({ command: 'node.setValue', params: {
        graphId: controller.graphId, nodeId: controller.nodeId, inputId: controller.inputId, value: values[key]!,
      } })
      if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
      continue
    }
    const key = exposedKey(row.entry)
    pending.delete(key)
    if (row.kind === 'stale') throw new Error(`Card input is unavailable: ${row.reason}`)
    if (row.linked || row.derived) continue
    const result = store.dispatch({ command: 'node.setValue', params: {
      graphId: row.entry.graphId, nodeId: row.entry.nodeId, inputId: row.valueKey, value: values[key]!,
    } })
    if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  }
  for (const row of buildParamRows(store.doc, documentResolver(store.doc, resolve))) {
    if (row.kind !== 'live' || row.linked || row.derived || row.spec?.controller !== 'after_generate') continue
    const mode = controllers[exposedKey(row.entry)]
    if (mode === undefined) continue
    const result = store.dispatch({ command: 'node.setController', params: {
      graphId: row.entry.graphId, nodeId: row.entry.nodeId, inputId: row.valueKey, mode,
    } })
    if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  }
  return store.doc
}

function cardControllerInputs(document: WorkflowDocument, resolve: (type: string) => NodeSchema | undefined) {
  const resolver = documentResolver(document, resolve)
  return Object.values(document.graphs).flatMap((graph) => {
    const connectivity = buildGraphConnectivity(graph)
    return Object.values(graph.nodes).flatMap((node) => {
      const schema = resolver(node.type)
      if (!schema) return []
      return elabInputsOf(elaborateInterface(schema, node, connectivity(node.id))).flatMap((input) => {
        const widget = input.spec.widget
        if (widget?.controller !== 'after_generate' || input.derivedValue !== undefined ||
          connectivity(node.id).isInputConnected(input.address.port as string)) return []
        const inputId = valueKeyOf(input)
        return [{ graphId: graph.id, nodeId: node.id, inputId,
          key: exposedKey({ graphId: graph.id, nodeId: node.id, inputId: input.spec.id }),
          fixed: (node.controllers?.[inputId] ?? widget.controllerInitial ?? 'randomize') === 'fixed' }]
      })
    })
  })
}

/** Board documents share the existing transport, without pretending to be workflows. */
export class BoardWorkspace {
  readonly entries = createSignal<readonly BoardEntry[]>([])
  readonly changed = createSignal(0)
  readonly libraryChanged = createSignal(0)
  readonly scope: string
  private readonly pending = new Set<string>()
  private readonly adopting = new Map<() => void, string>()
  private readonly cancellations = new Map<string, number>()
  private readonly importing = new Map<AbortController, string>()
  private readonly saved = new Map<string, { connection: BoardConnection; record: LibraryRecord; snapshot: BoardDocument }>()
  private readonly saving = new Map<BoardEntry, Promise<void>>()
  private readonly opening = new Map<string, object>()
  private readonly titles = new Map<string, string>()
  private epoch = 0
  private disposed = false

  constructor(private readonly options: {
    readonly transport: CollabTransport
    readonly project: string
    readonly actorId: string
    readonly backend: () => string | undefined
    readonly mediaConnection: (baseUrl: string) => BoardConnection | undefined
    readonly onConflict: (id: string, message: string) => void
  }) {
    this.scope = `shared:board:${options.project}`
    const subscriptions = new Map<BoardEntry, () => void>()
    this.entries.subscribe((entries) => {
      for (const [entry, unsubscribe] of subscriptions) {
        if (!entries.includes(entry)) { unsubscribe(); subscriptions.delete(entry) }
      }
      for (const entry of entries) {
        if (subscriptions.has(entry)) continue
        const stops = [entry.session.document.subscribe(() => this.changed.update((value) => value + 1))]
        if (entry.shared) {
          const session = entry.shared.session
          const update = () => {
            const title = session.title.get()
            if (title !== undefined) this.titles.set(JSON.stringify([entry.baseUrl, entry.id]), title)
            this.entries.update((entries) => [...entries])
          }
          stops.push(session.title.subscribe(update), session.canEdit.subscribe(update))
        }
        subscriptions.set(entry, () => { for (const stop of stops) stop() })
      }
      this.changed.update((value) => value + 1)
    })
  }

  isDirty(id: string): boolean {
    const entry = this.entries.get().find((candidate) => candidate.id === id)
    const saved = this.saved.get(id)
    return entry !== undefined && (saved === undefined || saved.connection !== this.options.mediaConnection(entry.baseUrl) ||
      saved.record.name !== entry.title ||
      !jsonSameValue(entry.session.doc as unknown as Json, saved.snapshot as unknown as Json))
  }

  /** Serialize saves for the exact open entry, never a same-identity replacement. */
  async save(id: string): Promise<void> {
    const entry = this.mediaEntry(id)
    const previous = this.saving.get(entry) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.saveEntry(entry))
    this.saving.set(entry, next)
    try { await next } finally { if (this.saving.get(entry) === next) this.saving.delete(entry) }
  }

  private async saveEntry(entry: BoardEntry): Promise<void> {
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const current = () => !this.disposed && this.entries.get().includes(entry) && this.options.mediaConnection(entry.baseUrl) === connection
    if (!current()) throw new Error('Board changed before saving')
    const snapshot = entry.session.doc
    const title = entry.title
    const link = this.saved.get(entry.id)
    const digest = await connection.uploadAsset(JSON.stringify(snapshot))
    if (!current()) throw new Error('Board changed while saving')
    let record: LibraryRecord
    if (link?.connection === connection) {
      const patched = await connection.patchLibraryRecord(link.record.id, { scope: 'local', revision: link.record.revision, digest, name: title })
      if (!patched.ok) throw new Error('Saved Board changed elsewhere; close and reopen it before saving again')
      record = patched.record
    } else {
      record = await connection.createLibraryRecord({ scope: 'local', name: title, digest, mediaType: BOARD_MEDIA_TYPE, labels: ['board'] })
    }
    if (!current()) throw new Error('Board was saved, but its original document is no longer active')
    this.saved.set(entry.id, { connection, record, snapshot })
    this.changed.update((value) => value + 1)
    this.libraryChanged.update((value) => value + 1)
  }

  /** Resolve saved bytes on their owning project connection before opening a Board. */
  async openSaved(recordId: string, baseUrl: string, stillWanted: () => boolean = () => true): Promise<BoardEntry> {
    const connection = this.options.mediaConnection(baseUrl)
    if (this.disposed || !connection) throw new Error('This Board\'s backend is unavailable')
    const key = JSON.stringify([baseUrl, recordId])
    const token = {}
    this.opening.set(key, token)
    const epoch = this.epoch
    const current = () => !this.disposed && stillWanted() && this.opening.get(key) === token && this.options.mediaConnection(baseUrl) === connection
    try {
      const record = await connection.getLibraryRecord(recordId, 'local')
      if (!current()) throw new Error('Board backend changed while opening')
      if (!record || record.mediaType !== BOARD_MEDIA_TYPE) throw new Error('Saved Board is unavailable')
      const text = await connection.fetchAssetText(record.digest)
      if (!current()) throw new Error('Board backend changed while opening')
      if (text === undefined) throw new Error('Saved Board bytes are unavailable')
      const loaded = loadBoard(JSON.parse(text) as unknown)
      if (!loaded.document) throw new Error(loaded.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
      if ((this.cancellations.get(loaded.document.lineage) ?? 0) > epoch) throw new Error('Board was closed while opening')
      const existing = this.entries.get().find((entry) => entry.id === loaded.document!.lineage)
      if (existing) {
        if (existing.baseUrl !== baseUrl) throw new Error('This Board is already open on another backend')
        const link = this.saved.get(existing.id)
        if (link?.connection !== connection || link.record.id !== record.id)
          throw new Error('Another Board with this document identity is already open; close it before opening this record')
        if (link.record.revision !== record.revision || link.record.digest !== record.digest)
          throw new Error('Saved Board changed since it was opened; close and reopen it to load the saved version')
        return existing
      }
      const entry = this.open(loaded.document, record.name, baseUrl)
      this.saved.set(entry.id, { connection, record, snapshot: entry.session.doc })
      this.changed.update((value) => value + 1)
      return entry
    } finally { if (this.opening.get(key) === token) this.opening.delete(key) }
  }

  open(document: BoardDocument, title: string | undefined, baseUrl: string): BoardEntry {
    if (this.disposed) throw new Error('Board workspace is closed')
    const existing = this.entries.get().find((entry) => entry.id === document.lineage)
    if (existing) return existing
    const key = JSON.stringify([baseUrl, document.lineage])
    if (title !== undefined) this.titles.set(key, title)
    const titles = this.titles
    const entry: BoardEntry = {
      id: document.lineage, baseUrl, session: createLocalBoardSession(document),
      get name() { return titles.get(key) },
      get title() { return this.name ?? t('board.title') },
    }
    this.entries.update((entries) => [...entries, entry])
    return entry
  }

  displayTitle(id: string, baseUrl: string): string {
    return this.titles.get(JSON.stringify([baseUrl, id])) ?? t('board.title')
  }

  canRename(id: string): boolean {
    const entry = this.entries.get().find((candidate) => candidate.id === id)
    return entry !== undefined && (!entry.shared ||
      (this.options.transport.rename !== undefined && entry.shared.session.canEdit.get()))
  }

  async rename(id: string, title: string): Promise<void> {
    const entry = this.mediaEntry(id)
    if (!this.canRename(id)) throw new Error('This Board cannot be renamed')
    if (!isValidCollabTitle(title)) throw new Error('Board names must be non-blank and at most 200 characters')
    if (entry.shared) {
      await this.options.transport.rename!(entry.baseUrl, entry.shared.descriptor.sessionId, title)
    } else {
      this.titles.set(JSON.stringify([entry.baseUrl, id]), title)
      this.entries.update((entries) => [...entries])
    }
  }

  /** Board media omits executable descriptor fields; recover them from this backend, never guesses. */
  async resolveMediaAsset(id: string, itemId: string, stillWanted: () => boolean = () => true): Promise<AssetRef | undefined> {
    const entry = this.mediaEntry(id)
    const item = entry.session.doc.items[itemId]
    if (!item || !('asset' in item)) throw new Error('The selected result is no longer on this Board')
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const current = () => !this.disposed && stillWanted() && this.entries.get().includes(entry) &&
      entry.session.doc.items[itemId] === item && this.options.mediaConnection(entry.baseUrl) === connection
    const assertCurrent = () => { if (!current()) throw new Error('Board changed while resolving the selected result') }
    assertCurrent()
    const availability = await connection.checkAssetAvailability([item.asset.digest], { scope: 'local' })
    assertCurrent()
    if (!availability.some((row) => row.digest === item.asset.digest && row.status === 'available')) return undefined
    let cursor: string | undefined
    do {
      const page = await connection.listLocalAssets({ scope: 'local', limit: 200,
        ...(cursor === undefined ? {} : { cursor }) })
      assertCurrent()
      const found = page.assets.find((row) => row.asset.digest === item.asset.digest)?.asset
      if (found) return boardMediaKindOf(found.mediaType) === item.kind ? { ...found } : undefined
      cursor = page.cursor
    } while (cursor !== undefined)
    const matches = await connection.guessAssets([item.asset.name], { [item.asset.name]: item.asset.digest })
    assertCurrent()
    for (const candidate of matches.flatMap((match) => match.candidates)) {
      if (!candidate.held || candidate.digest !== item.asset.digest) continue
      const ref = assetGuessCandidateToRef(candidate)
      if (ref && boardMediaKindOf(ref.mediaType) === item.kind) return { ...ref }
    }
    return undefined
  }

  /** Test the same source face that placement uses, without creating a card or running it. */
  async cardAcceptsMedia(id: string, kind: BoardCardItem['kind'], source: BoardCardSource,
    asset: BoardAsset, resolve: (type: string) => NodeSchema | undefined,
    stillWanted: () => boolean = () => true,
  ): Promise<boolean> {
    const entry = this.mediaEntry(id)
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const current = () => !this.disposed && stillWanted() && this.entries.get().includes(entry) &&
      this.options.mediaConnection(entry.baseUrl) === connection
    const loaded = await this.cardSource(connection, kind, source, current)
    if (!current()) throw new Error('Board changed while loading the card')
    return cardMediaInput(cardFace(loaded.document, kind, loaded.name ?? '', resolve), asset, resolve) !== undefined
  }

  /** Resolve and validate the source before committing a single undoable placement. */
  async placeCard(id: string, source: {
    readonly project: string
    readonly baseUrl: string
    readonly kind: BoardCardItem['kind']
    readonly source: BoardCardSource
    readonly name: string
  }, point: { readonly x: number; readonly y: number }, stillWanted: () => boolean = () => true,
    continuation?: {
      readonly itemId: string
      readonly asset: AssetRef
      readonly resolve: (type: string) => NodeSchema | undefined
    },
  ): Promise<string> {
    const entry = this.mediaEntry(id)
    if (source.project !== this.options.project || source.baseUrl !== entry.baseUrl)
      throw new Error('Cards must come from this Board\'s project and backend')
    const selection = structuredClone(source)
    const location = { ...point }
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const origin = continuation === undefined ? undefined : entry.session.doc.items[continuation.itemId]
    const asset = continuation === undefined ? undefined : structuredClone(continuation.asset)
    if (continuation && (!origin || !('asset' in origin) || origin.asset.digest !== asset?.digest))
      throw new Error('The selected result is no longer on this Board')
    const current = () => !this.disposed && stillWanted() && this.entries.get().includes(entry) &&
      this.options.mediaConnection(entry.baseUrl) === connection &&
      (origin === undefined || entry.session.doc.items[origin.id] === origin)
    const loaded = await this.cardSource(connection, selection.kind, selection.source, current)
    if (!current()) throw new Error('Board changed while loading the card; nothing was placed')
    let x = location.x - 170
    let y = location.y - 94
    let values: Record<string, Json> = {}
    let continuedFrom: BoardCardItem['continuedFrom']
    if (continuation && origin && 'asset' in origin && asset) {
      const document = cardFace(loaded.document, selection.kind, loaded.name ?? selection.name, continuation.resolve)
      const input = cardMediaInput(document, origin.asset, continuation.resolve)
      if (!input || input.kind !== 'live') throw new Error('This source has no compatible exposed input')
      const availability = await connection.checkAssetAvailability([asset.digest], { scope: 'local' })
      if (!current()) throw new Error('Board changed while loading the card; nothing was placed')
      if (!availability.some((row) => row.digest === asset.digest && row.status === 'available'))
        throw new Error('The selected result file is unavailable')
      const inputKey = exposedKey(input.entry)
      values = { [inputKey]: assetMultiSelect(input.item.spec.type) ? [asset] : asset }
      continuedFrom = { itemId: origin.id, inputKey }
      x = origin.rect.x + origin.rect.width + 24
      y = origin.rect.y
      for (;;) {
        const hits = Object.values(entry.session.doc.items).filter((item) => item.kind !== 'section' &&
          x < item.rect.x + item.rect.width + 24 && x + 340 + 24 > item.rect.x &&
          y < item.rect.y + item.rect.height + 24 && y + 188 + 24 > item.rect.y)
        if (!hits.length) break
        x = Math.max(...hits.map((item) => item.rect.x + item.rect.width + 24))
      }
    } else {
      while (Object.values(entry.session.doc.items).some((item) => item.rect.x === x && item.rect.y === y)) {
        x += 24
        y += 24
      }
    }
    const result = entry.session.dispatch({ command: 'board.item.add', params: { items: [{
      kind: selection.kind, name: (loaded.name ?? selection.name).slice(0, BOARD_MAX_NAME),
      source: selection.source, values, autoSize: true, rect: { x, y, width: 340, height: 188 },
      ...(continuedFrom === undefined ? {} : { continuedFrom }),
    }] } })
    if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    return result.created[0]!
  }

  /** A private compile/control snapshot; neither source bytes nor editing tabs are changed. */
  async loadCard(id: string, cardId: string, resolve: (type: string) => NodeSchema | undefined,
    stillWanted: () => boolean = () => true,
  ): Promise<WorkflowDocument> {
    const entry = this.mediaEntry(id)
    const card = entry.session.doc.items[cardId]
    if (!card || (card.kind !== 'workflow' && card.kind !== 'blueprint')) throw new Error('Card is no longer on this Board')
    const connection = this.options.mediaConnection(entry.baseUrl)
    const document = await this.loadCardSource(id, cardId, resolve, () => stillWanted() && entry.session.doc.items[cardId] === card)
    if (this.disposed || !stillWanted() || !this.entries.get().includes(entry) || entry.session.doc.items[cardId] !== card ||
      this.options.mediaConnection(entry.baseUrl) !== connection) throw new Error('Card changed while loading')
    return this.resolveCardInputs(id, cardId, document, resolve)
  }

  /** Discard hidden controls made fixed in the source before they can be exposed again. */
  resolveCardInputs(id: string, cardId: string, document: WorkflowDocument,
    resolve: (type: string) => NodeSchema | undefined,
  ): WorkflowDocument {
    const entry = this.mediaEntry(id)
    const card = entry.session.doc.items[cardId]
    if (!card || (card.kind !== 'workflow' && card.kind !== 'blueprint')) throw new Error('Card is no longer on this Board')
    const snapshot = applyCardInputs(document, card.values, resolve, card.controllers)
    const exposed = new Set(buildParamRows(snapshot, documentResolver(snapshot, resolve))
      .flatMap((row) => [exposedKey(row.entry), ...(row.kind === 'live' ? [exposedKey({ ...row.entry, inputId: row.valueKey })] : [])]))
    const fixed = new Set(cardControllerInputs(snapshot, resolve)
      .filter((input) => input.fixed && !exposed.has(exposedKey(input)) && !exposed.has(input.key))
      .flatMap((input) => [exposedKey(input), input.key]))
    const values = Object.fromEntries(Object.entries(card.values).filter(([key]) => !fixed.has(key)))
    if (!jsonSameValue(card.values, values)) entry.session.dispatch({ command: 'board.card.inputs', params: { id: cardId, values } })
    for (const key of Object.keys(card.controllers ?? {})) {
      if (!exposed.has(key)) entry.session.dispatch({ command: 'board.card.controller', params: { id: cardId, key } })
    }
    return snapshot
  }

  /** The source defaults stay separate from overrides so undo can restore them without another fetch. */
  async loadCardSource(id: string, cardId: string, resolve: (type: string) => NodeSchema | undefined,
    stillWanted: () => boolean = () => true,
  ): Promise<WorkflowDocument> {
    const entry = this.mediaEntry(id)
    const card = entry.session.doc.items[cardId]
    if (!card || (card.kind !== 'workflow' && card.kind !== 'blueprint')) throw new Error('Card is no longer on this Board')
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const current = () => {
      const latest = entry.session.doc.items[cardId]
      return !this.disposed && stillWanted() && this.entries.get().includes(entry) &&
        this.options.mediaConnection(entry.baseUrl) === connection && latest?.kind === card.kind &&
        jsonSameValue(latest.source, card.source)
    }
    const loaded = await this.cardSource(connection, card.kind, card.source, current)
    if (!current()) throw new Error('Card changed while loading')
    return cardFace(loaded.document, card.kind, card.name, resolve)
  }

  private async cardSource(connection: BoardConnection, kind: BoardCardItem['kind'], source: BoardCardSource,
    current: () => boolean,
  ): Promise<{ readonly document: WorkflowDocument; readonly name?: string }> {
    let document: WorkflowDocument | undefined
    let name: string | undefined
    if (source.kind === 'library') {
      const record = await connection.getLibraryRecord(source.recordId, 'local')
      if (!current()) throw new Error('Board changed while loading the card')
      if (!record || record.mediaType !== 'application/x-dinkster-workflow+json' || !record.labels.includes(kind))
        throw new Error(`The saved ${kind} is no longer available`)
      name = record.name
      const text = await connection.fetchAssetText(record.digest)
      if (!current()) throw new Error('Board changed while loading the card')
      if (text !== undefined) document = loadDocument(JSON.parse(text) as unknown).document
    } else {
      if (kind !== 'blueprint') throw new Error('Only blueprints can come from a pack')
      document = await connection.fetchBlueprintBody?.(source.packId, source.blueprintId, source.digest)
      if (!current()) throw new Error('Board changed while loading the card')
    }
    if (!document) throw new Error(`The ${kind} source bytes are unavailable or invalid`)
    if (kind === 'blueprint' && !document.graphs[document.root]?.boundary)
      throw new Error('The blueprint source is not a boundary subgraph')
    return { document, ...(name === undefined ? {} : { name }) }
  }

  /** Refuse mismatched source context and missing bytes before placing recorded Assets. */
  async placeMedia(id: string, source: {
    readonly project: string
    readonly baseUrl: string
    readonly assets: readonly BoardAsset[]
    readonly run?: { readonly job: string; readonly card: string; readonly places?: readonly BoardRect[] }
  }, point: { readonly x: number; readonly y: number }): Promise<readonly string[]> {
    const entry = this.mediaEntry(id)
    if (source.project !== this.options.project || source.baseUrl !== entry.baseUrl)
      throw new Error('Media must come from this Board\'s project and backend')
    const run = source.run === undefined ? undefined : structuredClone(source.run)
    if (run && Object.hasOwn(entry.session.doc.runs ?? {}, run.job)) return []
    const assets = structuredClone(source.assets)
    const items = run && assets.length === 0 ? [] : this.mediaItems(entry, assets, point)
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const abort = new AbortController()
    this.importing.set(abort, id)
    try {
      const availability = assets.length === 0 ? [] : await connection.checkAssetAvailability([...new Set(assets.map((asset) => asset.digest))], {
        scope: 'local', signal: abort.signal,
      })
      this.assertMediaCurrent(entry, abort.signal, connection)
      if (assets.some((asset) => !availability.some((row) => row.digest === asset.digest && row.status === 'available')))
        throw new Error('Some media is unavailable; nothing was placed')
      return this.commitMedia(entry, run?.places?.length
        ? this.fitRunMedia(entry, items, run.places) : items, run)
    } finally { this.importing.delete(abort) }
  }

  /** Fix a run's held places before submission; saved and removed results still inform its count. */
  reserveResultPlaces(id: string, cardId: string, savingNodes: number,
    occupied: readonly BoardRect[] = [], previousJob?: string,
  ): readonly BoardRect[] {
    const entry = this.mediaEntry(id)
    const board = entry.session.doc
    const card = board.items[cardId]
    if (!card || (card.kind !== 'workflow' && card.kind !== 'blueprint'))
      throw new Error('This card is unavailable')
    const previous = previousJob === undefined
      ? Object.values(board.runs ?? {}).reverse().find((run) => run.card === cardId)
      : board.runs?.[previousJob]
    const count = Math.min(8, Math.max(1, previous?.items.length ?? savingNodes))
    const places: BoardRect[] = []
    const left = card.rect.x + card.rect.width + 24
    let top = card.rect.y
    for (let index = 0; index < count; index += 1) {
      const prior = board.items[previous?.items[index] ?? '']
      const size = prior && 'asset' in prior ? prior.rect : { width: 280, height: 175 }
      if (index > 0 && index % 2 === 0) {
        const row = places.slice(-2)
        top = Math.max(...row.map((place) => place.y + place.height)) + 24
      }
      const before = places.at(-1)
      places.push({ x: index % 2 === 0 ? left : before!.x + before!.width + 24,
        y: top, width: size.width, height: size.height })
    }
    const box = { x: left, y: card.rect.y,
      width: Math.max(...places.map((place) => place.x + place.width)) - left,
      height: Math.max(...places.map((place) => place.y + place.height)) - card.rect.y }
    const obstacles = [...Object.values(board.items).filter((item) => item.kind !== 'section').map((item) => item.rect), ...occupied]
    const y = this.freeResultRow(box, obstacles)
    return places.map((place) => ({ ...place, y: place.y + y - box.y }))
  }

  private freeResultRow(box: BoardRect, obstacles: readonly BoardRect[]): number {
    let y = box.y
    for (;;) {
      const hits = obstacles.filter((item) => box.x < item.x + item.width + 24 &&
        box.x + box.width + 24 > item.x && y < item.y + item.height + 24 && y + box.height + 24 > item.y)
      if (!hits.length) return y
      y = Math.max(...hits.map((item) => item.y + item.height + 24))
    }
  }

  private fitRunMedia(entry: BoardEntry, items: readonly BoardItemInput[], held: readonly BoardRect[]): readonly BoardItemInput[] {
    const obstacles = Object.values(entry.session.doc.items).filter((item) => item.kind !== 'section').map((item) => item.rect)
    const last = held.at(-1)!
    const left = held[0]!.x
    let offset = 0
    let column = 0
    let sizes = [held[0]!, held[1] ?? last]
    let rowTop = held[0]!.y
    const nextRow = () => {
      const below = rowTop + Math.max(...sizes.map((size) => size.height)) + 24
      offset += 2
      sizes = [held[offset] ?? last, held[offset + 1] ?? last]
      rowTop = Math.max(below, held[offset]?.y ?? below)
      if (offset >= held.length) rowTop = this.freeResultRow({ x: left, y: rowTop,
        width: sizes[0]!.width + sizes[1]!.width + 24,
        height: Math.max(...sizes.map((size) => size.height)) }, obstacles)
      column = 0
    }
    return items.map((item) => {
      if (column === 2) nextRow()
      let place = { x: left + (column === 0 ? 0 : sizes[0]!.width + 24),
        y: rowTop, width: sizes[column]!.width, height: sizes[column]!.height }
      if (this.freeResultRow(place, obstacles) !== rowTop) {
        nextRow()
        rowTop = this.freeResultRow({ x: left, y: rowTop,
          width: sizes[0]!.width + sizes[1]!.width + 24,
          height: Math.max(...sizes.map((size) => size.height)) }, obstacles)
        place = { x: left, y: rowTop, width: sizes[0]!.width, height: sizes[0]!.height }
      }
      column += 1
      const scale = Math.min(1, place.width / item.rect.width, place.height / item.rect.height)
      return { ...item, rect: { x: place.x, y: place.y, width: item.rect.width * scale, height: item.rect.height * scale } }
    })
  }

  /** Upload the whole batch before placing it as one undoable Board edit. */
  async importMedia(id: string, files: readonly BoardMediaFile[], point: { readonly x: number; readonly y: number },
    destination: AssetUploadDestination = {}, signal?: AbortSignal,
  ): Promise<readonly string[]> {
    signal?.throwIfAborted()
    const entry = this.mediaEntry(id)
    const batch = files.map(({ file, width, height, duration }) => {
      const kind = boardMediaKindOf(file.type)
      if (!kind) throw new Error(`Unsupported Board media: ${file.name}`)
      if (file.size > (kind === 'picture' ? 256 : 1024) * 1024 * 1024)
        throw new Error(`File exceeds the Board media upload limit: ${file.name}`)
      return { file, kind, metadata: {
        ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}),
        ...(duration !== undefined ? { duration } : {}),
      } }
    })
    if (batch.length === 0) throw new Error('No media to import')
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const target = { ...destination }
    const location = { ...point }
    const abort = new AbortController()
    const currentSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    this.importing.set(abort, id)
    const assets: BoardAsset[] = []
    try {
      for (const { file, kind, metadata } of batch) {
        this.assertMediaCurrent(entry, currentSignal, connection)
        const asset = await connection.uploadMediaAsset(file, {
          ...target, scope: 'local', name: file.name, signal: currentSignal,
          kind: kind === 'picture' ? 'media/image' : kind === 'video' ? 'media/video' : 'media/audio',
        })
        this.assertMediaCurrent(entry, currentSignal, connection)
        if (boardMediaKindOf(asset.mediaType) !== kind) throw new Error('Uploaded media has an unexpected kind')
        assets.push({ ...metadata, digest: asset.digest, mediaType: asset.mediaType, name: asset.name.slice(0, BOARD_MAX_NAME) })
      }
      return this.commitMedia(entry, this.mediaItems(entry, assets, location))
    } finally { this.importing.delete(abort) }
  }

  private mediaEntry(id: string): BoardEntry {
    const entry = this.entries.get().find((candidate) => candidate.id === id)
    if (this.disposed || !entry) throw new Error('Board is not open')
    return entry
  }

  private assertMediaCurrent(entry: BoardEntry, signal: AbortSignal, connection: BoardConnection): void {
    signal.throwIfAborted()
    if (this.disposed || !this.entries.get().includes(entry) ||
        this.options.mediaConnection(entry.baseUrl) !== connection)
      throw new Error('Board changed while importing; nothing was placed')
  }

  private cancelImports(id: string): void {
    for (const [abort, owner] of this.importing) if (owner === id) abort.abort()
  }

  private mediaItems(entry: BoardEntry, assets: readonly BoardAsset[], point: { readonly x: number; readonly y: number }): readonly BoardItemInput[] {
    const items = assets.map((asset, index): BoardItemInput => {
      const kind = boardMediaKindOf(asset.mediaType)
      if (!kind) throw new Error(`Unsupported Board media: ${asset.name}`)
      const ratio = asset.width && asset.height ? asset.width / asset.height : 280 / 175
      const height = kind === 'sound' ? 80 : Math.max(16, 280 / ratio)
      const width = kind === 'sound' ? 320 : height * ratio
      return { kind, asset, rect: { x: point.x + index * 24, y: point.y + index * 24, width, height } }
    })
    const plan = planBoardCommand(entry.session.doc, { command: 'board.item.add', params: { items } })
    if (!plan.ok) throw new Error(plan.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    return items
  }

  private commitMedia(entry: BoardEntry, items: readonly BoardItemInput[], run?: { readonly job: string; readonly card: string }): readonly string[] {
    const result = entry.session.dispatch(run === undefined
      ? { command: 'board.item.add', params: { items } }
      : { command: 'board.run.add', params: { job: run.job, card: run.card, items } })
    if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    return result.created
  }

  async discover(): Promise<readonly CollabSessionDescriptor[]> {
    const baseUrl = this.options.backend()
    if (this.disposed || baseUrl === undefined) return []
    return (await this.options.transport.list(baseUrl, this.scope))
      .filter((descriptor) => descriptor.scope === this.scope && descriptor.documentKind === 'board')
  }

  async share(id: string): Promise<BoardEntry> {
    if (this.disposed) throw new Error('Board workspace is closed')
    const entry = this.entries.get().find((entry) => entry.id === id)
    if (!entry) throw new Error('Board is not open')
    if (entry.shared) return entry
    if (this.pending.has(id)) throw new Error('Board publication is already in progress')
    this.pending.add(id)
    const revision = entry.session.revision
    const snapshot = entry.session.doc
    const name = entry.name
    try {
      const descriptor = await this.options.transport.create(entry.baseUrl, {
        scope: this.scope, documentKind: 'board', documentId: entry.id, snapshot,
        ...(name !== undefined ? { title: name } : {}),
      })
      try {
        return await this.adopt(descriptor, entry.baseUrl, () =>
          this.entries.get().includes(entry) && entry.session.revision === revision && entry.session.doc === snapshot && entry.name === name)
      } catch (error) {
        void this.options.transport.end(entry.baseUrl, descriptor.sessionId).catch(() => undefined)
        throw error
      }
    } finally { this.pending.delete(id) }
  }

  async join(sessionId: string, stillWanted: () => boolean = () => true): Promise<BoardEntry> {
    if (this.disposed) throw new Error('Board workspace is closed')
    const baseUrl = this.options.backend()
    if (baseUrl === undefined) throw new Error('No Dinkster backend connected')
    const existing = this.entries.get().find((entry) =>
      entry.baseUrl === baseUrl && entry.shared?.descriptor.sessionId === sessionId)
    if (existing) return existing
    const key = `join:${sessionId}`
    if (this.pending.has(key)) throw new Error('Joining this Board is already in progress')
    this.pending.add(key)
    const epoch = this.epoch
    try {
      const descriptor = await this.options.transport.get(baseUrl, sessionId)
      if (!descriptor) throw new Error('That Board session no longer exists')
      if (this.entries.get().some((entry) => entry.id === descriptor.documentId))
        throw new Error('This Board is already open; close it before joining another session')
      return await this.adopt(descriptor, baseUrl, () =>
        stillWanted() && (this.cancellations.get(descriptor.documentId) ?? 0) <= epoch &&
        this.options.backend() === baseUrl && !this.entries.get().some((entry) => entry.id === descriptor.documentId))
    } finally { this.pending.delete(key) }
  }

  private async adopt(
    descriptor: CollabSessionDescriptor, baseUrl: string, current: () => boolean,
  ): Promise<BoardEntry> {
    if (descriptor.documentKind !== 'board' || descriptor.scope !== this.scope)
      throw new Error('That session does not belong to this project\'s Boards')
    const assertCurrent = () => {
      if (this.disposed || !current()) throw new Error('Board changed while joining; the current document was kept')
    }
    assertCurrent()
    const transport = this.options.transport
    const actorId = await transport.bindActor?.(baseUrl, descriptor.sessionId, this.options.actorId) ?? this.options.actorId
    assertCurrent()
    const connection = transport.connect({ baseUrl, sessionId: descriptor.sessionId, actorId })
    let session: SharedBoardSession | undefined
    const cancel = () => { if (session) session.close(); else connection.close() }
    this.adopting.set(cancel, descriptor.documentId)
    try {
      session = await connectSharedBoardSession(connection, descriptor, {
        actorId, onConflict: ({ message }) => this.options.onConflict(descriptor.documentId, message),
      })
      assertCurrent()
      await session.settle()
      assertCurrent()
      if (session.status.get() === 'closed' || session.status.get() === 'error')
        throw new Error('The shared Board could not be opened')
      const key = JSON.stringify([baseUrl, descriptor.documentId])
      if (session.title.get() !== undefined) this.titles.set(key, session.title.get()!)
      const titles = this.titles
      const sharedSession = session
      const entry: BoardEntry = {
        id: descriptor.documentId, baseUrl, session, shared: { descriptor, session },
        get name() { return sharedSession.title.get() ?? titles.get(key) },
        get title() { return this.name ?? t('board.title') },
      }
      this.cancelImports(entry.id)
      this.entries.update((entries) => entries.some((candidate) => candidate.id === entry.id)
        ? entries.map((candidate) => candidate.id === entry.id ? entry : candidate) : [...entries, entry])
      return entry
    } catch (error) {
      cancel()
      throw error
    } finally { this.adopting.delete(cancel) }
  }

  leave(id: string): void {
    const entry = this.entries.get().find((entry) => entry.id === id)
    if (!entry?.shared) return
    const key = JSON.stringify([entry.baseUrl, id])
    if (entry.name !== undefined) this.titles.set(key, entry.name)
    const titles = this.titles
    const local: BoardEntry = {
      id, baseUrl: entry.baseUrl, session: createLocalBoardSession(entry.session.doc),
      get name() { return titles.get(key) },
      get title() { return this.name ?? t('board.title') },
    }
    this.cancelImports(id)
    entry.shared.session.close()
    this.entries.update((entries) => entries.map((candidate) => candidate === entry ? local : candidate))
  }

  async end(id: string): Promise<void> {
    const entry = this.entries.get().find((entry) => entry.id === id)
    if (!entry?.shared) throw new Error('This Board is not shared')
    await this.options.transport.end(entry.baseUrl, entry.shared.descriptor.sessionId)
    if (this.entries.get().includes(entry)) this.leave(id)
  }

  close(id: string): void {
    this.cancellations.set(id, ++this.epoch)
    for (const [cancel, owner] of this.adopting) if (owner === id) cancel()
    this.cancelImports(id)
    const entry = this.entries.get().find((entry) => entry.id === id)
    entry?.shared?.session.close()
    this.saved.delete(id)
    this.entries.update((entries) => entries.filter((entry) => entry.id !== id))
  }

  dispose(): void {
    this.disposed = true
    this.opening.clear()
    this.saved.clear()
    this.titles.clear()
    for (const abort of this.importing.keys()) abort.abort()
    for (const cancel of this.adopting.keys()) cancel()
    for (const entry of this.entries.get()) entry.shared?.session.close()
    this.entries.set([])
  }
}
