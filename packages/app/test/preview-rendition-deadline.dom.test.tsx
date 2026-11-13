/**
 * Shared-deadline media rendition validation: candidates that never emit
 * loadedmetadata/error events share ONE validation deadline per candidate
 * sequence, so a preview row's total wait does not scale with candidate
 * count (issue #156).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import type { RenditionInfo, RenditionResult, ValuePeekResult, ValueQuery } from '@dinkster/client'
import { validateBrowserMediaRendition } from '../src/node-previews.js'
import { fetchPeekRendition, MEDIA_VALIDATION_BUDGET_MS, type PeekValues } from '../src/peek-preview.js'

const webmBytes = (): ArrayBuffer => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]).buffer

const hit = (renditions: readonly RenditionInfo[]): ValuePeekResult => ({
  available: true,
  descriptor: { typeId: 'std.video', fingerprint: 'fp' },
  renditions,
})

/** Fake client where every candidate resolves to signature-valid webm bytes. */
const webmValues = (nodes: readonly string[]): PeekValues => {
  const video = { kind: 'preview', mime: 'video/webm', default: true }
  return {
    peek: (q: ValueQuery) => Promise.resolve(nodes.includes(q.nodeId) ? hit([video]) : { available: false, reason: 'unknown-output', status: 404, error: 'unknown-output' }),
    rendition: (q: ValueQuery): Promise<RenditionResult> =>
      Promise.resolve({ available: true, bytes: webmBytes(), mime: 'video/webm', kind: 'preview', fingerprint: q.nodeId }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchPeekRendition validation sequence', () => {
  it('multiple no-event candidates settle within one shared budget, not one per candidate', async () => {
    const values = webmValues(['a', 'b', 'c'])
    let settled = false
    const outcome = fetchPeekRendition(
      values,
      'job',
      [{ node: 'a', output: 'out' }, { node: 'b', output: 'out' }, { node: 'c', output: 'out' }],
      validateBrowserMediaRendition,
    ).then(
      () => { settled = true; return 'resolved' },
      (e: unknown) => { settled = true; return (e as Error).message },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(MEDIA_VALIDATION_BUDGET_MS)
    expect(settled).toBe(true)
    expect(await outcome).toBe('no renderable output')
  })
})
