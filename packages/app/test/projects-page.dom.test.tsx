// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale } from '@dinkster/core'
import type { LibraryProject } from '@dinkster/client'
import '../src/locale.js'
import {
  ProjectsView,
  type PageInstallation,
  type ProjectsPageShell,
  type ProjectsSource,
} from '../src/projects-page/ProjectsPage.js'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    plan: { id: 'p1', root: '/install/nightly', channel: 'nightly', variant: 'linux-nvidia',
      buildLabel: 'NVIDIA graphics card build', buildReason: 'Supported card',
      engineRelease: 'r1', baseId: 'b1', detectedCards: [], choices: [], gpus: [],
      downloadBytes: null, runtimeDownloadBytes: 0, freeBytes: 9000, refusal: null },
    activeJob: null,
  }))))
})
afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
  vi.useRealTimers()
  vi.unstubAllGlobals()
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
    renameProject: async (entry, name) => ({ ...entry, name, revision: entry.revision + 1 }),
    deleteProject: async (entry) => ({ ...entry, deleted: true, revision: entry.revision + 1, modified: new Date(NOW).toISOString() }),
    restoreProject: async (entry) => ({ ...entry, deleted: false, revision: entry.revision + 1 }),
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
    installations: async () => ({ all: [stable, nightly], open: stable, openFolder: true }),
    openFolder: async () => {},
    workflowDocument: async () => undefined,
    definitions: async () => undefined,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it.each(['projects', 'installations'] as const)('waits for both deciding reads when %s answers first, without a fast loading flash', async (first) => {
  const projectsRead = deferred<readonly LibraryProject[]>()
  const installationsRead = deferred<Awaited<ReturnType<ProjectsSource['installations']>>>()
  const counted = vi.fn()
  render(() => <ProjectsView shell={shell()} onCount={counted} source={{
    ...source([]), listProjects: () => projectsRead.promise, installations: () => installationsRead.promise,
  }} />, document.body)
  expect(document.body.textContent).toBe('')
  if (first === 'projects') projectsRead.resolve([])
  else installationsRead.resolve({ all: [] })
  await settle()
  expect(document.body.textContent).toBe('')
  expect(counted).not.toHaveBeenCalled()
  projectsRead.resolve([])
  installationsRead.resolve({ all: [] })
  await settle()
  expect(document.querySelector('[data-testid="projects-first-run"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="projects-loading"]')).toBeNull()
  const firstPaint = document.body.textContent
  await settle()
  expect(document.body.textContent).toBe(firstPaint)
})

it('shows slow loading at 200 ms and retains it for at least 300 ms', async () => {
  vi.useFakeTimers({ now: NOW })
  const read = deferred<readonly LibraryProject[]>()
  render(() => <ProjectsView shell={shell()} source={{ ...source([]), listProjects: () => read.promise, installations: async () => ({ all: [] }) }} />, document.body)
  await vi.advanceTimersByTimeAsync(199)
  expect(document.body.textContent).toBe('')
  await vi.advanceTimersByTimeAsync(1)
  expect(document.querySelector('[data-testid="projects-loading"]')?.textContent).toBe('Loading projects')
  read.resolve([])
  await vi.advanceTimersByTimeAsync(299)
  expect(document.querySelector('[data-testid="projects-first-run"]')).toBeNull()
  expect(document.querySelector('[data-testid="projects-loading"]')).not.toBeNull()
  await vi.advanceTimersByTimeAsync(1)
  expect(document.querySelector('[data-testid="projects-first-run"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="projects-loading"]')).toBeNull()
})

it('labels slow detail as one project and reveals its headings and lists together', async () => {
  vi.useFakeTimers({ now: NOW })
  const workflows = deferred<readonly never[]>()
  render(() => <ProjectsView shell={shell()} source={{
    ...source(projects), listWorkflows: () => workflows.promise,
  }} />, document.body)
  await vi.advanceTimersByTimeAsync(199)
  expect(document.querySelector('[data-testid="project-loading"]')).toBeNull()
  await vi.advanceTimersByTimeAsync(1)
  expect(document.querySelector('[data-testid="project-loading"]')?.textContent).toBe('Loading project')
  expect(document.querySelector('[data-testid="projects-loading"]')).toBeNull()
  expect(document.querySelector('h2')).toBeNull()
  expect(document.body.textContent).not.toContain('No workflows yet.')
  workflows.resolve([])
  await vi.advanceTimersByTimeAsync(300)
  expect(document.querySelector('[data-testid="project-loading"]')).toBeNull()
  expect(document.querySelector('h2')?.textContent).toBe('Film grain tests')
  expect(document.body.textContent).toContain('No workflows yet.')
})

