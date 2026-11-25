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

/** A color as whole channels from 0 to 255, opacity included. */
export interface RgbaColor {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

/**
 * The CSS named colors (CSS Color 4), without the keywords whose color
 * depends on where they are used (currentColor, transparent, system colors).
 */
const NAMED_COLORS: ReadonlyMap<string, string> = new Map([
  'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc',
  'bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a',
  'burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50',
  'cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b',
  'darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9',
  'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc',
  'darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f',
  'darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff',
  'dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0',
  'forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700',
  'goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0',
  'hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa',
  'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080',
  'lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90',
  'lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa',
  'lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0',
  'lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa',
  'mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371',
  'mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585',
  'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead',
  'navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500',
  'orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093',
  'papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6',
  'purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1',
  'saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee',
  'sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090',
  'snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8',
  'tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5',
  'yellow:ffff00 yellowgreen:9acd32',
].join(' ').split(' ').map((entry) => entry.split(':') as [string, string]))

const channel = (text: string): number | undefined =>
  /^\d{1,3}$/.test(text) && Number(text) <= 255 ? Number(text) : undefined

/** An opacity from 0 to 1 written as a decimal, rounded to the nearest of 256 steps. */
const opacity = (text: string): number | undefined =>
  /^(?:0|1|0?\.\d+|1\.0*|0\.)$/.test(text) && Number(text) <= 1 ? Math.round(Number(text) * 255) : undefined

const hexChannels = (digits: string): RgbaColor => {
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits
  const at = (index: number): number => Number.parseInt(full.slice(index, index + 2), 16)
  return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) : 255 }
}

/** Channels from `r, g, b` or `r, g, b, a`, separated by commas or spaces. */
function listedChannels(list: string, withOpacity: boolean): RgbaColor | undefined {
  const parts = list.trim().split(/\s*,\s*|\s+/)
  if (parts.length !== 3 && !(withOpacity && parts.length === 4)) return undefined
  const [r, g, b] = parts.slice(0, 3).map(channel)
  const a = parts.length === 4 ? opacity(parts[3]!) : 255
  return r === undefined || g === undefined || b === undefined || a === undefined ? undefined : { r, g, b, a }
}

/**
 * Reads typed color text: hex with or without `#` in three, six or eight
 * digits, a CSS named color, `rgb(r, g, b)`, `rgba(r, g, b, a)` or bare
 * `r, g, b`. Channels are whole numbers from 0 to 255 and the opacity of
 * `rgba` a decimal from 0 to 1. Other CSS forms are not colors here.
 */
export function parseColorText(text: string): RgbaColor | undefined {
  const typed = text.trim()
  const hex = /^#?([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(typed)
  if (hex) return hexChannels(hex[1]!)
  const named = NAMED_COLORS.get(typed.toLowerCase())
  if (named !== undefined) return hexChannels(named)
  const call = /^(rgba?)\(([^()]*)\)$/i.exec(typed)
  if (call) return listedChannels(call[2]!, call[1]!.toLowerCase() === 'rgba')
  return /^[\d\s,]+$/.test(typed) ? listedChannels(typed, false) : undefined
}

const pair = (value: number): string => value.toString(16).padStart(2, '0')

/** The stored code: `#rrggbb` when fully opaque, `#rrggbbaa` otherwise. */
export function colorCode(color: RgbaColor): string {
  return `#${pair(color.r)}${pair(color.g)}${pair(color.b)}${color.a === 255 ? '' : pair(color.a)}`
}

/** What leaving a color field with this text would store. */
export type ColorTextResult =
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'color'
      /** The normalized code to store. */
      readonly code: string
      readonly color: RgbaColor
      /** The text had an opacity that a field without opacity does not keep. */
      readonly droppedOpacity: boolean
    }

/**
 * Normalizes typed color text for a field. A field without opacity keeps
 * the color and drops any opacity; that is not an error.
 */
export function resolveColorText(text: string, withOpacity: boolean): ColorTextResult {
  const parsed = parseColorText(text)
  if (parsed === undefined) return { kind: 'invalid' }
  const color = withOpacity ? parsed : { ...parsed, a: 255 }
  return { kind: 'color', code: colorCode(color), color, droppedOpacity: !withOpacity && parsed.a !== 255 }
}

/**
 * The swatches a color field offers: its default first, then the colors
 * already stored in the workflow, most used first, ties in code order, eight
 * in all. `used` holds one entry per stored field; text that is not a color
 * is left out, and codes are compared after normalizing.
 */
export function workflowSwatches(defaultText: string | undefined, used: Iterable<string>, withOpacity: boolean): string[] {
  const normalize = (text: string): string | undefined => {
    const result = resolveColorText(text, withOpacity)
    return result.kind === 'color' ? result.code : undefined
  }
  const first = defaultText === undefined ? undefined : normalize(defaultText)
  const counts = new Map<string, number>()
  for (const text of used) {
    const code = normalize(text)
    if (code !== undefined && code !== first) counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  const ranked = [...counts].sort(([a, ac], [b, bc]) => bc - ac || (a < b ? -1 : a > b ? 1 : 0)).map(([code]) => code)
  return [...(first === undefined ? [] : [first]), ...ranked].slice(0, 8)
}

/** The hue, saturation and value of a picked color, with its opacity from 0 to 255. */
export interface PickedColor extends HsvColor {
  readonly a: number
}

/**
 * The picker's point for a color. A grey, white or black has no hue of its
 * own, so it keeps `hue`, the hue the edit was last at.
 */
export function pickedColor(color: RgbaColor, hue: number): PickedColor {
  const hsv = rgbToHsv(color.r, color.g, color.b)
  return { h: hsv.s === 0 || hsv.v === 0 ? hue : hsv.h, s: hsv.s, v: hsv.v, a: color.a }
}

/** The color at a picker point. */
export function pickedRgba(picked: PickedColor): RgbaColor {
  return { ...hsvToRgb(picked.h, picked.s, picked.v), a: Math.round(clamp(picked.a, 255)) }
}

/** What an open color field's text means: what the live square shows and what leaving stores. */
export interface ColorFieldDraft {
  /** The text is not a color, so leaving keeps the stored color. */
  readonly invalid: boolean
  /** The code leaving the field would store, or the stored code it keeps. */
  readonly enter: string
  /** The text had an opacity that this field does not keep. */
  readonly droppedOpacity: boolean
  /** The color of the live square and the rings: the text's color, or the last valid color of this edit. */
  readonly live: string
}

/**
 * An open color field's draft. `lastValid` is the last color the edit had,
 * held while the text is half typed; `stored` is the field's saved code.
 */
export function colorFieldDraft(text: string, stored: string, lastValid: string, withOpacity: boolean): ColorFieldDraft {
  const result = resolveColorText(text, withOpacity)
  if (result.kind === 'invalid') return { invalid: true, enter: stored, droppedOpacity: false, live: lastValid }
  return { invalid: false, enter: result.code, droppedOpacity: result.droppedOpacity, live: result.code }
}

/**
 * A COLOR field keeps opacity only when it declares it; any other COLOR
 * field is opaque and drops opacity it is given. An integer color has no
 * opacity whatever its options say.
 */
export function colorFieldHasOpacity(options: Readonly<Record<string, unknown>>): boolean {
  return options['alpha'] === true
}
