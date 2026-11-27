import { expect, test } from 'vitest'
import { formatByteProgress, formatByteSize } from '../src/index.js'

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

test('byte progress keeps both numbers in the total unit and writes the suffix once', () => {
  for (const [received, total, expected] of [
    [10 * 1073741824, 25555055411, { received: '10', total: '23.8 GB' }],
    [1536, 1048576, { received: '0', total: '1 MB' }],
    [1572864, 1572864, { received: '1.5', total: '1.5 MB' }],
    [1023, 1023, { received: '1023', total: '1023 B' }],
    [1023, 1024, { received: '1', total: '1 KB' }],
    [1048575, 1048575, { received: '1024', total: '1024 KB' }],
    [1048575, 1048576, { received: '1', total: '1 MB' }],
    [1073741823, 1073741824, { received: '1', total: '1 GB' }],
    [1099511627775, 1099511627776, { received: '1', total: '1 TB' }],
    [0, 0, { received: '0', total: '0 B' }],
    [12646, 20480, { received: '12.3', total: '20 KB' }],
    [12647, 20480, { received: '12.4', total: '20 KB' }],
  ] as const) {
    expect(formatByteProgress(received, total)).toEqual(expected)
  }
})
