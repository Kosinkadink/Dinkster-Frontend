export interface EditorWorldRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface EditorViewport {
  readonly x: number
  readonly y: number
  readonly scale: number
}

export const CANVAS_MEDIA_DOM_LIMIT = 24

/** Project once when a popover opens; later canvas movement does not chase it. */
export function editorScreenAnchor(rect: EditorWorldRect, viewport: EditorViewport): EditorWorldRect {
  return {
    x: rect.x * viewport.scale + viewport.x,
    y: rect.y * viewport.scale + viewport.y,
    width: rect.width * viewport.scale,
    height: rect.height * viewport.scale,
  }
}

/** Live world-to-client projection for media inside the clipped canvas stage. */
export function mediaScreenRect(
  node: EditorWorldRect,
  preview: EditorWorldRect,
  viewport: EditorViewport,
  canvas: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): EditorWorldRect | undefined {
  const rect = {
    x: canvas.left + (node.x + preview.x) * viewport.scale + viewport.x,
    y: canvas.top + (node.y + preview.y) * viewport.scale + viewport.y,
    width: preview.width * viewport.scale,
    height: preview.height * viewport.scale,
  }
  if (rect.x + rect.width <= canvas.left || rect.y + rect.height <= canvas.top ||
      rect.x >= canvas.left + canvas.width || rect.y >= canvas.top + canvas.height) return undefined
  return rect
}

/** Keep host-owned media DOM bounded while preserving preferred items. */
export function boundedVisibleOverlayKeys<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  isVisible: (item: T) => boolean,
  preferred: (item: T) => boolean,
  limit = CANVAS_MEDIA_DOM_LIMIT,
): readonly string[] {
  if (limit <= 0) return []
  const byKey = new Map<string, { key: string; preferred: boolean }>()
  for (const item of items) {
    if (!isVisible(item)) continue
    const key = keyOf(item)
    const existing = byKey.get(key)
    if (existing === undefined) byKey.set(key, { key, preferred: preferred(item) })
    else if (!existing.preferred && preferred(item)) existing.preferred = true
  }
  const visible = [...byKey.values()]
  if (visible.length <= limit) return visible.map((item) => item.key)
  const included = new Set(visible.slice(0, limit).map((item) => item.key))
  for (const candidate of visible.slice(limit)) {
    if (!candidate.preferred) continue
    let displaced: string | undefined
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const item = visible[index]!
      if (included.has(item.key) && !item.preferred) {
        displaced = item.key
        break
      }
    }
    if (displaced === undefined) break
    included.delete(displaced)
    included.add(candidate.key)
  }
  return visible.filter((item) => included.has(item.key)).map((item) => item.key)
}

/** Drop focus/play ownership as soon as its source key disappears. */
export function retainActiveOverlayKeys(
  active: ReadonlySet<string>,
  live: ReadonlySet<string>,
): ReadonlySet<string> {
  if ([...active].every((key) => live.has(key))) return active
  return new Set([...active].filter((key) => live.has(key)))
}

function rgbOf(color: string): readonly [number, number, number] | undefined {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1]
  if (hex) return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)]
  const hsl = color.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i)
  if (!hsl) return undefined
  const h = (Number(hsl[1]) % 360) / 360
  const s = Number(hsl[2]) / 100
  const l = Number(hsl[3]) / 100
  const hue = (p: number, q: number, t0: number): number => {
    let t = t0
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255]
}

/** WCAG relative luminance chooses readable black or white pill text. */
export function contrastingTextColor(background: string): '#000000' | '#ffffff' {
  const rgb = rgbOf(background)
  if (!rgb) return '#ffffff'
  const linear = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  return luminance > 0.179 ? '#000000' : '#ffffff'
}
