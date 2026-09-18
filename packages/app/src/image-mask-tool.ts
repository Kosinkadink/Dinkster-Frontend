export interface ImageEditPoint {
  readonly x: number
  readonly y: number
  readonly time: number
  readonly pressure: number
  readonly tiltX: number
  readonly tiltY: number
  readonly twist: number
}

export type MaskEditOperation =
  | {
      readonly kind: 'mask.stroke'
      readonly mode: 'paint' | 'erase'
      readonly size: number
      readonly hardness: number
      readonly points: readonly ImageEditPoint[]
    }
  | { readonly kind: 'mask.clear' }
  | { readonly kind: 'mask.invert' }

export function maskFromRgba(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(rgba.length / 4)
  for (let pixel = 0; pixel < mask.length; pixel += 1) mask[pixel] = 255 - rgba[pixel * 4 + 3]!
  return mask
}

export function applyMaskToRgba(source: Uint8ClampedArray, mask: Uint8ClampedArray): Uint8ClampedArray {
  if (source.length !== mask.length * 4) throw new Error('mask dimensions do not match source image')
  const rgba = new Uint8ClampedArray(source)
  for (let pixel = 0; pixel < mask.length; pixel += 1) rgba[pixel * 4 + 3] = 255 - mask[pixel]!
  return rgba
}

function paintMask(mask: Uint8ClampedArray, width: number, height: number, operation: Extract<MaskEditOperation, { kind: 'mask.stroke' }>): void {
  for (const point of operation.points) {
    const pressure = Math.max(0, Math.min(1, point.pressure))
    if (pressure === 0) continue
    const radius = Math.max(0.5, operation.size * (0.25 + pressure * 0.75) / 2)
    const inner = radius * Math.max(0, Math.min(1, operation.hardness))
    const left = Math.max(0, Math.floor(point.x - radius))
    const right = Math.min(width - 1, Math.ceil(point.x + radius))
    const top = Math.max(0, Math.floor(point.y - radius))
    const bottom = Math.min(height - 1, Math.ceil(point.y + radius))
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const distance = Math.hypot(x + 0.5 - point.x, y + 0.5 - point.y)
        if (distance > radius) continue
        const edgeStrength = distance <= inner || inner === radius ? 1 : 1 - ((distance - inner) / (radius - inner))
        const strength = edgeStrength * pressure
        const index = y * width + x
        const target = operation.mode === 'erase' ? 0 : 255
        mask[index] = Math.round(mask[index]! + (target - mask[index]!) * strength)
      }
    }
  }
}

export function projectMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  operations: readonly MaskEditOperation[],
): Uint8ClampedArray {
  let mask = maskFromRgba(rgba)
  for (const operation of operations) {
    if (operation.kind === 'mask.clear') {
      mask = new Uint8ClampedArray(mask.length)
    } else if (operation.kind === 'mask.invert') {
      mask = Uint8ClampedArray.from(mask, (value) => 255 - value)
    } else {
      paintMask(mask, width, height, operation)
    }
  }
  return mask
}
