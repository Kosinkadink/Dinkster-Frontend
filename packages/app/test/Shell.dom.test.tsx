// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DINKSTER_SCHEMA_WIRE_VERSION } from '@dinkster/core'
import { Shell, type ShellNavigation } from '../src/Shell.js'
import { PROJECT_URL_PARAM } from '../src/projects.js'
import type { HomeStatus, InstallationFrontend } from '../src/shell-route.js'

const here = DINKSTER_SCHEMA_WIRE_VERSION
const installations: Record<string, InstallationFrontend> = {
  '/same': { wire: here, selected: null, available: true },
  '/broken': { wire: here, selected: null, available: true },
  '/older': { wire: here + 1, selected: null, available: true },
  '/developed': { wire: here, selected: 'folder', available: true },
  '/none': { wire: here + 1, selected: null, available: false },
}

function mount(home: HomeStatus = { role: 'home', state: 'stopped' }) {
  let status: HomeStatus = { ...home }
  const opened: unknown[] = []
  const recorded: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input)
    if (path === '/supervisor/installations') {
      return Response.json({ installations: Object.entries(installations).map(([root, frontend]) => ({ root, frontend })) })
    }
    if (path === '/supervisor/status') return Response.json(status)
    if (path === '/supervisor/engine') {
      const target = JSON.parse(String(init?.body)) as { root: string; engine: string }
      opened.push(target)
      if (target.root === '/broken') return Response.json({ error: 'engine-failed', message: 'port 3639 is taken' })
      status = { ...status, state: 'starting', open: target }
      return Response.json(status)
    }
    if (path.startsWith('http://127.0.0.1:3637/')) return new Response('')
    const record = /^\/api\/projects\/([^/]+)\/opened$/.exec(path)
    if (record !== null && init?.method === 'POST') {
      recorded.push(decodeURIComponent(record[1]!))
      // An engine without the route answers 404; the open goes on.
      return new Response('{}', { status: 404 })
    }
    throw new Error(`unexpected fetch ${path}`)
  }))
  const editors: string[] = []
  const disposed: string[] = []
  const gates = new Map<string, Promise<void>>()
  const unnamed = new Set<string>()
  const navigated: string[] = []
  let shell!: ShellNavigation
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <Shell
    home={home}
    page={(props) => {
      shell = props.shell
      return <div data-testid="page">
        <span data-testid="line" title={props.shell.opening()?.reason ?? ''}>{props.shell.opening()?.line}</span>
        <span data-testid="failed">{props.shell.opening()?.failed}</span>
      </div>
    }}
    mountEditor={async (projectId, host) => {
      editors.push(projectId)
      const name = unnamed.has(projectId) ? '' : `<span class="dinkster-project-name">${projectId}</span>`
      host.innerHTML = `<header class="dinkster-window-toolbar-host" id="bar">${name}</header>` +
        `<nav class="left-sidebar"><button>${projectId}</button></nav><main>editor ${projectId}</main>`
      await gates.get(projectId)
      return () => {
        disposed.push(projectId)
        host.replaceChildren()
      }
    }}
    navigate={(url) => navigated.push(url)}
  />, root)
  return {
    root, editors, disposed, navigated, opened, recorded, dispose, gates, unnamed,
    get shell() { return shell },
    become(next: Partial<HomeStatus>) { status = { ...status, ...next } },
    page: () => root.querySelector<HTMLElement>('[data-testid="app-shell-page"]'),
    text: (id: string) => root.querySelector(`[data-testid="${id}"]`)?.textContent ?? '',
  }
}

