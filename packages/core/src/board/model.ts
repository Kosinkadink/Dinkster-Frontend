/**
 * The Board document: a free surface where pictures, video, sound, notes and
 * named sections are laid out. It is a document kind of its own, saved
 * beside workflows, and holds media only as asset-digest references.
 *
 * Coordinates are world units with no grid. Items are keyed by id; `order`
 * is paint order, last on top. Sections are painted under every other item
 * whatever their place in `order`, so a section never hides what it holds.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json, JsonObject } from '../format/document.js'
import { ownJson } from '../format/json.js'

export const BOARD_FORMAT = 'dinkster-board'
export const BOARD_FORMAT_VERSION = 1
/** Media type of a saved board's bytes; the engine records it verbatim. */
export const BOARD_MEDIA_TYPE = 'application/x-dinkster-board+json'

export const BOARD_MAX_ITEMS = 2000
export const BOARD_MAX_TEXT = 10_000
export const BOARD_MAX_NAME = 200
/** Largest absolute coordinate and largest side, in world units. */
export const BOARD_MAX_EXTENT = 1_000_000
export const BOARD_MIN_SIDE = 16

export type BoardMediaKind = 'picture' | 'video' | 'sound'
export type BoardItemKind = BoardMediaKind | 'note' | 'section'

export interface BoardRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The asset a media item shows. Facts about the bytes, kept when known. */
export interface BoardAsset {
  /** blake3:<64 hex>; the bytes live at /api/assets/{digest}. */
  readonly digest: string
  readonly mediaType: string
  readonly name: string
  /** Natural size of a picture or video frame, in pixels. */
  readonly width?: number
  readonly height?: number
  /** Length of a video or sound, in seconds. */
  readonly duration?: number
  /** Where the asset came from, as the engine recorded it (upload, produced, ...). */
  readonly origin?: Readonly<Record<string, string>>
}

export interface BoardMediaItem {
  readonly id: string
  readonly kind: BoardMediaKind
  readonly rect: BoardRect
  readonly asset: BoardAsset
}

export interface BoardNoteItem {
  readonly id: string
  readonly kind: 'note'
  readonly rect: BoardRect
  readonly text: string
}

export interface BoardSectionItem {
  readonly id: string
  readonly kind: 'section'
  readonly rect: BoardRect
  readonly name: string
}

export type BoardItem = BoardMediaItem | BoardNoteItem | BoardSectionItem

export interface BoardDocument {
  readonly format: typeof BOARD_FORMAT
  readonly formatVersion: typeof BOARD_FORMAT_VERSION
  readonly items: Readonly<Record<string, BoardItem>>
  readonly order: readonly string[]
}

export const emptyBoard = (): BoardDocument =>
  Object.freeze({ format: BOARD_FORMAT, formatVersion: BOARD_FORMAT_VERSION, items: Object.freeze({}), order: Object.freeze([]) })

export const isBoardMediaKind = (kind: string): kind is BoardMediaKind =>
  kind === 'picture' || kind === 'video' || kind === 'sound'

/** The media kind a media type is shown as, or undefined when a board cannot show it. */
export function boardMediaKindOf(mediaType: string): BoardMediaKind | undefined {
  const base = mediaType.split(';')[0]!.trim().toLowerCase()
  if (base.startsWith('image/')) return 'picture'
  if (base.startsWith('video/')) return 'video'
  if (base.startsWith('audio/')) return 'sound'
  return undefined
}

/** Items in the order they are painted: sections first, then the rest, each in document order. */
export function boardPaintOrder(board: BoardDocument): readonly BoardItem[] {
  const items = board.order.map((id) => board.items[id]!)
  return [...items.filter((item) => item.kind === 'section'), ...items.filter((item) => item.kind !== 'section')]
}