it('keeps the first painted elements unchanged as detail arrives, and keeps old detail until a project switch settles', async () => {
  const film = deferred<readonly never[]>()
  const valley = deferred<readonly never[]>()
  render(() => <ProjectsView shell={shell()} source={{
    ...source(projects), listWorkflows: (id) => id === 'p-film' ? film.promise : valley.promise,
  }} />, document.body)
  await settle()
  expect(document.querySelector('.dinkster-skeleton')).toBeNull()
  expect(document.body.textContent).not.toContain('No workflows yet.')
  const painted = [...document.querySelectorAll('*')].filter((element) => !element.children.length && element.textContent?.trim()).map((element) => [element, element.textContent] as const)
  expect(painted.length).toBeGreaterThan(0)
  film.resolve([])
  await settle()
  for (const [element, text] of painted) {
    expect(element.isConnected).toBe(true)
    expect(element.textContent).toBe(text)
  }
  const detail = document.querySelector('[data-testid="projects-detail"]')!
  const original = detail.textContent
  const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.startsWith('Valley'))!
  row.click()
  await settle()
  expect(detail.isConnected).toBe(true)
  expect(detail.textContent).toBe(original)
  valley.resolve([])
  await settle()
  expect(document.querySelector('h2')?.textContent).toBe('Valley matte paintings')
  expect(document.querySelector('[aria-label="valley.png"]')).not.toBeNull()
})

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
  expect(document.body.textContent).toContain('No workflows yet. Open the project to make one.')
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

const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)
const menuItem = (label: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === label) as HTMLElement | undefined

it('renames the selected project at the revision it read', async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const data = source(projects)
  const renamed = vi.spyOn(data, 'renameProject')
  render(() => <ProjectsView shell={shell()} source={data} />, document.body)
  await settle()
  document.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click()
  menuItem('Rename')!.click()
  await settle()
  const input = document.querySelector<HTMLInputElement>('dialog input')!
  input.value = 'Film grain'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  button('Save')!.click()
  await settle()
  expect(renamed).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-film', revision: 1 }), 'Film grain')
  expect(rows()).toContain('Film grain' + 'Ran 2 hours ago')
})

it('moves a deleted project under Deleted projects, selects the next one, and restores it selected', async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const old = { ...project('p-old', 'Old storyboard', hoursAgo(24 * 40)), deleted: true, revision: 3, modified: new Date(NOW - 60_000).toISOString() }
  const data = source([...projects, old])
  const restored = vi.spyOn(data, 'restoreProject')
  render(() => <ProjectsView shell={shell()} source={data} />, document.body)
  await settle()
  const deletedRows = () => [...document.querySelectorAll('[data-testid="deleted-projects"] li')].map((row) => row.textContent)
  expect(rows()).toEqual(['Film grain testsRan 2 hours ago', 'Valley matte paintingsCreated yesterday', 'Bookshop diorama' + 'Created 3 days ago'])
  expect(document.querySelector('summary')?.textContent).toBe('Deleted projects (1)')
  expect(deletedRows()).toEqual(['Old storyboardDeleted 1 minute agoRestore'])

  document.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click()
  expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Rename', 'Delete'])
  menuItem('Delete')!.click()
  await settle()
  expect(document.querySelector('dialog')?.textContent).toContain('It moves to Deleted projects at the bottom of this list')
  button('Delete project')!.click()
  await settle()
  expect(rows().map((row) => row?.split(/Ran|Created/)[0])).toEqual(['Valley matte paintings', 'Bookshop diorama'])
  expect(document.querySelector('h2')?.textContent).toBe('Valley matte paintings')
  expect(deletedRows()).toEqual(['Film grain testsDeleted just nowRestore', 'Old storyboardDeleted 1 minute agoRestore'])

  ;[...document.querySelectorAll<HTMLButtonElement>('[data-testid="deleted-projects"] button')][1]!.click()
  await settle()
  expect(restored).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-old', revision: 3 }))
  expect(rows().map((row) => row?.split(/Ran|Created/)[0])).toContain('Old storyboard')
  expect(document.querySelector('h2')?.textContent).toBe('Old storyboard')
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Old storyboard')
  expect(deletedRows()).toEqual(['Film grain testsDeleted just nowRestore'])
})

