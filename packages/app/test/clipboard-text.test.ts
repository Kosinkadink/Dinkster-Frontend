import { describe, expect, it, vi } from 'vitest'
import { waitForClipboardTextWrite, writeClipboardText } from '../src/clipboard-text.js'

describe('clipboard text writes', () => {
  it('finishes the latest internal copy before a following paste reads the clipboard', async () => {
    let releaseWrite: (() => void) | undefined
    let clipboard = 'stale clipboard'
    const writeText = vi.fn(async (text: string) => {
      await new Promise<void>((resolve) => { releaseWrite = resolve })
      clipboard = text
    })
    const readText = vi.fn(() => clipboard)

    const write = writeClipboardText(writeText, 'current copy')
    const read = waitForClipboardTextWrite().then(readText)

    await Promise.resolve()
    expect(readText).not.toHaveBeenCalled()
    releaseWrite?.()
    await expect(read).resolves.toBe('current copy')
    await write
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
    releases.shift()?.()
    await first
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledTimes(2)
    releases.shift()?.()
    await second
    expect(written).toEqual(['first', 'second'])
  })
})
