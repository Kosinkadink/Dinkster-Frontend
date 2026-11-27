const units = ['B', 'KB', 'MB', 'GB', 'TB']

const byteUnit = (bytes: number): number => {
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit
}

/** Base-1024 byte counts with the product's familiar unit names. */
export function formatByteSize(bytes: number): string {
  const unit = byteUnit(bytes)
  return `${bytes < 0 ? '-' : ''}${Number((Math.abs(bytes) / 1024 ** unit).toFixed(1))} ${units[unit]}`
}

/** The total chooses the unit for both values; callers localize the join. */
export function formatByteProgress(
  received: number,
  total: number,
): { readonly received: string; readonly total: string } {
  return {
    received: String(Number((received / 1024 ** byteUnit(total)).toFixed(1))),
    total: formatByteSize(total),
  }
}
