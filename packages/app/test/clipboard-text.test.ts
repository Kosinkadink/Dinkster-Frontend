import { describe, expect, it, vi } from 'vitest'
import { pendingClipboardText, writeClipboardText } from '../src/clipboard-text.js'

describe('clipboard text writes', () => {
  it.each([true, false])('keeps internal paste immediate but waits for ownership before system write: %s', async (accepted) => {
    let acknowledge!: (accepted: boolean) => void
    const ownership = new Promise<boolean>((resolve) => { acknowledge = resolve })
    const written: string[] = []
    const write = writeClipboardText(async (text) => { written.push(text) }, 'protected copy', ownership)
    expect(pendingClipboardText()).toBe('protected copy')
    await Promise.resolve()
    expect(written).toEqual([])
    acknowledge(accepted)
    await write
    expect(written).toEqual(accepted ? ['protected copy'] : [])
    expect(pendingClipboardText()).toBeUndefined()
  })

  it('does not reorder copies when their ownership acknowledgments arrive in reverse order', async () => {
    let acknowledge!: (accepted: boolean) => void
    const firstOwner = new Promise<boolean>((resolve) => { acknowledge = resolve })
    const written: string[] = []
    const write = async (text: string) => { written.push(text) }
    const first = writeClipboardText(write, 'first', firstOwner)
    const second = writeClipboardText(write, 'second', Promise.resolve(true))
    expect(pendingClipboardText()).toBe('second')
    await Promise.resolve()
    expect(written).toEqual([])
    acknowledge(true)
    await Promise.all([first, second])
    expect(written).toEqual(['first', 'second'])
  })

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