it('offers no Delete for the default project', async () => {
  render(() => <ProjectsView shell={shell()} source={source([project('default', 'Default', hoursAgo(1))])} />, document.body)
  await settle()
  document.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click()
  expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Rename'])
})

it('does not open a project when the process cannot say which installation it runs on', async () => {
  const navigation = shell()
  const data = {
    ...source(projects),
    installations: async () => Promise.reject(new Error('GET /supervisor/installations failed: 500')),
  }
  render(() => <ProjectsView shell={navigation} source={data} />, document.body)
  await settle()
  expect(document.querySelector('[data-testid="projects-first-run"]')).toBeNull()
  const open = document.querySelector<HTMLButtonElement>('[data-testid="projects-open"]')!
  expect(open.getAttribute('aria-disabled')).toBe('true')
  expect(open.getAttribute('data-tooltip-label')).toBe('Could not read installations')
  expect(document.body.textContent).not.toContain('No installation')
  open.click()
  expect(navigation.openProject).not.toHaveBeenCalled()
})

it('shows the setup form while there is no installation, and the list once one appears', async () => {
  let found: readonly PageInstallation[] = []
  const counted = vi.fn()
  const data = { ...source([]), installations: async () => ({ all: found }) }
  render(() => <ProjectsView shell={shell()} source={data} onCount={counted} />, document.body)
  await settle()
  expect(document.querySelector('[data-testid="setup-form"]')?.textContent).toContain('NVIDIA graphics card build')
  expect(document.querySelector('[data-testid="setup-form"]')?.textContent).toContain('/install/nightly')
  expect(document.querySelector('code')).toBeNull()
  expect(rows()).toEqual([])
  expect(counted).not.toHaveBeenCalled()
  found = [stable]
  window.dispatchEvent(new Event('focus'))
  await settle()
  expect(document.querySelector('[data-testid="projects-first-run"]')).toBeNull()
  expect(counted).toHaveBeenLastCalledWith(0)
})

it('does not suggest opening a project to create workflows without an installation', async () => {
  render(() => <ProjectsView shell={shell()} source={{ ...source(projects), installations: async () => ({ all: [] }) }} />, document.body)
  await settle()
  expect(document.body.textContent).toContain('No workflows yet.')
  expect(document.body.textContent).not.toContain('Open the project to make one.')
})

it('keeps projects readable and restorable without an installation, but cannot open an editor from a workflow tile', async () => {
  const navigation = shell()
  const deleted = { ...project('p-old', 'Old storyboard', hoursAgo(48)), deleted: true }
  const data = {
    ...source([...projects, deleted]),
    installations: async () => ({ all: [] }),
    listWorkflows: async () => [{ id: 'w1', scope: 'local', name: 'Kitchen still life', digest: 'blake3:1',
      mediaType: 'application/x-dinkster-workflow+json', labels: ['workflow'], created: 1, modified: 1, revision: 1 }],
  }
  render(() => <ProjectsView shell={navigation} source={data} />, document.body)
  await settle()
  expect(document.querySelector('[data-testid="projects-first-run"]')).toBeNull()
  expect(rows()).toHaveLength(3)
  expect(document.querySelector('h2')?.textContent).toBe('Film grain tests')
  expect(document.querySelector('[data-testid="setup-form"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="projects-open"]')?.getAttribute('aria-disabled')).toBe('true')
  const tile = document.querySelector<HTMLButtonElement>('.dinkster-tile')!
  expect(tile.disabled).toBe(true)
  expect(tile.getAttribute('data-tooltip-label')).toBe('No installation yet')
  tile.click()
  expect(navigation.openProject).not.toHaveBeenCalled()
  button('Restore')!.click()
  await settle()
  expect(document.querySelector('h2')?.textContent).toBe('Old storyboard')
  expect(rows()).toHaveLength(4)
})