/** Whether `inner` lies wholly inside `outer`. */
export const rectContains = (outer: BoardRect, inner: BoardRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height

/** The items a section holds: every other item wholly inside it, sections included. */
export function sectionMembers(board: BoardDocument, sectionId: string): readonly string[] {
  const section = board.items[sectionId]
  if (section === undefined || section.kind !== 'section') return []
  return board.order.filter((id) => id !== sectionId && rectContains(section.rect, board.items[id]!.rect))
}

const ITEM_ID = /^[a-z][a-z0-9-]{0,63}$/
const DIGEST = /^blake3:[0-9a-f]{64}$/

const fail = (code: string, message: string): Diagnostic => diag('error', 'import', `board.${code}`, message)

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: Json | undefined, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max

function readRect(value: Json | undefined, where: string): BoardRect | Diagnostic {
  if (!isObject(value)) return fail('rect.invalid', `${where}: rect must be an object`)
  const { x, y, width, height } = value
  if (!finite(x, BOARD_MAX_EXTENT) || !finite(y, BOARD_MAX_EXTENT)) return fail('rect.invalid', `${where}: x and y must be finite numbers within ${BOARD_MAX_EXTENT}`)
  if (!finite(width, BOARD_MAX_EXTENT) || !finite(height, BOARD_MAX_EXTENT) || width < BOARD_MIN_SIDE || height < BOARD_MIN_SIDE) {
    return fail('rect.invalid', `${where}: width and height must be between ${BOARD_MIN_SIDE} and ${BOARD_MAX_EXTENT}`)
  }
  return { x, y, width, height }
}

const text = (value: Json | undefined, max: number): value is string => typeof value === 'string' && value.length <= max

function readAsset(value: Json | undefined, where: string): BoardAsset | Diagnostic {
  if (!isObject(value)) return fail('asset.invalid', `${where}: asset must be an object`)
  const { digest, mediaType, name, width, height, duration, origin } = value
  if (typeof digest !== 'string' || !DIGEST.test(digest)) return fail('asset.invalid', `${where}: asset digest must be 'blake3:<64 hex>'`)
  if (!text(mediaType, BOARD_MAX_NAME) || mediaType.length === 0) return fail('asset.invalid', `${where}: asset mediaType must be a nonempty string`)
  if (!text(name, BOARD_MAX_NAME)) return fail('asset.invalid', `${where}: asset name must be a string of at most ${BOARD_MAX_NAME} characters`)
  for (const [key, size] of [['width', width], ['height', height]] as const) {
    if (size !== undefined && (!Number.isSafeInteger(size) || (size as number) < 1)) return fail('asset.invalid', `${where}: asset ${key} must be a positive integer`)
  }
  if (duration !== undefined && (!finite(duration, Number.MAX_SAFE_INTEGER) || duration < 0)) return fail('asset.invalid', `${where}: asset duration must be a nonnegative number`)
  if (origin !== undefined && (!isObject(origin) || !Object.values(origin).every((field) => text(field, 2048)))) {
    return fail('asset.invalid', `${where}: asset origin must be an object of strings`)
  }
  return {
    digest, mediaType, name,
    ...(width !== undefined ? { width: width as number } : {}),
    ...(height !== undefined ? { height: height as number } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(origin !== undefined ? { origin: origin as Record<string, string> } : {}),
  }
}

/** Validate one item against its own id; a Diagnostic when it is malformed. */
export function readBoardItem(id: string, value: Json | undefined): BoardItem | Diagnostic {
  const where = `item '${id}'`
  if (!ITEM_ID.test(id)) return fail('item.id', `${where}: ids are lowercase letters, digits and '-', starting with a letter`)
  if (!isObject(value)) return fail('item.invalid', `${where} must be an object`)
  if (value['id'] !== id) return fail('item.id', `${where}: its id field must equal its key`)
  const kind = value['kind']
  const rect = readRect(value['rect'], where)
  if ('severity' in rect) return rect
  if (typeof kind === 'string' && isBoardMediaKind(kind)) {
    const asset = readAsset(value['asset'], where)
    if ('severity' in asset) return asset
    return { id, kind, rect, asset }
  }
  if (kind === 'note') {
    const note = value['text']
    if (!text(note, BOARD_MAX_TEXT)) return fail('item.invalid', `${where}: note text must be a string of at most ${BOARD_MAX_TEXT} characters`)
    return { id, kind, rect, text: note }
  }
  if (kind === 'section') {
    const name = value['name']
    if (!text(name, BOARD_MAX_NAME)) return fail('item.invalid', `${where}: section name must be a string of at most ${BOARD_MAX_NAME} characters`)
    return { id, kind, rect, name }
  }
  return fail('item.kind', `${where}: unknown kind ${JSON.stringify(kind)}`)
}

export interface BoardLoadResult {
  readonly document?: BoardDocument
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Validate untrusted JSON as a Board document. Strict: an unknown kind, a
 * malformed item or an order that does not list each item exactly once
 * refuses the whole board rather than dropping part of it.
 */
export function loadBoard(input: unknown): BoardLoadResult {
  const owned = ownJson(input, { undefinedProps: 'reject' })
  if (!owned.ok) return { diagnostics: [fail('json.invalid', `board is not JSON: ${owned.reason}`)] }
  const raw = owned.value
  if (!isObject(raw)) return { diagnostics: [fail('shape.invalid', 'board must be an object')] }
  if (raw['format'] !== BOARD_FORMAT) return { diagnostics: [fail('format.invalid', `format must be '${BOARD_FORMAT}'`)] }
  const version = raw['formatVersion']
  if (version !== BOARD_FORMAT_VERSION) {
    return {
      diagnostics: [fail(typeof version === 'number' && version > BOARD_FORMAT_VERSION ? 'version.future' : 'version.invalid',
        `board formatVersion ${JSON.stringify(version)} is not supported (expected ${BOARD_FORMAT_VERSION})`)],
    }
  }
  const items = raw['items']
  const order = raw['order']
  if (!isObject(items) || !Array.isArray(order)) return { diagnostics: [fail('shape.invalid', 'board needs an items object and an order list')] }
  const ids = Object.keys(items)
  if (ids.length > BOARD_MAX_ITEMS) return { diagnostics: [fail('items.tooMany', `a board holds at most ${BOARD_MAX_ITEMS} items`)] }
  if (order.length !== ids.length || new Set(order).size !== order.length || !order.every((id) => typeof id === 'string' && Object.hasOwn(items, id))) {
    return { diagnostics: [fail('order.invalid', 'order must list every item exactly once')] }
  }
  const parsed: Record<string, BoardItem> = {}
  for (const id of ids) {
    const item = readBoardItem(id, items[id])
    if ('severity' in item) return { diagnostics: [item] }
    parsed[id] = item
  }
  const document: BoardDocument = { format: BOARD_FORMAT, formatVersion: BOARD_FORMAT_VERSION, items: parsed, order: order as string[] }
  const frozen = ownJson(document)
  if (!frozen.ok) return { diagnostics: [fail('json.invalid', frozen.reason)] }
  return { document: frozen.value as unknown as BoardDocument, diagnostics: [] }
}
