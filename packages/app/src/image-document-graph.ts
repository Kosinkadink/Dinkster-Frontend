import { IMAGE_DOCUMENT_MEDIA_TYPE, type DinksterConnection, type ValueQuery } from '@dinkster/client'
import {
  MAX_IMAGE_DOCUMENT_BYTES,
  IMAGE_OUTPUT_POLICY_EXTENSION,
  canonicalJson,
  imageOutputPolicyOf,
  loadImageDocument,
  serializeImageDocument,
  sha256Hex,
  type ConnectionId,
  type ImageDocument,
  type Json,
} from '@dinkster/core'
import {
  adoptExactImageDocumentBytes,
  adoptImageDocumentForRender,
  hydrateImageDocumentResources,
  renderAdoptedImageDocument,
  type VerifiedImageDocumentRender,
} from './image-document-library.js'
import { type ImageDocumentLocalStore, type ImageDocumentDraft } from './image-document-local.js'
import { currentGraphId, type AppState } from './app-state.js'

const GRAPH_IMAGE_DOCUMENT_SCOPE = 'local'

export interface GraphImageDocumentRequest {
  readonly connectionId: ConnectionId
  readonly query: ValueQuery
  readonly sourceTabId: string
  readonly graphId: string
  readonly sourceNodeId: string
  readonly sourceOutputId: string
  readonly expectedGraphFingerprint: string
}

export interface ImageDocumentGraphOrigin {
  readonly connectionId: ConnectionId
  readonly sourceTabId: string
  readonly graphId: string
  readonly sourceNodeId: string
  readonly sourceOutputId: string
  readonly expectedGraphFingerprint: string
  readonly document: ImageDocument
}

export const isLayerDocumentType = (typeId: string): boolean =>
  typeId === 'dinkster.layers' || typeId === 'comfy.LAYERS'

export interface OpenedGraphImageDocument {
  readonly draft: ImageDocumentDraft
  readonly render: VerifiedImageDocumentRender
  readonly document: ImageDocument
}