describe('the one app shell', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/')
    document.documentElement.dataset['theme'] = 'dark'
    // No fades: every transition is immediate, so only the order of events is under test.
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it.each(['showProjects', 'popstate'])('keeps the projects page visible through %s during the outgoing fade', async (action) => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const view = mount()
    view.shell.openProject('film', { root: '/same', engine: 'main' })
    await vi.waitFor(() => expect(view.page()?.classList.contains('app-shell-faded')).toBe(true))
    if (action === 'showProjects') view.shell.showProjects()
    else {
      history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(location.search).toBe('')
    expect(view.page()).not.toBeNull()
    expect(view.page()!.classList.contains('app-shell-faded')).toBe(false)
    view.dispose()
  })

  it('disposes an editor whose asynchronous mount completes after the shell closes', async () => {
    const view = mount()
    let drawn!: () => void
    view.gates.set('film', new Promise((resolve) => { drawn = resolve }))
    view.shell.openProject('film', { root: '/same', engine: 'main' })
    await vi.waitFor(() => expect(view.editors).toEqual(['film']))
    view.dispose()
    drawn()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(view.disposed).toEqual(['film'])
    expect(view.recorded).toEqual([])
  })

  it('finishes disposing a superseded mount before starting the next project', async () => {
    const view = mount()
    let drawn!: () => void
    view.gates.set('film', new Promise((resolve) => { drawn = resolve }))
    view.shell.openProject('film', { root: '/same', engine: 'main' })
    await vi.waitFor(() => expect(view.editors).toEqual(['film']))
    view.shell.openProject('teapot')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(view.editors).toEqual(['film'])
    drawn()
    await vi.waitFor(() => expect(view.page()).toBeNull())
    expect(view.disposed).toEqual(['film'])
    expect(view.recorded).toEqual(['teapot'])
    expect(view.text('app-shell-editor')).toContain('editor teapot')
    expect(new URL(location.href).searchParams.get(PROJECT_URL_PARAM)).toBe('teapot')
    view.dispose()
    expect(view.disposed).toEqual(['film', 'teapot'])
  })

  it('uncovers the projects page when returning during a pending editor switch', async () => {
    const view = mount()
    view.shell.openProject('film', { root: '/same', engine: 'main' })
    await vi.waitFor(() => expect(view.page()).toBeNull())
    let drawn!: () => void
    view.gates.set('teapot', new Promise((resolve) => { drawn = resolve }))
    view.shell.openProject('teapot')
    await vi.waitFor(() => expect(view.editors).toEqual(['film', 'teapot']))
    view.shell.showProjects()
    drawn()
    await vi.waitFor(() => expect(view.disposed).toEqual(['film', 'teapot']))
    expect(view.page()).not.toBeNull()
    expect(view.root.querySelector('[data-testid="app-shell-cover"]')?.classList.contains('app-shell-covered')).toBe(false)
    expect(view.root.querySelector('[data-testid="app-shell-held"]')?.childElementCount).toBe(0)
    expect(view.recorded).toEqual(['film'])
    view.dispose()
  })

  it('opens a project on this wire version in the same page and keeps its editor behind the page', async () => {
    const view = mount()
    view.shell.openProject('film', { root: '/same', engine: 'main' })
    await vi.waitFor(() => expect(view.page()).toBeNull())
    expect(view.editors).toEqual(['film'])
    expect(view.opened).toEqual([{ root: '/same', engine: 'main' }])
    expect(new URL(location.href).searchParams.get(PROJECT_URL_PARAM)).toBe('film')
    expect(view.navigated).toEqual([])

    view.shell.showProjects()
    await vi.waitFor(() => expect(view.page()).not.toBeNull())
    expect(location.search).toBe('')
    expect(view.disposed).toEqual([])

    // Another project on the open installation replaces the editor without a page load.
    view.shell.openProject('teapot')
    await vi.waitFor(() => expect(view.editors).toEqual(['film', 'teapot']))
    expect(view.disposed).toEqual(['film'])
    expect(view.opened).toHaveLength(1)
    expect(view.navigated).toEqual([])
    await vi.waitFor(() => expect(view.recorded).toEqual(['film', 'teapot']))
  })

  it('keeps the top bar and icon bar on screen while switching projects, as a copy nothing can reach', async () => {
    const view = mount()
    view.shell.openProject('film', { root: '/same', engine: 'main' })
    await vi.waitFor(() => expect(view.page()).toBeNull())
    let drawn!: () => void
    view.gates.set('teapot', new Promise((resolve) => { drawn = resolve }))
    view.unnamed.add('teapot')
    const held = () => view.root.querySelector<HTMLElement>('[data-testid="app-shell-held"]')!

    view.shell.openProject('teapot')
    await vi.waitFor(() => expect(view.editors).toEqual(['film', 'teapot']))
    // The new editor is mounting underneath; the old one's bars stay over it until it has drawn.
    const copy = held().firstElementChild as HTMLElement
    expect(copy.querySelector('.dinkster-window-toolbar-host')?.textContent).toBe('film')
    expect(copy.querySelector('nav.left-sidebar')?.textContent).toBe('film')
    expect(copy.hasAttribute('inert')).toBe(true)
    expect(copy.getAttribute('aria-hidden')).toBe('true')
    expect(copy.querySelector('[id]')).toBeNull()
    expect(view.root.querySelector('[data-testid="app-shell-cover"]')?.classList.contains('app-shell-covered')).toBe(true)

    // Drawn but not yet named: the copy keeps the old name on screen rather than an empty top bar.
    drawn()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(held().childElementCount).toBe(1)
    view.root.querySelector('[data-testid="app-shell-editor"] header')!.innerHTML = '<span class="dinkster-project-name">teapot</span>'
    await vi.waitFor(() => expect(held().childElementCount).toBe(0))
    await vi.waitFor(() => expect(view.root.querySelector('[data-testid="app-shell-cover"]')?.classList.contains('app-shell-covered')).toBe(false))
    expect(view.text('app-shell-editor')).toContain('editor teapot')
    expect(view.disposed).toEqual(['film'])

    // An editor that fails to mount leaves no copy and no cover: the page shows the failed opening.
    const failing = Promise.reject(new Error('mount failed'))
    failing.catch(() => undefined)
    view.gates.set('bookshop', failing)
    view.shell.openProject('bookshop')
    await vi.waitFor(() => expect(view.page()).not.toBeNull())
    expect(view.text('failed')).toBe('The editor did not open')
    expect(view.root.querySelector('[data-testid="line"]')?.getAttribute('title')).toBe('mount failed')
    expect(held().childElementCount).toBe(0)
    await vi.waitFor(() => expect(view.root.querySelector('[data-testid="app-shell-cover"]')?.classList.contains('app-shell-covered')).toBe(false))
    expect(location.search).toBe('')
  })

  it('keeps the projects page opaque until the editor can arrive with its project name', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const view = mount()
    const host = view.root.querySelector<HTMLElement>('[data-testid="app-shell-editor"]')!
    view.unnamed.add('film')
    view.shell.openProject('film', { root: '/same', engine: 'main' })
    await vi.waitFor(() => expect(view.editors).toEqual(['film']), { timeout: 3000 })
    expect(view.page()).not.toBeNull()
    expect(view.page()!.classList.contains('app-shell-faded')).toBe(false)
    host.querySelector('header')!.innerHTML = '<span class="dinkster-project-name">film</span>'
    await vi.waitFor(() => expect(view.page()).toBeNull(), { timeout: 3000 })
    expect(view.text('app-shell-editor')).toContain('film')
    view.dispose()
  })

  it('opens an installation on another wire version at its own address once its engine is ready', async () => {
    const view = mount()
    view.shell.openProject('bookshop', { root: '/older', engine: 'main', name: 'Stable 0.0.16' })
    await vi.waitFor(() => expect(view.text('line')).toBe("Opening in Stable 0.0.16's own editor"))
    expect(view.root.querySelector('[data-testid="line"]')?.getAttribute('title')).toBe('This installation uses an older editor.')
    expect(view.editors).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(view.navigated).toEqual([])

    document.documentElement.dataset['theme'] = 'light'
    view.become({ state: 'ready', installationFrontend: 'http://127.0.0.1:3637' })
    await vi.waitFor(() => expect(view.navigated).toEqual(['http://127.0.0.1:3637/?dinksterProject=bookshop&dinksterTheme=light']))
    expect(view.root.querySelector('[data-testid="app-shell-cover"]')?.classList.contains('app-shell-covered')).toBe(true)
    expect(view.editors).toEqual([])
    expect(view.recorded).toEqual(['bookshop'])
  })

  it('sends a development frontend to its own address and reports a failed start', async () => {
    const view = mount()
    view.shell.openProject('audio', { root: '/developed', engine: 'main' })
    await vi.waitFor(() => expect(view.text('line')).toBe("Opening in developed's own editor"))
    expect(view.root.querySelector('[data-testid="line"]')?.getAttribute('title')).toBe('This installation uses a development editor.')
    view.become({ state: 'failed', detail: 'port 3639 is taken' })
    await vi.waitFor(() => expect(view.text('failed')).toBe('developed did not start'))
    expect(view.root.querySelector('[data-testid="line"]')?.getAttribute('title')).toBe('port 3639 is taken')
    expect(view.navigated).toEqual([])
  })

  it('names the installation whose engine did not start, with the engine detail as the reason', async () => {
    const view = mount()
    view.shell.openProject('diner', { root: '/broken', engine: 'main', name: 'Nightly' })
    await vi.waitFor(() => expect(view.text('failed')).toBe('Nightly did not start'))
    expect(view.text('line')).toBe('Starting Nightly')
    expect(view.root.querySelector('[data-testid="line"]')?.getAttribute('title')).toBe('port 3639 is taken')
    expect(view.editors).toEqual([])
    expect(view.page()).not.toBeNull()
    // A failed open never counts as opened.
    expect(view.recorded).toEqual([])
  })

  it('says so when an installation has no editor this build can open', async () => {
    const view = mount()
    view.shell.openProject('old', { root: '/none', engine: 'main' })
    await vi.waitFor(() => expect(view.text('failed')).toContain('no editor this Dinkster can open'))
    expect(view.opened).toEqual([])
    expect(view.navigated).toEqual([])
  })

  it('lands a reload of an editor whose installation needs its own frontend on the page, opening', async () => {
    history.replaceState(null, '', '/?dinksterProject=bookshop')
    const view = mount({ role: 'home', state: 'ready', open: { root: '/older', engine: 'main' }, installationFrontend: 'http://127.0.0.1:3637' })
    await vi.waitFor(() => expect(view.navigated).toEqual(['http://127.0.0.1:3637/?dinksterProject=bookshop&dinksterTheme=dark']))
    expect(view.editors).toEqual([])
    expect(view.opened).toEqual([])
  })
})
