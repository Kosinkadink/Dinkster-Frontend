/** Base-1024 byte counts with the product's familiar unit names. */
export function formatByteSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${bytes < 0 ? '-' : ''}${Number(value.toFixed(1))} ${units[unit]}`
}
