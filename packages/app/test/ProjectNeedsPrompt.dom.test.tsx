import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectNeedsPrompt } from '../src/ProjectNeedsPrompt.js'
import type { AppState, ProjectNeedsReview } from '../src/app-state.js'

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  delete window.dinksterDesktop
  window.history.replaceState(null, '', '/')
  document.body.replaceChildren()
})

it.each(['native', 'browser', 'remote', 'other-project'] as const)('keeps %s installation scope explicit and discards a changed review', async (mode) => {
  window.history.replaceState(null, '', '/?dinksterProject=studio')
  if (mode !== 'browser') Object.assign(window, { dinksterDesktop: { locale: async () => 'en', status: async () => ({ phase: 'running' }) } })
  const review = {
    project: { id: mode === 'other-project' ? 'other' : 'studio', name: 'Studio' },
    backend: { baseUrl: mode === 'remote' ? 'https://engine.example' : '' },
    changes: [{ pack: 'image-tools', version: '1.2.0' }], enable: [], errors: [],
  } as unknown as ProjectNeedsReview
  const prepare = vi.fn(async (_review, _signal, _progress, scope) => ({
    installation: { review: 'Retained software review', expiresInSeconds: 900 },
    expiresAt: performance.now() + 900_000, affectedProjects: [], scope,
  }))
  const app = { reviewProjectPackInstallation: prepare } as unknown as AppState
  const root = document.createElement('div')
  document.body.append(root)
  dispose = render(() => <ProjectNeedsPrompt app={app} review={review} />, root)
  const button = () => [...root.querySelectorAll('button')].find((item) => item.textContent === 'Review installation')!
  const select = root.querySelector<HTMLButtonElement>('[role="combobox"]')
  if (mode === 'native') {
    expect(button().disabled).toBe(true)
    expect(select?.textContent).toContain('Choose affected projects')
    select!.click()
    document.querySelector<HTMLElement>('[data-option-id="only-project"]')!.click()
    expect(button().disabled).toBe(false)
    button().click()
    await vi.waitFor(() => expect(root.textContent).toContain('Retained software review'))
    expect(prepare.mock.calls[0]?.[3]).toBe('only-project')
    select!.click()
    document.querySelector<HTMLElement>('[data-option-id="every-project"]')!.click()
    expect(root.textContent).not.toContain('Retained software review')
    button().click()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    expect(prepare.mock.calls[1]?.[3]).toBe('every-project')
  } else {
    expect(select).toBeNull()
    expect(button().disabled).toBe(false)
    button().click()
    await vi.waitFor(() => expect(root.textContent).toContain('Retained software review'))
    expect(prepare.mock.calls[0]?.[3]).toBeUndefined()
  }
})
