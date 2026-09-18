// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { setLocale } from '@dinkster/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopSetup } from '../src/DesktopSetup.js'

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
})

describe('desktop setup', () => {
  it('narrates the selected accelerator environment installation', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const [status] = createSignal({ phase: 'installing' as const, detail: 'Installing the locked MPS environment', variant: 'mps' as const })
    const dispose = render(() => (
      <DesktopSetup
        status={status()}
        onRetry={() => undefined}
      />
    ), root)

    const main = root.querySelector('main')
    const card = root.querySelector('.desktop-setup-card')
    const progress = root.querySelector('[role="progressbar"]')
    expect(main?.getAttribute('aria-busy')).toBe('true')
    expect(root.textContent).toContain('Preparing your local studio')
    expect(root.textContent).toContain('Environment: MPS')
    expect(progress?.getAttribute('aria-label')).toBe('Local engine setup')

    setLocale('zh')
    expect(root.textContent).toContain('\u6b63\u5728\u51c6\u5907\u60a8\u7684\u672c\u5730\u5de5\u4f5c\u5ba4')
    expect(root.textContent).toContain('\u73af\u5883\uff1aMPS')
    expect(root.textContent).toContain('Installing the locked MPS environment')
    expect(root.querySelector('main')).toBe(main)
    expect(root.querySelector('.desktop-setup-card')).toBe(card)
    expect(root.querySelector('[role="progressbar"]')).toBe(progress)
    expect(progress?.getAttribute('aria-label')).toBe('\u672c\u5730\u5f15\u64ce\u8bbe\u7f6e')
    dispose()
  })

  it('shows a typed failure and retries on request', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const retry = vi.fn()
    const dispose = render(() => (
      <DesktopSetup
        status={{ phase: 'failed', detail: 'Dinkster could not start', error: 'engine exited with code 3' }}
        onRetry={retry}
      />
    ), root)

    expect(root.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
    expect(root.textContent).toContain('Dinkster needs attention')
    expect(root.textContent).toContain('engine exited with code 3')
    const main = root.querySelector('main')
    const card = root.querySelector('.desktop-setup-card')
    const button = root.querySelector<HTMLButtonElement>('button')!
    button.focus()
    setLocale('zh')
    expect(root.textContent).toContain('Dinkster \u9700\u8981\u5904\u7406\u95ee\u9898')
    expect(root.textContent).toContain('engine exited with code 3')
    expect(root.querySelector('main')).toBe(main)
    expect(root.querySelector('.desktop-setup-card')).toBe(card)
    expect(root.querySelector('button')).toBe(button)
    expect(document.activeElement).toBe(button)
    button.click()
    expect(retry).toHaveBeenCalledOnce()
    dispose()
  })
})
