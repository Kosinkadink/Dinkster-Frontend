import type { MemoryGovernorDevice, MemoryStatus } from '@dinkster/client'

export const MEMORY_HISTORY_LIMIT = 1200
export const MEMORY_LIVE_VIEWPORT_LIMIT = 120
export const MEMORY_SAMPLE_INTERVAL_MS = 1000
export const PAGE_PULSE_TICKS = 6

export interface MemorySample {
  readonly timestamp: number
  readonly footprintBytes: number
  readonly reservedBytes: number
  readonly capacityBytes: number
}

export function appendMemorySample(
  samples: readonly MemorySample[],
  sample: MemorySample,
  limit = MEMORY_HISTORY_LIMIT,
): readonly MemorySample[] {
  const previous = samples.at(-1)
  if (previous !== undefined && sample.timestamp - previous.timestamp < MEMORY_SAMPLE_INTERVAL_MS) return samples
  return [...samples.slice(Math.max(0, samples.length - limit + 1)), sample]
}

export function liveMemorySamples(
  samples: readonly MemorySample[],
  limit = MEMORY_LIVE_VIEWPORT_LIMIT,
): readonly MemorySample[] {
  return samples.slice(Math.max(0, samples.length - limit))
}

export interface BarSegment {
  readonly key: string
  readonly label: string
  readonly bytes: number
  readonly fraction: number
  readonly tone: 'footprint' | 'reserved' | 'available' | 'host' | 'other'
}

const segment = (key: string, label: string, bytes: number, total: number, tone: BarSegment['tone']): BarSegment => ({
  key,
  label,
  bytes: Math.max(0, bytes),
  fraction: total > 0 ? Math.max(0, bytes) / total : 0,
  tone,
})

export function deviceBarSegments(device: MemoryGovernorDevice): readonly BarSegment[] {
  if (device.budgetBytes !== null) {
    const budget = Math.max(0, device.budgetBytes)
    const footprint = Math.max(0, device.consumerFootprintBytes)
    const reserved = Math.max(0, device.reservedBytes)
    const available = Math.max(0, device.availableBytes ?? 0)
    const capacity = Math.max(1, budget, footprint + reserved + available)
    return [
      segment('footprint', 'Footprint', footprint, capacity, 'footprint'),
      segment('reserved', 'Reserved', reserved, capacity, 'reserved'),
      segment('available', 'Available', available, capacity, 'available'),
    ]
  }
  if (device.measured !== null) {
    const total = Math.max(0, device.measured.totalBytes)
    const used = Math.max(0, total - device.measured.freeBytes)
    const capacity = Math.max(1, total, used + device.measured.freeBytes)
    return [
      segment('measured-used', 'Measured used', used, capacity, 'footprint'),
      segment('measured-free', 'Measured free', device.measured.freeBytes, capacity, 'available'),
    ]
  }
  return []
}

export function overBudgetBytes(device: MemoryGovernorDevice): number {
  return device.availableBytes === null ? 0 : Math.max(0, -device.availableBytes)
}

const RESIDENCY_TONES: Readonly<Record<string, BarSegment['tone']>> = {
  device: 'footprint',
  vram: 'footprint',
  active: 'reserved',
  pinned: 'host',
  host: 'host',
  ram: 'host',
  unloaded: 'available',
}

export function residencySegments(bytesByResidency: Readonly<Record<string, number>>): readonly BarSegment[] {
  const entries = Object.entries(bytesByResidency).filter(([, bytes]) => Number.isFinite(bytes) && bytes >= 0)
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0)
  return entries.map(([key, bytes]) => segment(key, key, bytes, total, RESIDENCY_TONES[key.toLowerCase()] ?? 'other'))
}

export type PagePulse = 'in' | 'out' | 'none'

export interface HeatmapCell {
  readonly resident: boolean
  readonly pulse: PagePulse
  readonly age: number
}

export function pageIsResident(flag: number): boolean {
  return (flag & 1) !== 0
}

export interface PageFlagRange {
  readonly first: number
  readonly last: number
  readonly flag: number
  readonly resident: boolean
  readonly pulse: PagePulse
}

export function pageFlagRanges(flags: readonly number[], cells?: readonly HeatmapCell[]): readonly PageFlagRange[] {
  const ranges: PageFlagRange[] = []
  flags.forEach((flag, index) => {
    const pulse = cells?.[index]?.pulse ?? 'none'
    const previous = ranges.at(-1)
    if (previous?.flag === flag && previous.pulse === pulse) ranges[ranges.length - 1] = { ...previous, last: index }
    else ranges.push({ first: index, last: index, flag, resident: pageIsResident(flag), pulse })
  })
  return ranges
}

export function diffHeatmapFlags(
  previous: readonly HeatmapCell[] | undefined,
  flags: readonly number[],
  pulseTicks = PAGE_PULSE_TICKS,
): readonly HeatmapCell[] {
  return flags.map((flag, index) => {
    const resident = pageIsResident(flag)
    const prior = previous?.[index]
    if (prior !== undefined && prior.resident !== resident) return { resident, pulse: resident ? 'in' : 'out', age: pulseTicks }
    if (prior !== undefined && prior.age > 1) return { resident, pulse: prior.pulse, age: prior.age - 1 }
    return { resident, pulse: 'none', age: 0 }
  })
}

export function updateHeatmapState(
  previous: Readonly<Record<string, readonly HeatmapCell[]>>,
  details: MemoryStatus['consumerDetails'],
): Readonly<Record<string, readonly HeatmapCell[]>> {
  return Object.fromEntries(Object.entries(details ?? {}).flatMap(([consumer, items]) => items.flatMap((item) => item.pages === undefined ? [] : [
    [memoryDetailKey(consumer, item.itemId), diffHeatmapFlags(previous[memoryDetailKey(consumer, item.itemId)], item.pages.flags)],
  ])))
}

export function memoryDetailKey(consumer: string, item: string): string {
  return JSON.stringify([consumer, item])
}
