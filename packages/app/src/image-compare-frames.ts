import { canvasPaintTokens } from '@dinkster/canvas'
import type { PreviewData } from '@dinkster/client'
import { isAssetRefValue, occurrencesForView, type AssetRef, type WidgetParts } from '@dinkster/core'
import { viewInstancePath, type AppState, type Tab } from './app-state.js'
import { liveExactnessFor } from './companion-display.js'
import { editorInputSource, type EditorInputAddress } from './in-node-editor-source.js'

export const IMAGE_COMPARE_SIDES = ['image_a', 'image_b'] as const
export type ImageCompareSide = typeof IMAGE_COMPARE_SIDES[number]

/** A known wired image can be shown before the comparison node itself runs. */
export async function readImageCompareInput(app: AppState, tab: Tab, at: EditorInputAddress, signal: AbortSignal): Promise<readonly PreviewData[]> {
  const source = editorInputSource(app, tab, at, signal)
  if (source === undefined) return []
  let payload: Blob
  if (source.kind === 'literal') {
    if (!isAssetRefValue(source.value)) return []
    const asset = source.value as unknown as AssetRef
    const backend = app.backendForTab(tab)
    if (!asset.mediaType.startsWith('image/') || backend.protocol !== 'dinkster') return []
    const revision = tab.store.revision
    const bytes = await backend.connection.fetchAssetBytes(asset.digest, signal)
    if (signal.aborted || tab.store.revision !== revision || app.backendForTab(tab).connection !== backend.connection
      || bytes === undefined || bytes.byteLength > 64 * 1024 * 1024) return []
    payload = new Blob([bytes], { type: asset.mediaType })
  } else {
    const { values, query, current } = source
    const peek = await values.peek(query, { signal })
    if (!current() || !peek.available || peek.descriptor.typeId !== 'IMAGE') return []
    const info = peek.renditions.find((entry) => entry.mime === 'image/png')
    if (!info) return []
    const result = await values.read(query, peek.descriptor, () => values.rendition(query, info.kind, { signal, descriptor: peek.descriptor,
      ...(info.parameters?.includes('batch') ? { batch: 0 } : {}),
      ...(info.version === undefined ? {} : { rendererVersion: info.version }) }))
    if (!current() || !result.available || result.mime !== info.mime || result.fingerprint !== peek.descriptor.fingerprint
      || result.bytes.byteLength > 64 * 1024 * 1024) return []
    payload = new Blob([result.bytes], { type: result.mime })
  }
  return [{ channel: at.inputId, payload, timestamp: 0 }]
}

/**
 * The images a comparison node's last run streamed for each side, in frame
 * order: the previews under the row its widget reads for that side. Nothing
 * when the last run is not exactly the run of the workflow as it is now.
 */
export function imageCompareFrames(app: AppState, tab: Tab, at: {
  readonly graphId: string
  readonly nodeId: string
  readonly parts: WidgetParts | undefined
}): Readonly<Record<ImageCompareSide, readonly PreviewData[]>> {
  const none = { image_a: [], image_b: [] }
  const execution = app.executionForTab(tab)
  const compiled = app.compileTabCached(tab)
  const backend = app.backendForTab(tab)
  const depth = tab.graphStack.get().lastIndexOf(at.graphId)
  const navigation = viewInstancePath(tab)
  if (!execution?.artifact || !compiled?.ok || !navigation || depth < 0
    || execution.ref.connection !== backend.id || compiled.artifact.connection !== backend.id
    || execution.artifact.snapshot.lineage !== tab.store.doc.lineage) return none
  const ids = occurrencesForView({ instancePath: navigation.slice(0, depth),
    runtimeIds: new Set([...Object.keys(execution.nodes), ...Object.keys(execution.previews)]),
    toSource: execution.artifact.provenance.toSource }).own.get(at.nodeId) ?? []
  const runtimeId = ids.length === 1 ? ids[0] : undefined
  if (!runtimeId || liveExactnessFor(compiled.artifact, execution.artifact)?.(runtimeId) !== true) return none
  const framesOf = (side: ImageCompareSide): readonly PreviewData[] => {
    const parts = at.parts
    const row = parts === undefined ? undefined
      : Object.hasOwn(parts.writes, side) ? parts.writes[side] : Object.hasOwn(parts.reads, side) ? parts.reads[side] : undefined
    if (row === undefined) return []
    const ring = execution.previewRings?.[runtimeId]?.[row]
    const still = execution.previews[runtimeId]?.[row]
    return ring ? Object.entries(ring.frames).sort(([a], [b]) => Number(a) - Number(b)).map(([, frame]) => frame)
      : still ? [still] : []
  }
  return { image_a: framesOf('image_a'), image_b: framesOf('image_b') }
}

/** A streamed preview as a picture, when it is one of a readable size; the caller closes it. */
export async function frameBitmap(frame: PreviewData): Promise<ImageBitmap | undefined> {
  if (!(frame.payload instanceof Blob || frame.payload instanceof ArrayBuffer)) return undefined
  const blob = frame.payload instanceof Blob ? frame.payload : new Blob([frame.payload])
  if (blob.size > 64 * 1024 * 1024) return undefined
  const image = await createImageBitmap(blob).catch(() => undefined)
  if (image === undefined) return undefined
  if (image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096) { image.close(); return undefined }
  return image
}

/**
 * Draws image B whole and image A over it up to the divider, at `split`
 * percent of the width, each fitted inside the canvas; one image alone fills
 * it with no divider.
 */
export function drawImageCompare(canvas: HTMLCanvasElement, images: Partial<Record<ImageCompareSide, ImageBitmap>>, split: number, divider: { readonly color: string; readonly width: number }): void {
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  const draw = (image: ImageBitmap): void => {
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
    const width = image.width * scale; const height = image.height * scale
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
  }
  if (images.image_b) draw(images.image_b)
  if (images.image_a) {
    context.save()
    if (images.image_b) { context.beginPath(); context.rect(0, 0, canvas.width * split / canvasPaintTokens.editor.imageCompare.percentScale, canvas.height); context.clip() }
    draw(images.image_a)
    context.restore()
  }
  if (images.image_a && images.image_b) {
    context.fillStyle = divider.color
    context.fillRect(canvas.width * split / canvasPaintTokens.editor.imageCompare.percentScale - divider.width / 2, 0, divider.width, canvas.height)
  }
}
