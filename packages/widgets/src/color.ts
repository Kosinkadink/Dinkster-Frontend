export interface HsvColor {
  readonly h: number
  readonly s: number
  readonly v: number
}

/** Non-finite inputs (e.g. pointer math against a zero-width element)
 * clamp to the range floor: the conversions below must always produce a
 * well-formed color, never propagate NaN into '#NaNNaNNaN' document state. */
const clamp = (n: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0

export function rgbToHsv(r: number, g: number, b: number): HsvColor {
  const rn = clamp(r, 255) / 255
  const gn = clamp(g, 255) / 255
  const bn = clamp(b, 255) / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6
    else if (max === gn) h = (bn - rn) / delta + 2
    else h = (rn - gn) / delta + 4
    h = ((h * 60) + 360) % 360
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const hue = Number.isFinite(h) ? ((h % 360) + 360) % 360 : 0
  const sc = clamp(s, 1)
  const vc = clamp(v, 1)
  const c = vc * sc
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1))
  const m = vc - c
  const [rp, gp, bp] = hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
      : hue < 180 ? [0, c, x]
        : hue < 240 ? [0, x, c]
          : hue < 300 ? [x, 0, c]
            : [c, 0, x]
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  }
}

export function hexToHsv(hex: string): HsvColor | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex)
  if (!match) return undefined
  const rgb = match[1]!.length === 3
    ? [...match[1]!].map((digit) => digit + digit).join('')
    : match[1]!.slice(0, 6)
  return rgbToHsv(Number.parseInt(rgb.slice(0, 2), 16), Number.parseInt(rgb.slice(2, 4), 16), Number.parseInt(rgb.slice(4, 6), 16))
}

export function hsvToHex(h: number, s: number, v: number, previous = ''): string {
  const { r, g, b } = hsvToRgb(h, s, v)
  const rgb = [r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')
  const alpha = /^#[0-9a-f]{8}$/i.test(previous) ? previous.slice(7) : ''
  return `#${rgb}${alpha}`
}
