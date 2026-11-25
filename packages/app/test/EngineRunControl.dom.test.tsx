import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupervisorStatus } from '@dinkster/client'
import { EngineRunControl } from '../src/EngineRunControl.js'

let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  unmount = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function mount(initial: SupervisorStatus, onRestart: () => Promise<void> = async () => undefined) {
  const [status, setStatus] = createSignal(initial)
  const root = document.createElement('div')
  document.body.append(root)
  unmount = render(() => <EngineRunControl status={status()} baseUrl="http://engine.test" onRestart={onRestart} />, root)
  const button = (label: string) => [...root.querySelectorAll('button')].find((item) => item.textContent === label)!
  return { root, setStatus, button }
}

describe('EngineRunControl', () => {
  it('tracks stopped, starting, failed and ready without retaining the failure reason', () => {
    const { root, setStatus, button } = mount({ protocol: 1, state: 'stopped' })
    expect(button('Start engine').disabled).toBe(false)
    setStatus({ protocol: 1, state: 'starting', progress: { done: 3, total: 8 } })
    expect(root.textContent).toContain('Starting engine38%')
    expect(root.querySelector('button')).toBeNull()
    setStatus({ protocol: 1, state: 'starting' })
    expect(root.textContent).toContain('Starting engine0%')
    setStatus({ protocol: 1, state: 'failed', detail: 'Engine exited with code 7' })
    button('Engine failed').click()
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain('Engine exited with code 7')
    setStatus({ protocol: 1, state: 'ready' })
    expect(root.textContent).toBe('')
    setStatus({ protocol: 1, state: 'failed' })
    expect(root.querySelector('[role="dialog"]')).toBeNull()
  })

  it('starts from stopped and both failed actions, refusing duplicate pending starts', async () => {
    let starts = 0
    let resolve!: () => void
    const { setStatus, button } = mount({ protocol: 1, state: 'stopped' }, () => {
      starts++
      return new Promise<void>((done) => { resolve = done })
    })
    button('Start engine').click()
    button('Start engine').click()
    expect(starts).toBe(1)
    resolve()
    await Promise.resolve()
    setStatus({ protocol: 1, state: 'failed' })
    button('Restart').click()
    expect(starts).toBe(2)
    resolve()
    await Promise.resolve()
    button('Engine failed').click()
    button('Restart engine').click()
    expect(starts).toBe(3)
    resolve()
    await Promise.resolve()
  })

  it('closes the reason on a second click, outside pointer and Escape, returning keyboard focus', async () => {
    const { root, button } = mount({ protocol: 1, state: 'failed', detail: 'Failed to load the engine' })
    button('Engine failed').click()
    await Promise.resolve()
    expect(document.activeElement).toBe(button('Restart engine'))
    button('Engine failed').click()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    button('Engine failed').click()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    button('Engine failed').click()
    await Promise.resolve()
    button('Restart engine').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button('Engine failed'))
  })

  it.each([
    [{ available: true, text: 'actual engine stderr\nTraceback: broken pack', truncated: true }, 'actual engine stderr'],
    [{ available: false, text: '', truncated: false }, 'This engine has not written a log yet.'],
    [{ available: true, text: '', truncated: false }, 'The engine log is empty'],
  ])('shows the engine log response, including missing and empty logs: %j', async (body, expected) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }))
    const { button } = mount({ protocol: 1, state: 'failed', detail: 'Not the engine log' })
    button('Engine failed').click()
    button('Show log').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain(expected))
    expect(document.body.textContent).not.toContain('Not the engine log')
    expect(document.body.textContent?.match(/Engine log/g)).toHaveLength(1)
    if (body.truncated) expect(document.body.textContent).toContain('64 KiB')
  })

  it('shows a refused log request as unavailable instead of substituting status text', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }))
    const { button } = mount({ protocol: 1, state: 'failed', detail: 'Not the engine log' })
    button('Engine failed').click()
    button('Show log').click()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('The engine log could not be read.'))
    expect(document.body.textContent).not.toContain('Not the engine log')
  })
})