it('keeps selection working when the process cannot list workflows or outputs', async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const data = {
    ...source(projects),
    listWorkflows: async () => Promise.reject(new Error('GET /api/library failed: 404')),
    listOutputs: async (id: string) => Promise.reject(new Error(`GET /api/projects/${id}/outputs failed: 404`)),
  }
  render(() => <ProjectsView shell={shell()} source={data} />, document.body)
  await settle()
  expect(document.body.textContent).toContain("Could not read this project's workflows.")
  expect(document.body.textContent).toContain("Could not read this project's latest outputs.")
  ;[...document.querySelectorAll('[role="option"]')].find((row) => row.textContent?.startsWith('Bookshop'))!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  expect(document.querySelector('h2')?.textContent).toBe('Bookshop diorama')
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Bookshop diorama')
})

it('shows the output folder as the Outputs fact, offers Show in folder only when the process can open it, and draws no fact without a folder', async () => {
  const folder = '/home/u/Dinkster/library/output'
  const withFolder = [{ ...projects[1]!, folder }, { ...projects[0]!, folder: null }]
  const data = source(withFolder)
  const opened = vi.spyOn(data, 'openFolder').mockRejectedValueOnce(new Error('POST failed: 404'))
  const facts = () => document.querySelector('[aria-label="About this project"]')?.textContent ?? ''
  const first = render(() => <ProjectsView shell={shell()} source={data} />, document.body)
  await settle()
  expect(facts()).toContain('Outputs' + folder)
  button('Show in folder')!.click()
  await settle()
  expect(opened).toHaveBeenCalledWith('p-film')
  expect(document.body.textContent).toContain('The folder could not be opened on this computer.')
  ;[...document.querySelectorAll('[role="option"]')].find((row) => row.textContent?.startsWith('Bookshop'))!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  expect(facts()).not.toContain('Outputs')
  first()
  document.body.replaceChildren()
  render(() => <ProjectsView shell={shell()} source={{ ...data, installations: async () => ({ all: [stable], openFolder: false }) }} />, document.body)
  await settle()
  expect(facts()).toContain(folder)
  expect(button('Show in folder')).toBeUndefined()
})

it('dates a workflow tile from the record, which counts seconds', async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const seconds = (NOW - 2 * 3600_000) / 1000
  const workflow = { id: 'w1', scope: 'local', name: 'Kitchen still life', digest: `blake3:${'a'.repeat(64)}`,
    mediaType: 'application/x-dinkster-workflow+json', labels: ['workflow'], created: seconds, modified: seconds, revision: 1 }
  render(() => <ProjectsView shell={shell()} source={{ ...source(projects), listWorkflows: async () => [workflow] }} />, document.body)
  await settle()
  const tile = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Kitchen still life'))
  expect(tile?.textContent).toBe('Kitchen still life' + '2 hours ago')
})

it('draws a workflow tile from its saved document, and keeps the icon for one it cannot read', async () => {
  const record = (id: string, digest: string) => ({ id, scope: 'local', name: id, digest, mediaType: 'application/x-dinkster-workflow+json',
    labels: ['workflow'], created: 1, modified: 1, revision: 1 })
  const saved = { format: 'dinkster-workflow', formatVersion: 1, lineage: 'l', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
    view: { graphs: { g0: { nodes: {} } } } } as unknown as import('@dinkster/core').WorkflowDocument
  const data = {
    ...source(projects),
    listWorkflows: async () => [record('Readable', 'blake3:read'), record('Unreadable', 'blake3:gone')],
    workflowDocument: async (digest: string) => (digest === 'blake3:read' ? saved : undefined),
  }
  render(() => <ProjectsView shell={shell()} source={data} />, document.body)
  await settle()
  await settle()
  const tile = (name: string) => [...document.querySelectorAll('button.dinkster-tile')].find((b) => b.textContent?.startsWith(name))!
  expect(tile('Readable').querySelector('.dinkster-tile-picture canvas')).not.toBeNull()
  expect(tile('Unreadable').querySelector('canvas')).toBeNull()
  expect(tile('Unreadable').querySelector('.dinkster-tile-empty svg')).not.toBeNull()
})
