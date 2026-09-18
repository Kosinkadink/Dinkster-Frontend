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
const webmResult = () => ({ bytes: webmBytes(), mime: 'video/webm' })

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

describe('validateBrowserMediaRendition deadline', () => {
  it('resolves false immediately when the shared deadline has already passed', async () => {
    const result = validateBrowserMediaRendition(webmResult(), Date.now() - 1)
    await expect(result).resolves.toBe(false)
  })

  it('a later call sharing a deadline waits only the remaining time, not a fresh budget', async () => {
    const deadline = Date.now() + MEDIA_VALIDATION_BUDGET_MS
    let firstSettled = false
    let secondSettled = false
    const first = validateBrowserMediaRendition(webmResult(), deadline)
    void first.then(() => { firstSettled = true })
    await vi.advanceTimersByTimeAsync(MEDIA_VALIDATION_BUDGET_MS - 4_000)
    expect(firstSettled).toBe(false)
    const second = validateBrowserMediaRendition(webmResult(), deadline)
    void second.then(() => { secondSettled = true })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(firstSettled).toBe(true)
    expect(secondSettled).toBe(true)
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
  })

  it('non-AV mimes resolve true without consuming the deadline', async () => {
    await expect(validateBrowserMediaRendition({ bytes: new Uint8Array([1]).buffer, mime: 'image/png' }, Date.now() - 1))
      .resolves.toBe(true)
  })
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
