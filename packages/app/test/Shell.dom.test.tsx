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
  '/older': { wire: here + 1, selected: null, available: true },
  '/developed': { wire: here, selected: 'folder', available: true },
  '/none': { wire: here + 1, selected: null, available: false },
}

function mount(home: HomeStatus = { role: 'home', state: 'stopped' }) {
  let status: HomeStatus = { ...home }
  const opened: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input)
    if (path === '/supervisor/installations') {
      return Response.json({ installations: Object.entries(installations).map(([root, frontend]) => ({ root, frontend })) })
    }
    if (path === '/supervisor/status') return Response.json(status)
    if (path === '/supervisor/engine') {
      const target = JSON.parse(String(init?.body)) as { root: string; engine: string }
      opened.push(target)
      status = { ...status, state: 'starting', open: target }
      return Response.json(status)
    }
    if (path.startsWith('http://127.0.0.1:3637/')) return new Response('')
    throw new Error(`unexpected fetch ${path}`)
  }))
  const editors: string[] = []
  const disposed: string[] = []
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
      host.textContent = `editor ${projectId}`
      return () => disposed.push(projectId)
    }}
    navigate={(url) => navigated.push(url)}
  />, root)
  return {
    root, editors, disposed, navigated, opened, dispose,
    get shell() { return shell },
    become(next: Partial<HomeStatus>) { status = { ...status, ...next } },
    page: () => root.querySelector<HTMLElement>('[data-testid="app-shell-page"]'),
    text: (id: string) => root.querySelector(`[data-testid="${id}"]`)?.textContent ?? '',
  }
}

describe('the one app shell', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/')
    // No fades: every transition is immediate, so only the order of events is under test.
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
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
  })

  it('opens an installation on another wire version at its own address once its engine is ready', async () => {
    const view = mount()
    view.shell.openProject('bookshop', { root: '/older', engine: 'main', name: 'Stable 0.0.16' })
    await vi.waitFor(() => expect(view.text('line')).toBe("Opening in Stable 0.0.16's own editor"))
    expect(view.root.querySelector('[data-testid="line"]')?.getAttribute('title')).toBe('This installation uses an older editor.')
    expect(view.editors).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(view.navigated).toEqual([])

    view.become({ state: 'ready', installationFrontend: 'http://127.0.0.1:3637' })
    await vi.waitFor(() => expect(view.navigated).toEqual(['http://127.0.0.1:3637/?dinksterProject=bookshop']))
    expect(view.root.querySelector('[data-testid="app-shell-cover"]')?.classList.contains('app-shell-covered')).toBe(true)
    expect(view.editors).toEqual([])
  })

  it('sends a development frontend to its own address and reports a failed start', async () => {
    const view = mount()
    view.shell.openProject('audio', { root: '/developed', engine: 'main' })
    await vi.waitFor(() => expect(view.text('line')).toBe("Opening in developed's own editor"))
    expect(view.root.querySelector('[data-testid="line"]')?.getAttribute('title')).toBe('This installation uses a development editor.')
    view.become({ state: 'failed', detail: 'port 3639 is taken' })
    await vi.waitFor(() => expect(view.text('failed')).toBe('port 3639 is taken'))
    expect(view.navigated).toEqual([])
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
    await vi.waitFor(() => expect(view.navigated).toEqual(['http://127.0.0.1:3637/?dinksterProject=bookshop']))
    expect(view.editors).toEqual([])
    expect(view.opened).toEqual([])
  })
})
