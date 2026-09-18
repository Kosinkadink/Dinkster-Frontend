// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsDialog } from '../src/ProjectsDialog.js'
import { PROJECTS_KEY } from '../src/projects.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function mount(options: { readonly withOpenWindow?: boolean } = {}) {
  const onSwitch = vi.fn()
  const onOpenWindow = vi.fn()
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => (options.withOpenWindow === true
    ? <ProjectsDialog onSwitch={onSwitch} onOpenWindow={onOpenWindow} />
    : <ProjectsDialog onSwitch={onSwitch} />
  ), root)
  return { root, onSwitch, onOpenWindow, unmount }
}

function rows(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.projects-dialog-row')]
}

function actionButton(row: HTMLElement, label: string): HTMLButtonElement {
  const button = [...row.querySelectorAll('button')].find((b) => b.textContent === label)
  if (button === undefined) throw new Error(`no ${label} button`)
  return button
}

describe('ProjectsDialog', () => {
  beforeEach(() => { localStorage.removeItem(PROJECTS_KEY) })
  afterEach(() => { document.body.innerHTML = '' })

  it('lists the default project as current with switching disabled', () => {
    const { root, unmount } = mount()
    const [defaultRow] = rows(root)
    expect(defaultRow?.textContent).toContain('Default')
    expect(defaultRow?.querySelector('.projects-dialog-current')?.textContent).toBe('Current')
    expect(actionButton(defaultRow!, 'Switch').disabled).toBe(true)
    // Row actions sit in the styled actions cluster and the create action is
    // the footer's primary button; neither relies on native button defaults.
    expect(actionButton(defaultRow!, 'Rename').closest('.projects-dialog-actions')).not.toBeNull()
    expect(root.querySelector('[data-testid="projects-create"]')?.classList.contains('primary')).toBe(true)
    unmount()
  })

  it('creates a project from the draft name and switches to it', async () => {
    const { root, onSwitch, unmount } = mount()
    const draft = root.querySelector<HTMLInputElement>('input[aria-label="New project name"]')!
    const create = root.querySelector<HTMLButtonElement>('[data-testid="projects-create"]')!
    expect(create.disabled).toBe(true)
    draft.value = 'Video experiments'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(create.disabled).toBe(false)
    create.click()
    await flush()
    const created = rows(root)[1]!
    expect(created.textContent).toContain('Video experiments')
    expect(created.querySelector('.projects-dialog-current')).toBeNull()
    actionButton(created, 'Switch').click()
    expect(onSwitch).toHaveBeenCalledWith(created.dataset['projectId'])
    unmount()
  })

  it('renames a project in place and persists the new name', async () => {
    const { root, unmount } = mount()
    actionButton(rows(root)[0]!, 'Rename').click()
    await flush()
    const input = root.querySelector<HTMLInputElement>('input[aria-label^="Rename"]')!
    input.value = 'Main studio'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(rows(root)[0]?.textContent).toContain('Main studio')
    expect(localStorage.getItem(PROJECTS_KEY)).toContain('Main studio')
    unmount()
  })

  it('offers a new-window action only when the host provides one', async () => {
    const { root, onOpenWindow, unmount } = mount({ withOpenWindow: true })
    actionButton(rows(root)[0]!, 'New window').click()
    expect(onOpenWindow).toHaveBeenCalledWith('default')
    unmount()
    const bare = mount()
    expect([...bare.root.querySelectorAll('button')].some((b) => b.textContent === 'New window')).toBe(false)
    bare.unmount()
  })
})
