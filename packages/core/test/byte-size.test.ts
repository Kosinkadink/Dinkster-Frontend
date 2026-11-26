import { expect, test } from 'vitest'
import { formatByteSize } from '../src/index.js'

test('byte sizes use base 1024 and at most one decimal without trailing zeroes', () => {
  for (const [bytes, label] of [
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1025, '1 KB'],
    [1048575, '1024 KB'],
    [1048576, '1 MB'],
    [1048577, '1 MB'],
    [1073741823, '1024 MB'],
    [1073741824, '1 GB'],
    [1073741825, '1 GB'],
    [1099511627775, '1024 GB'],
    [1099511627776, '1 TB'],
    [1099511627777, '1 TB'],
    [1536, '1.5 KB'],
    [12646, '12.3 KB'],
    [12647, '12.4 KB'],
    [2048, '2 KB'],
    [-1536, '-1.5 KB'],
  ] as const) {
    expect(formatByteSize(bytes)).toBe(label)
  }
})
