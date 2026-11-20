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
  if (mode !== 'browser') Object.assign(window, { dinksterDesktop: { fileCapabilities: async () => ({ nativeFolderChoice: true, reveal: true }) } })
  const review = {
    project: { id: mode === 'other-project' ? 'other' : 'studio', name: 'Studio' },
    backend: { baseUrl: mode === 'remote' ? 'https://engine.example' : '' },
    changes: [{ pack: 'image-tools', version: '1.2.0' }], enable: ['color-grade'], errors: [], needs: { installed: [{ pack: 'color-grade', version: '1.0' }] },
  } as unknown as ProjectNeedsReview
  const prepare = vi.fn(async (_review, _signal, _progress, scope) => ({
    installation: { review: 'Retained software review', expiresInSeconds: 900, ...(mode === 'native' ? { confirmation: 'opaque' } : { commands: ['review only'] }) },
    expiresAt: performance.now() + 900_000, affectedProjects: [{ name: 'Other project' }], scope,
  }))
  let finishApply!: () => void
  const applied = new Promise<void>((resolve) => { finishApply = resolve })
  let installations = 0
  const app = { reviewProjectPackInstallation: prepare, applyReviewedProjectPacks: async () => {
    installations++
    await applied
    app.projectPackInstallations.set(review.backend, 'uncertain')
    throw new Error('Installation outcome unknown')
  }, projectPackInstallations: new Map(), projectNeedsReview: { get: () => review } } as unknown as AppState
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
    expect(root.textContent).toContain('Other projects stay on their current environment.')
    expect([...root.querySelectorAll('li')].map((item) => item.textContent)).not.toContain('Other project')
    select!.click()
    document.querySelector<HTMLElement>('[data-option-id="every-project"]')!.click()
    expect(root.textContent).not.toContain('Retained software review')
    button().click()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    expect(prepare.mock.calls[1]?.[3]).toBe('every-project')
    await vi.waitFor(() => expect(root.textContent).toContain('This plan changes packs used by these other projects'))
    expect([...root.querySelectorAll('li')].map((item) => item.textContent)).toContain('Other project')
    const confirm = [...root.querySelectorAll('button')].find((item) => item.textContent === 'Confirm installation')!
    confirm.click()
    confirm.click()
    expect(installations).toBe(1)
    expect(confirm.disabled).toBe(true)
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Waiting for the backend...')
    expect(root.textContent).toContain('Retained software review')
    expect(button()).toBeUndefined()
    expect(root.textContent).not.toContain('Enable packs in this project')
    expect(root.querySelector('[data-modal="project-needs"] [data-testid="modal-close"]')?.hasAttribute('disabled')).toBe(true)
    finishApply()
    await vi.waitFor(() => expect(root.textContent).toContain('Installation outcome unknown'))
    expect(button().disabled).toBe(true)
    dispose()
    dispose = render(() => <ProjectNeedsPrompt app={app} review={review} />, root)
    expect(root.textContent).toContain('Do not install again')
    expect([...root.querySelectorAll('button')].find((item) => item.textContent === 'Enable packs in this project')?.disabled).toBe(true)
    expect(button().disabled).toBe(true)
    expect(installations).toBe(1)
  } else {
    expect(select).toBeNull()
    expect(button().disabled).toBe(false)
    button().click()
    await vi.waitFor(() => expect(root.textContent).toContain('Retained software review'))
    expect(prepare.mock.calls[0]?.[3]).toBeUndefined()
    expect(root.textContent).not.toContain('Confirm installation')
    expect(installations).toBe(0)
  }
})
