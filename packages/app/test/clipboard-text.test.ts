import { describe, expect, it, vi } from 'vitest'
import { pendingClipboardText, writeClipboardText } from '../src/clipboard-text.js'

describe('clipboard text writes', () => {
  it('exposes the latest internal copy without waiting for the system clipboard write', async () => {
    let releaseWrite: (() => void) | undefined
    const writeText = vi.fn(async (text: string) => {
      await new Promise<void>((resolve) => { releaseWrite = resolve })
      expect(text).toBe('current copy')
    })

    const write = writeClipboardText(writeText, 'current copy')

    await Promise.resolve()
    expect(pendingClipboardText()).toBe('current copy')
    releaseWrite?.()
    await write
    expect(pendingClipboardText()).toBeUndefined()
  })

  it('serializes overlapping copies in invocation order', async () => {
    const releases: Array<() => void> = []
    const written: string[] = []
    const writeText = vi.fn(async (text: string) => {
      await new Promise<void>((resolve) => { releases.push(resolve) })
      written.push(text)
    })

    const first = writeClipboardText(writeText, 'first')
    const second = writeClipboardText(writeText, 'second')
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(pendingClipboardText()).toBe('second')
    releases.shift()?.()
    await first
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(pendingClipboardText()).toBe('second')
    releases.shift()?.()
    await second
    expect(written).toEqual(['first', 'second'])
    expect(pendingClipboardText()).toBeUndefined()
  })
})