/** Open the native document rendition, never a flattened preview or producer path. */
export async function openGraphImageDocument(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  query: ValueQuery,
): Promise<OpenedGraphImageDocument> {
  const values = connection.values()
  const peek = await values.peek(query)
  if (!peek.available) throw new Error(`Layer value unavailable: ${peek.error}`)
  if (!isLayerDocumentType(peek.descriptor.typeId)) throw new Error('The graph output is not a layer document')
  const native = peek.renditions.find((rendition) =>
    rendition.kind === 'document' && rendition.mime.split(';', 1)[0] === IMAGE_DOCUMENT_MEDIA_TYPE)
  if (native === undefined) throw new Error('This value owner does not advertise a native ImageDocument rendition')
  const result = await values.rendition(query, 'document')
  if (!result.available) throw new Error(`Layer document unavailable: ${result.error}`)
  if (result.fingerprint !== peek.descriptor.fingerprint ||
    result.typeId !== peek.descriptor.typeId || result.reportedKind !== 'document' ||
    result.mime !== native.mime || result.mime !== IMAGE_DOCUMENT_MEDIA_TYPE) {
    throw new Error('Layer document rendition does not match the selected graph value')
  }
  if (result.bytes.byteLength > MAX_IMAGE_DOCUMENT_BYTES) throw new Error('Layer document exceeds the document size limit')
  const bytes = new Uint8Array(result.bytes)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const parsed: unknown = JSON.parse(text)
  if (canonicalJson(parsed) !== text) throw new Error('Layer document rendition is not canonical')
  const loaded = loadImageDocument(parsed)
  if (loaded.document === undefined) {
    throw new Error(loaded.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  }
  if (serializeImageDocument(loaded.document) !== text) {
    throw new Error('Layer document rendition cannot be opened without changing its canonical bytes')
  }
  const current = await store.recoverDraft(loaded.document.lineage)
  if (current !== undefined && serializeImageDocument(current.document) !== serializeImageDocument(loaded.document)) {
    throw new Error('This layer document has unsaved local edits; use the recovered draft instead')
  }
  const adopted = await adoptExactImageDocumentBytes(
    connection,
    loaded.document,
    bytes,
    GRAPH_IMAGE_DOCUMENT_SCOPE,
  )
  const render = await renderAdoptedImageDocument(
    connection,
    adopted.digest,
    text,
    GRAPH_IMAGE_DOCUMENT_SCOPE,
  )
  await hydrateImageDocumentResources(connection, store, loaded.document)
  const draft = current ?? await store.saveDraft(
    loaded.document,
    `${query.nodeId} / ${query.outputId}`,
    undefined,
    null,
  )
  return { draft, render, document: loaded.document }
}

const same = (left: unknown, right: unknown): boolean => left === undefined || right === undefined
  ? left === right
  : canonicalJson(left as Json) === canonicalJson(right as Json)

/** Translate the editor's resulting state into schema-declared layer edit commands. */
export function imageDocumentRecipeCommands(source: ImageDocument, edited: ImageDocument): readonly Json[] {
  const renderingExtensions = (document: ImageDocument): Readonly<Record<string, Json>> =>
    Object.fromEntries(Object.entries(document.extensions ?? {}).filter(([key]) => key !== IMAGE_OUTPUT_POLICY_EXTENSION))
  if (!same(source.resources, edited.resources) ||
    !same(Object.keys(source.layers).sort(), Object.keys(edited.layers).sort()) ||
    !same(Object.keys(source.masks).sort(), Object.keys(edited.masks).sort())) {
    throw new Error('Recipe export does not support added or removed layers, masks, or resources')
  }
  if (!same(renderingExtensions(source), renderingExtensions(edited))) {
    throw new Error('Recipe export does not support rendering extension changes')
  }
  const commands: Json[] = []
  if (!same(source.canvas, edited.canvas)) {
    const changes = Object.fromEntries(Object.entries(edited.canvas).filter(([key, value]) =>
      !same(source.canvas[key as keyof ImageDocument['canvas']], value)))
    commands.push({ op: 'canvas', changes })
  }
  const reorder = (parent: string | null, before: readonly string[], after: readonly string[]): void => {
    if (same(before, after)) return
    if (!same([...before].sort(), [...after].sort())) throw new Error('Recipe export does not support changing layer ownership')
    commands.push({ op: 'reorder', ...(parent === null ? {} : { parent }), ids: after })
  }
  reorder(null, source.rootLayerIds, edited.rootLayerIds)
  for (const [id, layer] of Object.entries(edited.layers)) {
    const previous = source.layers[id]!
    if (layer.kind !== previous.kind || layer.id !== previous.id || !same(layer.maskIds, previous.maskIds) ||
      (layer.kind === 'raster' && (previous.kind !== 'raster' || layer.resourceId !== previous.resourceId ||
        !same(layer.sourceRect, previous.sourceRect)))) {
      throw new Error('Recipe export does not support changing layer structure or raster sources')
    }
    if (layer.kind === 'group') {
      if (previous.kind !== 'group') throw new Error('Recipe export does not support changing layer kinds')
      reorder(id, previous.childLayerIds, layer.childLayerIds)
    }
    const excluded = new Set(['id', 'kind', 'maskIds', 'childLayerIds', 'resourceId', 'sourceRect'])
    const changes = Object.fromEntries(Object.entries(layer).filter(([key, value]) =>
      !excluded.has(key) && !same(previous[key as keyof typeof previous], value)))
    if (Object.keys(changes).length > 0) commands.push({ op: 'layer', id, changes })
  }
  for (const [id, mask] of Object.entries(edited.masks)) {
    const previous = source.masks[id]!
    if (mask.id !== previous.id || mask.kind !== previous.kind || mask.ownerLayerId !== previous.ownerLayerId ||
      mask.resourceId !== previous.resourceId || !same(mask.sourceRect, previous.sourceRect)) {
      throw new Error('Recipe export does not support changing mask structure or raster sources')
    }
    const excluded = new Set(['id', 'kind', 'ownerLayerId', 'resourceId', 'sourceRect'])
    const changes = Object.fromEntries(Object.entries(mask).filter(([key, value]) =>
      !excluded.has(key) && !same(previous[key as keyof typeof previous], value)))
    if (Object.keys(changes).length > 0) commands.push({ op: 'mask', id, changes })
  }
  return commands
}

export async function exportImageDocumentRecipe(
  app: AppState,
  origin: ImageDocumentGraphOrigin,
  document: ImageDocument,
): Promise<void> {
  const tab = app.activeTab()
  if (tab === undefined || tab.execution !== undefined) throw new Error('Select the editable source workflow for recipe export')
  if (tab.id !== origin.sourceTabId) throw new Error('Select the source workflow used to create this image document')
  if (currentGraphId(tab) !== origin.graphId) throw new Error('Open the source graph used to create this image document')
  const graph = tab.store.doc.graphs[origin.graphId]
  if (graph === undefined || sha256Hex(canonicalJson(graph)) !== origin.expectedGraphFingerprint) {
    throw new Error('The source graph changed since this image document was opened')
  }
  const backend = app.backendForTab(tab)
  if (backend.id !== origin.connectionId) throw new Error('The source backend changed since this image document was opened')
  const policy = imageOutputPolicyOf(document)
  const commands = canonicalJson(imageDocumentRecipeCommands(origin.document, document))
  const outcome = app.dispatchTo(tab, { command: 'image.documentRecipeExport', params: {
    graphId: origin.graphId,
    expectedGraphFingerprint: origin.expectedGraphFingerprint,
    sourceNodeId: origin.sourceNodeId,
    sourceOutputId: origin.sourceOutputId,
    commands,
    format: policy.format,
    quality: policy.quality,
  } })
  if (!outcome.ok) throw new Error(outcome.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
}

export async function exportImageDocumentSnapshot(
  app: AppState,
  store: ImageDocumentLocalStore,
  document: ImageDocument,
  name: string,
): Promise<void> {
  const tab = app.activeTab()
  if (tab === undefined || tab.execution !== undefined) throw new Error('Select an editable workflow for export')
  const graphId = currentGraphId(tab)
  const graph = tab.store.doc.graphs[graphId]
  if (graph === undefined) throw new Error('The destination graph is unavailable')
  const backend = app.backendForTab(tab)
  const registry = app.registryForTab(tab)
  if (backend.protocol !== 'dinkster' || registry?.resolve.forEditorRole?.('layers-load') === undefined ||
    registry.resolve.forEditorRole('layers-flatten') === undefined) {
    throw new Error('The destination does not advertise layer load and flatten nodes')
  }
  const expectedGraphFingerprint = sha256Hex(canonicalJson(graph))
  const adopted = await adoptImageDocumentForRender(backend.connection, store, document, 'local')
  if (app.activeTab() !== tab || app.backendForTab(tab) !== backend || currentGraphId(tab) !== graphId) {
    throw new Error('The destination workflow or backend changed during export')
  }
  const outcome = app.dispatchTo(tab, { command: 'image.documentExport', params: {
    graphId, expectedGraphFingerprint, position: { x: 80, y: 80 },
    asset: { digest: adopted.digest, name: `${name}.dinkster-image`,
      size: new TextEncoder().encode(serializeImageDocument(adopted.document)).byteLength,
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE, virtualPath: '' },
  } })
  if (!outcome.ok) throw new Error(outcome.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
}
