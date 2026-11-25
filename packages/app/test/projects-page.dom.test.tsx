// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { setLocale } from '@dinkster/core'
import type { LibraryProject } from '@dinkster/client'
import '../src/locale.js'
import {
  ProjectsView,
  type PageInstallation,
  type ProjectsPageShell,
  type ProjectsSource,
} from '../src/projects-page/ProjectsPage.js'

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
  vi.useRealTimers()
})

const NOW = Date.parse('2026-11-25T12:00:00Z')
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toISOString()

const project = (id: string, name: string, created: string, lastRunAt?: string): LibraryProject => ({
  id,
  name,
  created,
  revision: 1,
  deleted: false,
  environment: lastRunAt
    ? { id: 'env', lastSnapshot: 's1', lastRunAt }
    : { id: 'env', lastSnapshot: null, lastRunAt: null },
})

const stable: PageInstallation = { root: '/home/u/Dinkster/Stable', engine: 'main', name: 'Stable' }
const nightly: PageInstallation = { root: '/home/u/Dinkster/Nightly', engine: 'main', name: 'Nightly' }

function source(projects: readonly LibraryProject[]): ProjectsSource {
  return {
    listProjects: async () => projects,
    registerProject: async (id, name) => project(id, name, new Date(NOW).toISOString()),
    listWorkflows: async () => [],
    listOutputs: async (id) =>
      id === 'p-valley'
        ? [{
            asset: { digest: 'blake3:1', name: 'valley.png', size: 1, mediaType: 'image/png', virtualPath: 'valley.png' },
            aliases: [],
            observations: [],
          }]
        : [],
    usage: async () => undefined,
    installations: async () => ({ all: [stable, nightly], open: stable }),
  }
}

function shell(opening?: ReturnType<ProjectsPageShell['opening']>) {
  const [current] = createSignal(opening)
  return {
    view: () => ({ kind: 'projects', newProject: false }) as const,
    opening: current,
    selectedProjectId: () => opening?.projectId,
    openProject: vi.fn(),
    showProjects: vi.fn(),
    cancelOpening: vi.fn(),
  } satisfies ProjectsPageShell
}

// A project edited but never run keeps its creation time; one that ran shows the run.
const projects = [
  project('p-bookshop', 'Bookshop diorama', hoursAgo(72)),
  project('p-film', 'Film grain tests', hoursAgo(24 * 30), hoursAgo(2)),
  project('p-valley', 'Valley matte paintings', hoursAgo(26)),
]

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const rows = () => [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent)

it('lists projects newest first by their last run, or their creation when they never ran', async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  render(() => <ProjectsView shell={shell()} source={source(projects)} />, document.body)
  await settle()
  expect(rows()).toEqual([
    'Film grain tests' + 'Ran 2 hours ago',
    'Valley matte paintings' + 'Created yesterday',
    'Bookshop diorama' + 'Created 3 days ago',
  ])
  expect(document.querySelector('h2')?.textContent).toBe('Film grain tests')
  expect(document.body.textContent).toContain('Last run 2 hours ago')
})

it('shows the opening line on the opening row and cancels through the shell', async () => {
  const navigation = shell({ projectId: 'p-bookshop', line: 'Starting Nightly' })
  render(() => <ProjectsView shell={navigation} source={source(projects)} />, document.body)
  await settle()
  const row = [...document.querySelectorAll('[role="option"]')].find((option) =>
    option.textContent?.startsWith('Bookshop diorama'),
  )!
  expect(row.getAttribute('data-state')).toBe('opening')
  expect(row.textContent).toContain('Starting Nightly')
  const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
  cancel.click()
  expect(navigation.cancelOpening).toHaveBeenCalledOnce()
})

it('explains a failed open with the project name and tries again on the installation it runs on', async () => {
  const navigation = shell({
    projectId: 'p-valley',
    line: 'Starting Nightly',
    failed: 'Nightly did not start',
    reason: 'port 3639 is taken',
  })
  localStorage.setItem('dinkster.p.p-valley.projectsPage.runsOn', nightly.root)
  render(() => <ProjectsView shell={navigation} source={source(projects)} />, document.body)
  await settle()
  expect(document.body.textContent).toContain('Nightly did not start, so Valley matte paintings could not open.')
  const row = document.querySelector('[role="option"][data-state="failed"]')!
  expect(row.querySelector('[title="port 3639 is taken"]')).not.toBeNull()
  const again = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
  again.click()
  expect(navigation.openProject).toHaveBeenCalledWith('p-valley', nightly)
})

it('keeps outputs hidden for one project only, across page loads', async () => {
  const first = render(() => <ProjectsView shell={shell({ projectId: 'p-valley', line: 'Opening' })} source={source(projects)} />, document.body)
  await settle()
  const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(document.querySelector('[aria-label="valley.png"]')).not.toBeNull()
  button('Hide')!.click()
  expect(document.querySelector('[aria-label="valley.png"]')).toBeNull()
  expect(document.body.textContent).toContain('Hidden on this page')
  first()
  document.body.replaceChildren()
  render(() => <ProjectsView shell={shell({ projectId: 'p-valley', line: 'Opening' })} source={source(projects)} />, document.body)
  await settle()
  expect(document.body.textContent).toContain('Hidden on this page')
  expect(localStorage.getItem('dinkster.p.p-film.projectsPage.outputsHidden')).toBeNull()
})
