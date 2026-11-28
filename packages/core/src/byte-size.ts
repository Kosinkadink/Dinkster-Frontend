const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const

const byteUnit = (bytes: number): number => {
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit
}

const formatByteValue = (value: number, editable = false): string =>
  String(Number(value.toFixed(editable || Math.abs(value) < 100 ? 1 : 0)))

/** Base-1024 sizes; fixed units retain one decimal for editable fields. */
export function formatByteSize(
  bytes: number,
  fixedUnit?: (typeof units)[number],
): string {
  const unit =
    fixedUnit === undefined ? byteUnit(bytes) : units.indexOf(fixedUnit)
  return `${bytes < 0 ? '-' : ''}${formatByteValue(Math.abs(bytes) / 1024 ** unit, fixedUnit !== undefined)} ${units[unit]}`
}

/** Bare values are GB; fractional sizes round to the nearest whole byte. */
export function parseByteSize(text: string): number | undefined {
  const match = /^(\d+(?:\.\d*)?|\.\d+)\s*(B|KB|MB|GB|TB)?$/iu.exec(text.trim())
  if (!match) return undefined
  const unit = units.indexOf(
    (match[2]?.toUpperCase() ?? 'GB') as (typeof units)[number],
  )
  const bytes = Math.round(Number(match[1]) * 1024 ** unit)
  return Number.isSafeInteger(bytes) ? bytes : undefined
}

/** The total chooses the unit for both values; callers localize the join. */
export function formatByteProgress(
  received: number,
  total: number,
): { readonly received: string; readonly total: string } {
  return {
    received: formatByteValue(received / 1024 ** byteUnit(total)),
    total: formatByteSize(total),
  }
}
