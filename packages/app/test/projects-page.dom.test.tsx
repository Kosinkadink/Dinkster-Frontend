// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { asConnectionId, loadDocument, setLocale, type CollectionEntry, type WorkflowDocument } from '@dinkster/core'
import { DinksterConnection, RequestFailure, type LibraryProject, type ProjectCreation } from '@dinkster/client'
import '../src/locale.js'
import { InstallationsView } from '../src/projects-page/InstallationsPage.js'
import {
  processSource,
  ProjectsPage,
  ProjectsView,
  type PageInstallation,
  type ProjectsPageShell,
  type ProjectsSource,
} from '../src/projects-page/ProjectsPage.js'

function installationFactsReply(input: unknown): Response | undefined {
  const url = new URL(String(input), 'http://localhost')
  if (url.pathname.endsWith('/history')) return Response.json({ root: url.searchParams.get('root'), current: null, history: [] })
  return url.pathname.endsWith('/facts')
    ? Response.json({ root: url.searchParams.get('root'), current: 1, build: { version: '0.0.19', variant: 'linux-cpu' }, engines: [] })
    : undefined
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input) => installationFactsReply(input) ?? new Response(JSON.stringify({
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

const project = (id: string, name: string, created: string, lastOpenedAt: string | null = null): LibraryProject => ({
  id,
  name,
  created,
  lastOpenedAt,
  revision: 1,
  deleted: false,
  environment: { id: 'env', lastSnapshot: null, lastRunAt: null },
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
    needs: async () => ({ packs: [], extra: [], unknown: [] }),
    listOutputs: async (id) =>
      id === 'p-valley'
        ? [{
            asset: { digest: 'blake3:1', name: 'valley.png', size: 1, mediaType: 'image/png', virtualPath: 'valley.png' },
            aliases: [],
            observations: [],
          }]
        : [],
    usage: async () => undefined,
    installations: async () => ({ all: [stable, nightly], open: stable, openFolder: true, projectsFolder: '/configured/projects' }),
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

const projects = [
  project('p-bookshop', 'Bookshop diorama', hoursAgo(72)),
  project('p-film', 'Film grain tests', hoursAgo(24 * 30), hoursAgo(2)),
  project('p-valley', 'Valley matte paintings', hoursAgo(26), hoursAgo(26)),
]

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const rows = () => [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent)
const loading = (label: string) => [...document.querySelectorAll('[role="status"]')].find((node) => node.textContent === label)

it('shows recorded history newest first and keeps current generations, imports and failures distinct across roots', async () => {
  let finishStable: (response: Response) => void = () => {}
  let stableRead = new Promise<Response>((resolve) => { finishStable = resolve })
  let unavailable = false
  let empty = false
  const entry = (id: number, generation: number, reason: string, version: string, kind: 'activation' | 'import' = 'activation') => ({
    id, generation, reason, kind, timestamp: `2026-11-${10 + id}T12:34:00Z`, snapshot: { engine: { version } },
  })
  const nightlyHistory = {
    current: 4,
    history: [entry(1, 4, 'legacy-import', '0.1.0', 'import'), entry(2, 9, 'update', '0.2.0'),
      entry(3, 4, 'restore', '0.3.0'), entry(4, 12, 'new-operation', '0.7.0')],
  }
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/history')) {
      if (url.searchParams.get('root') === stable.root) return stableRead
      return unavailable ? Response.json({ error: 'history-unavailable', message: 'Recorded history cannot be read' }, { status: 503 })
        : Response.json(empty ? { current: null, history: [] } : nightlyHistory)
    }
    return installationFactsReply(input) ?? Response.json({ sandboxPacks: false, available: true, detail: '' })
  }))
  const dispose = render(() => <InstallationsView source={{ installations: async () => ({ all: [stable, nightly], engine: 'stopped' }) }} />, document.body)
  await settle()
  document.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click()
  await settle()
  const history = () => document.querySelector('[aria-label="History"]')!
  const items = () => [...history().querySelectorAll('li')]
  expect(items().map((row) => row.textContent)).toEqual([
    expect.stringContaining('Recorded version 0.7.0'), expect.stringContaining('Restored to 0.3.0'),
    expect.stringContaining('Updated to 0.2.0'), expect.stringContaining('Imported record of 0.1.0'),
  ])
  expect(items().filter((row) => row.textContent?.includes('Current')).map((row) => row.textContent)).toEqual([
    expect.stringContaining('Restored to 0.3.0'),
  ])
  expect(items()[0]!.querySelector('time')?.dateTime).toBe('2026-11-14T12:34:00Z')
  finishStable(Response.json({ current: 1, history: [entry(1, 1, 'setup', '9.9.9')] }))
  await settle()
  expect(history().textContent).not.toContain('9.9.9')
  stableRead = Promise.resolve(Response.json({ current: 1, history: [entry(1, 1, 'setup', '9.9.9')] }))
  document.querySelectorAll<HTMLElement>('[role="option"]')[0]!.click()
  await settle()
  expect(history().textContent).toContain('Set up with 9.9.9')
  unavailable = true
  document.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click()
  await settle()
  expect(document.body.textContent).toContain('Recorded history cannot be read')
  expect(document.body.textContent).not.toContain('No recorded installation history')
  unavailable = false
  empty = true
  ;[...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click()
  await settle()
  expect(document.body.textContent).toContain('No recorded installation history')
  expect(document.body.textContent).not.toContain('Recorded history cannot be read')
  empty = false
  nightlyHistory.history[1]!.reason = 'rollback'
  globalThis.dispatchEvent(new Event('focus'))
  await settle()
  expect(history().textContent).toContain('Restored to 0.3.0')
  expect(history().textContent).toContain('Restored previous version 0.2.0')
  expect(history().textContent).not.toContain('Rolled back')
  dispose()
})

it('keeps recorded facts with their selected installation through late replies, failures and retry', async () => {
  let finishStable: (response: Response) => void = () => {}
  let stableRead = new Promise<Response>((resolve) => { finishStable = resolve })
  let nightlyUnavailable = false
  let noBuild = false
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/facts')) {
      if (url.searchParams.get('root') === stable.root) return stableRead
      return nightlyUnavailable
        ? Response.json({ error: 'facts-unavailable', message: 'Selected snapshot cannot be read' }, { status: 503 })
        : Response.json({ root: nightly.root, current: noBuild ? null : 7,
          build: noBuild ? null : { version: '0.3.7', variant: 'linux-cuda128' }, engines: [] })
    }
    return installationFactsReply(input) ?? Response.json({ sandboxPacks: false, available: true, detail: '' })
  }))
  const dispose = render(() => <InstallationsView source={{ installations: async () => ({
    all: [stable, nightly], open: stable, engine: 'ready',
  }) }} />, document.body)
  await settle()
  document.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click()
  await settle()
  const facts = () => document.querySelector('[aria-label="About this installation"]')!
  expect(facts().textContent).toContain(nightly.root)
  expect(facts().textContent).toContain('linux-cuda128')
  expect(facts().textContent).toContain('0.3.7')
  finishStable(Response.json({ root: stable.root, current: 2, build: { version: '0.1.2', variant: 'linux-cpu' }, engines: [] }))
  await settle()
  expect(facts().textContent).not.toContain('0.1.2')
  stableRead = Promise.resolve(Response.json({ root: stable.root, current: 2, build: { version: '0.1.2', variant: 'linux-cpu' }, engines: [] }))
  document.querySelectorAll<HTMLElement>('[role="option"]')[0]!.click()
  await settle()
  expect(facts().textContent).toContain('0.1.2')
  nightlyUnavailable = true
  document.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click()
  await settle()
  expect(document.body.textContent).toContain('Selected snapshot cannot be read')
  expect(document.querySelector('[aria-label="About this installation"]')).toBeNull()
  nightlyUnavailable = false
  noBuild = true
  ;[...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click()
  await settle()
  expect(facts().textContent).toContain('No selected build')
  expect(facts().textContent).not.toContain('0.3.7')
  noBuild = false
  globalThis.dispatchEvent(new Event('focus'))
  await settle()
  expect(facts().textContent).toContain('0.3.7')
  dispose()
})

it('selects installations independently of the running engine and opens setup in the detail pane', async () => {
  const dispose = render(() => <InstallationsView source={{ installations: async () => ({
    all: [stable, nightly], open: nightly, engine: 'ready',
  }) }} />, document.body)
  await settle()
  expect(rows()).toEqual(['StableStopped', 'NightlyRunning'])
  expect(document.querySelector('[aria-label="About this installation"]')?.textContent).toContain(stable.root)
  document.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click()
  await settle()
  expect(document.querySelector('h2')?.textContent).toBe('Nightly')
  expect(document.querySelector('[aria-label="About this installation"]')?.textContent).toContain(nightly.root)
  ;[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Set up'))!.click()
  await settle()
  expect(document.querySelector('[data-testid="setup-form"]')).not.toBeNull()
  expect(document.querySelector('.dinkster-projects-detail')?.textContent).toContain('Set up Dinkster')
  const back = document.querySelector<HTMLButtonElement>('.dinkster-projects-back button')!
  expect(back.textContent).toBe('Installations')
  back.click()
  await settle()
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe('NightlyRunning')
  document.querySelectorAll<HTMLElement>('[role="option"]')[0]!.click()
  await settle()
  expect(document.querySelector('[data-testid="setup-form"]')).toBeNull()
  expect(document.querySelector('h2')?.textContent).toBe('Stable')
  dispose()
})

it('does not invent stopped status when the installation list is readable but engine status is not', async () => {
  const dispose = render(() => <InstallationsView source={{ installations: async () => ({ all: [stable] }) }} />, document.body)
  await settle()
  expect(rows()).toEqual(['StableCould not read engine status'])
  expect(document.querySelector('.dinkster-project-header')?.textContent).toContain('Could not read engine status')
  dispose()
})

it('offers setup only after a failed installations read recovers to a known empty list', async () => {
  let unavailable = true
  const dispose = render(() => <InstallationsView source={{ installations: async () => {
    if (unavailable) throw new Error('Registry is unavailable')
    return { all: [] }
  } }} />, document.body)
  await settle()
  expect(document.body.textContent).toContain('Registry is unavailable')
  expect(document.querySelector('[data-testid="setup-form"]')).toBeNull()
  unavailable = false
  ;[...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click()
  await settle()
  expect(document.body.textContent).not.toContain('Registry is unavailable')
  expect(document.querySelector('[data-testid="setup-form"]')).not.toBeNull()
  dispose()
})

it('reads saved sandbox authority per installation and keeps unavailable prerequisites distinct from off', async () => {
  let available = false
  const saved = new Map([[stable.root, false], [nightly.root, true]])
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const facts = installationFactsReply(input)
    if (facts) return facts
    const url = new URL(String(input), 'http://localhost')
    const root = url.searchParams.get('root')!
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      saved.set(body.root, body.sandboxPacks)
      // The write happened even though its reply was lost.
      throw new Error('Reply lost')
    }
    return Response.json(url.pathname.endsWith('/readiness')
      ? { sandboxPacks: saved.get(root), available, detail: 'bubblewrap is missing' }
      : { available: true, packs: [] })
  }))
  const dispose = render(() => <InstallationsView source={{ installations: async () => ({ all: [stable, nightly], engine: 'stopped' }) }} />, document.body)
  await settle()
  const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(toggle().disabled).toBe(true)
  expect(document.querySelector('details')?.textContent).toContain('bubblewrap is missing')
  available = true
  ;[...document.querySelectorAll('button')].find((button) => button.textContent === 'Check again')!.click()
  await settle()
  expect(toggle().disabled).toBe(false)
  toggle().click()
  await settle()
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('The engine did not answer.')
  expect(document.body.textContent).toContain('Changes apply when the engine restarts.')
  document.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click()
  await settle()
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  toggle().click()
  await settle()
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  document.querySelectorAll<HTMLElement>('[role="option"]')[0]!.click()
  await settle()
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  dispose()
})

it('shows pack requests and edits all internet addresses with provenance and field-specific refusals', async () => {
  let addresses = [{ address: 'https://models.example', source: 'pack' }, { address: 'https://mirror.example', source: 'user' }]
  let packRead: Promise<void> | undefined
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const facts = installationFactsReply(input)
    if (facts) return facts
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/readiness')) return Response.json({ sandboxPacks: true, available: true, detail: '' })
    if (url.pathname.endsWith('/internet')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        if (body.address === 'bad') return Response.json({ error: 'invalid-request', message: 'Use an exact HTTPS origin' }, { status: 400 })
        addresses = [...addresses, { address: body.address, source: 'user' }]
      } else if (init?.method === 'DELETE') {
        const body = JSON.parse(String(init.body))
        addresses = addresses.filter((row) => row.address !== body.address)
      }
      return Response.json({ internetAddresses: addresses })
    }
    await packRead
    return Response.json({ available: true, packs: [
      { pack: 'Detector', graphicsCard: { requested: true, granted: true }, internetAddresses: addresses },
      { pack: 'Local tools', graphicsCard: { requested: false, granted: false }, internetAddresses: [] },
      { pack: 'Unreadable', graphicsCard: { requested: null, granted: null }, internetAddresses: null },
    ] })
  }))
  const dispose = render(() => <InstallationsView source={{ installations: async () => ({ all: [stable], engine: 'stopped' }) }} />, document.body)
  await settle()
  const table = document.querySelector('table')!
  expect([...table.querySelectorAll('tbody tr')].map((row) => row.textContent)).toEqual([
    'DetectorUses it2 addresses', 'Local toolsNot used0 addresses', 'UnreadableNot knownNot known',
  ])
  expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
  ;[...table.querySelectorAll('button')].find((button) => button.textContent === '2 addresses')!.click()
  await settle()
  const dialog = () => document.querySelector('dialog')!
  expect(dialog().textContent).toContain('https://models.exampleAsked by the pack')
  expect(dialog().textContent).toContain('https://mirror.exampleAdded by you')
  const input = () => dialog().querySelector('input')!
  const enter = (value: string) => { input().value = value; input().dispatchEvent(new Event('input', { bubbles: true })) }
  enter('bad')
  dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(input().getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById(input().getAttribute('aria-describedby')!)?.textContent).toContain('Use an exact HTTPS origin')
  enter('https://extra.example')
  dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(dialog().textContent).toContain('https://extra.exampleAdded by you')
  ;[...dialog().querySelectorAll('li')].find((row) => row.textContent?.includes('https://models.example'))!.querySelector('button')!.click()
  expect(dialog().textContent).toContain('Remove https://models.example')
  ;[...dialog().querySelectorAll('button')].find((button) => button.textContent === 'Remove')!.click()
  await settle()
  expect(dialog().textContent).not.toContain('https://models.example')
  expect(dialog().textContent).toContain('https://mirror.exampleAdded by you')
  expect(dialog().textContent).toContain('https://extra.exampleAdded by you')
  dialog().dispatchEvent(new Event('close'))
  await settle()
  const addressButton = [...document.querySelectorAll<HTMLButtonElement>('table button')]
    .find((button) => button.textContent === '2 addresses')!
  expect(document.querySelector('dialog')).toBeNull()
  expect(document.activeElement).toBe(addressButton)
  addressButton.click()
  await settle()
  let release!: () => void
  packRead = new Promise<void>((resolve) => { release = resolve })
  dialog().dispatchEvent(new Event('close'))
  await settle()
  const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!
  toggle.focus()
  release()
  await settle()
  expect(document.activeElement).toBe(toggle)
  dispose()
})

it('does not turn unavailable pack metadata into an empty installed pack list', async () => {
  let unavailable = true
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const facts = installationFactsReply(input)
    if (facts) return facts
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.endsWith('/readiness')) return Response.json({ sandboxPacks: true, available: true, detail: '' })
    return unavailable
      ? Response.json({ error: 'pack-metadata-unavailable', message: 'Snapshot cannot report pack requests' }, { status: 503 })
      : Response.json({ available: true, packs: [] })
  }))
  const dispose = render(() => <InstallationsView source={{ installations: async () => ({ all: [stable], engine: 'stopped' }) }} />, document.body)
  await settle()
  expect(document.body.textContent).toContain('Snapshot cannot report pack requests')
  expect(document.body.textContent).not.toContain('No packs installed')
  unavailable = false
  ;[...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click()
  await settle()
  expect(document.body.textContent).toContain('No packs installed')
  expect(document.body.textContent).not.toContain('Snapshot cannot report pack requests')
  dispose()
})

it.each([
  { required: ['a', 'b', 'a'], extra: ['a', 'c', 'c'], unknown: 0, text: '2 needed by its workflows, 1 added', names: 'a\nb\nc' },
  { required: ['a', 'b'], extra: [], unknown: 0, text: '2 needed by its workflows', names: 'a\nb' },
  { required: ['a', 'b'], extra: [], unknown: 2, text: 'At least 2 needed. 2 workflows not checked yet', names: 'a\nb' },
  { required: [], extra: [], unknown: 0, text: 'None needed', names: null },
  { required: [], extra: [], unknown: 2, text: 'Not known yet. 2 workflows not checked', names: null },
  { required: [], extra: ['c'], unknown: 0, text: 'None needed, 1 added', names: 'c' },
  { required: [], extra: [], unknown: -1, text: 'Not known yet', names: null },
])('shows project pack facts, not installation state: $text', async ({ required, extra, unknown, text, names }) => {
  render(() => <ProjectsView shell={shell()} source={{
    ...source(projects),
    needs: async () => {
      if (unknown < 0) throw new Error('unavailable')
      return { packs: required.map((pack) => ({ pack, version: null })), extra,
        unknown: Array.from({ length: unknown }, (_, i) => ({ scope: 'local', id: `w${i}` })),
        installed: [{ pack: 'unrelated', version: null }] }
    },
  }} />, document.body)
  await settle()
  const row = [...document.querySelectorAll('.dinkster-project-fact')].find((row) => row.querySelector('dt')?.textContent === 'Packs')!
  expect(row.querySelector('dd')?.textContent).toBe(text)
  expect(row.querySelector('span[data-tooltip-label]')?.getAttribute('data-tooltip-label') ?? null).toBe(names)
  if (unknown > 0) expect(row.querySelector('.dinkster-project-fact-detail')?.textContent).toBe(text.slice(text.indexOf('.')))
})

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
  expect(document.querySelector('h1')?.textContent).toBe('Projects')
  expect(document.querySelector('button')?.textContent).toContain('New')
  if (first === 'projects') projectsRead.resolve([])
  else installationsRead.resolve({ all: [] })
  await settle()
  expect(document.querySelector('h1')?.textContent).toBe('Projects')
  expect(document.querySelector('[role="option"]')).toBeNull()
  expect(counted).not.toHaveBeenCalled()
  projectsRead.resolve([])
  installationsRead.resolve({ all: [] })
  await settle()
  expect(document.querySelector('[data-testid="projects-first-run"]')).not.toBeNull()
  expect(loading('Loading projects')).toBeUndefined()
  const firstPaint = document.body.textContent
  await settle()
  expect(document.body.textContent).toBe(firstPaint)
})

it('shows slow loading at 200 ms and retains it for at least 300 ms', async () => {
  vi.useFakeTimers({ now: NOW })
  const read = deferred<readonly LibraryProject[]>()
  render(() => <ProjectsView shell={shell()} source={{ ...source([]), listProjects: () => read.promise, installations: async () => ({ all: [] }) }} />, document.body)
  await vi.advanceTimersByTimeAsync(199)
  expect(document.querySelector('h1')?.textContent).toBe('Projects')
  expect(loading('Loading projects')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(loading('Loading projects')).toBeDefined()
  read.resolve([])
  await vi.advanceTimersByTimeAsync(299)
  expect(document.querySelector('[data-testid="projects-first-run"]')).toBeNull()
  expect(loading('Loading projects')).toBeDefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(document.querySelector('[data-testid="projects-first-run"]')).not.toBeNull()
  expect(loading('Loading projects')).toBeUndefined()
})

it('shows known headings and actions before slow project facts arrive', async () => {
  vi.useFakeTimers({ now: NOW })
  const workflows = deferred<readonly never[]>()
  render(() => <ProjectsView shell={shell()} source={{
    ...source(projects), listWorkflows: () => workflows.promise,
  }} />, document.body)
  await vi.advanceTimersByTimeAsync(199)
  expect(loading('Loading project')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(loading('Loading project')).toBeDefined()
  expect(loading('Loading projects')).toBeUndefined()
  expect(document.querySelector('h2')?.textContent).toBe('Film grain tests')
  expect(document.querySelector('h3')?.textContent).toBe('Workflows')
  expect(document.body.textContent).not.toContain('Latest outputs')
  expect(document.querySelector('[data-testid="projects-open"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('No workflows yet.')
  workflows.resolve([])
  await vi.advanceTimersByTimeAsync(300)
  expect(loading('Loading project')).toBeUndefined()
  expect(document.querySelector('h2')?.textContent).toBe('Film grain tests')
  expect(document.body.textContent).toContain('No workflows yet.')
  expect(document.body.textContent).toContain('Latest outputs')
})

it('keeps the first painted elements unchanged as detail arrives, and keeps old detail until a project switch settles', async () => {
  const film = deferred<readonly never[]>()
  const valley = deferred<readonly never[]>()
  render(() => <ProjectsView shell={shell()} source={{
    ...source(projects), listProjects: async () => projects.map((project) => ({ ...project })),
    listWorkflows: (id) => id === 'p-film' ? film.promise : valley.promise,
    usage: async (id) => ({ outputs: 12, bytes: id === 'p-film' ? 0 : 1536 }),
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
  const detail = document.querySelector('.dinkster-projects-detail')!
  expect(detail.textContent).toContain('0 B')
  const original = detail.textContent
  const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.startsWith('Valley'))!
  row.focus()
  globalThis.dispatchEvent(new Event('focus'))
  await settle()
  expect(document.activeElement).toBe(row)
  expect(row.isConnected).toBe(true)
  row.click()
  await settle()
  expect(detail.isConnected).toBe(true)
  expect(detail.textContent).toBe(original)
  valley.resolve([])
  await settle()
  expect(document.querySelector('h2')?.textContent).toBe('Valley matte paintings')
  expect(detail.textContent).toContain('1.5 KB')
  expect(document.querySelector('[aria-label="valley.png"]')).not.toBeNull()
})

it('lists projects by opening time, with never-opened projects last regardless of creation or runs', async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const opened = [
    { ...projects[0]!, created: hoursAgo(1), lastOpenedAt: null },
    { ...projects[1]!, lastOpenedAt: hoursAgo(2), environment: { id: 'env', lastSnapshot: 's1', lastRunAt: hoursAgo(48) } },
    { ...projects[2]!, lastOpenedAt: hoursAgo(26), environment: { id: 'env', lastSnapshot: 's2', lastRunAt: hoursAgo(1) } },
  ]
  render(() => <ProjectsView shell={shell()} source={source(opened)} />, document.body)
  await settle()
  expect(rows()).toEqual([
    'Film grain tests' + 'Opened 2 hours ago',
    'Valley matte paintings' + 'Opened yesterday',
    'Bookshop diorama' + 'Never opened',
  ])
  expect(document.querySelector('h2')?.textContent).toBe('Film grain tests')
  expect(document.querySelector('.dinkster-project-header')?.textContent).toContain('Opened 2 hours ago')
  expect(document.body.textContent).toContain('No workflows yet. Open the project to make one.')
  document.querySelectorAll<HTMLElement>('[role="option"]')[2]!.click()
  await settle()
  expect(document.querySelector('.dinkster-project-header')?.textContent).toContain('Never opened')
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

it('uses the live opening line in the footer until opening ends, even with a stopped engine read', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://localhost').pathname
    const body = path === '/supervisor/status' ? { state: 'stopped' }
      : path === '/supervisor/installations' ? { installations: [{ root: stable.root }] }
      : path === '/api/projects' ? { items: [], cursor: null }
      : { available: false, signedIn: false, canStartSignIn: false, signInUnavailableReason: 'account-unavailable', profile: null, signIn: { state: 'idle' } }
    return new Response(JSON.stringify(body))
  }))
  const [opening, setOpening] = createSignal<ReturnType<ProjectsPageShell['opening']>>()
  const dispose = render(() => <ProjectsPage shell={{ ...shell(), opening }} />, document.body)
  try {
    await settle()
    const status = () => document.querySelector('[data-testid="projects-engine-status"]')?.textContent
    expect(status()).toBe('No engine is running')
    for (const end of [undefined, { projectId: 'p-bookshop', line: 'Starting Nightly', failed: '' }]) {
      setOpening({ projectId: 'p-bookshop', line: 'Starting Stable' })
      expect(status()).toBe('Starting Stable')
      setOpening({ projectId: 'p-bookshop', line: 'Starting Nightly' })
      expect(status()).toBe('Starting Nightly')
      setOpening(end)
      expect(status()).toBe('No engine is running')
    }
  } finally {
    dispose()
  }
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
  expect(navigation.openProject).toHaveBeenCalledWith('p-valley', nightly, 'Valley matte paintings')
})

it('keeps outputs hidden for one project only, across page loads', async () => {
  const first = render(() => <ProjectsView shell={shell({ projectId: 'p-valley', line: 'Opening' })} source={source(projects)} />, document.body)
  await settle()
  const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(document.querySelector('[aria-label="valley.png"]')).not.toBeNull()
  const picture = document.querySelector<HTMLImageElement>('[aria-label="valley.png"] img')!
  expect(picture.getAttribute('src')).toBe('/api/assets/blake3%3A1/preview')
  picture.dispatchEvent(new Event('error'))
  expect(document.querySelector('[aria-label="valley.png"] img')).toBeNull()
  expect(document.querySelector('[aria-label="valley.png"]')?.textContent).toContain('valley.png')
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

it('keeps the chosen installation, starting contents and one project identity across a lost creation response', async () => {
  vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
  const [view, setView] = createSignal<ReturnType<ProjectsPageShell['view']>>({ kind: 'projects', newProject: true })
  const data = source(projects)
  const opened = vi.fn()
  let saved: LibraryProject | undefined
  const stored = new Map<string, LibraryProject>()
  const creations: ProjectCreation[] = []
  let installationsUnavailable = false
  const readInstallations = data.installations
  data.installations = () => installationsUnavailable
    ? Promise.reject(new Error('installation list unavailable'))
    : readInstallations()
  data.listProjects = async () => {
    if (installationsUnavailable) throw new Error('project list unavailable')
    return [...projects, ...stored.values()]
  }
  data.registerProject = async (id, name, creation = {}) => {
    creations.push(creation)
    const existing = stored.get(id)
    if (existing) return existing
    const created = project(id, name, new Date(NOW).toISOString())
    stored.set(id, created)
    if (!saved) {
      saved = created
      throw new Error('response lost after saving')
    }
    return created
  }
  data.renameProject = async (entry, name) => {
    const renamed = { ...entry, name, revision: entry.revision + 1 }
    stored.set(entry.id, renamed)
    return renamed
  }
  render(() => <ProjectsView shell={{ ...shell(), view, openProject: opened, showProjects: () => setView({ kind: 'projects', newProject: false }) }} source={data} />, document.body)
  await settle()
  const name = document.querySelector<HTMLInputElement>('#new-project-name')!
  name.value = 'My film'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  expect(document.querySelector('[data-testid="new-project-files"]')?.textContent).toBe('/configured/projects/my-film')
  button('Change')!.click()
  await settle()
  const folder = document.querySelector<HTMLInputElement>('dialog input')!
  folder.value = '/custom/My film files'
  folder.dispatchEvent(new Event('input', { bubbles: true }))
  button('Use this folder')!.click()
  document.querySelector<HTMLInputElement>('input[type="radio"][value="project"]')!.click()
  await settle()
  const installation = document.querySelector<HTMLButtonElement>('#new-project-runs-on')!
  installation.click()
  ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Nightly - this computer')!.click()
  button('Create')!.click()
  await settle()
  expect(document.body.textContent).toContain('Could not finish creating the project. Your choices are kept. Try again.')
  expect(name.value).toBe('My film')
  expect(installation.textContent).toBe('Nightly - this computer')
  expect(document.querySelector<HTMLInputElement>('input[type="radio"][value="empty"]')!.disabled).toBe(true)
  installationsUnavailable = true
  globalThis.dispatchEvent(new Event('focus'))
  await settle()
  expect(document.querySelector('#new-project-runs-on')!.textContent).toBe('Nightly - this computer')
  const copyLabel = [...document.querySelectorAll('label')].find((label) => label.htmlFor && label.textContent === 'Copy of a project')!
  const copy = document.getElementById(copyLabel.htmlFor) as HTMLButtonElement
  expect(copy.textContent).toBe('Film grain tests')
  name.value = 'My revised film'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  button('Create')!.click()
  await settle()
  expect(stored.size).toBe(1)
  expect(creations).toEqual([
    { filesFolder: '/custom/My film files', startWith: { kind: 'project', project: 'p-film' } },
    { filesFolder: '/custom/My film files', startWith: { kind: 'project', project: 'p-film' } },
  ])
  expect([...stored.values()][0]?.name).toBe('My revised film')
  expect(rows().filter((row) => row?.startsWith('My revised film'))).toHaveLength(1)
  expect(localStorage.getItem(`dinkster.p.${saved!.id}.projectsPage.runsOn`)).toBe(nightly.root)
  installationsUnavailable = false
  globalThis.dispatchEvent(new Event('focus'))
  await settle()
  document.querySelector<HTMLButtonElement>('[data-testid="projects-open"]')!.click()
  expect(opened).toHaveBeenCalledWith(saved!.id, nightly, 'My revised film')
})

it('refuses an invalid workflow file and preserves a valid file as the starting document', async () => {
  const data = source(projects)
  let created: ProjectCreation | undefined
  data.registerProject = async (id, name, creation) => {
    created = creation
    return project(id, name, new Date(NOW).toISOString())
  }
  render(() => <ProjectsView shell={{ ...shell(), view: () => ({ kind: 'projects', newProject: true }) }} source={data} />, document.body)
  await settle()
  const name = document.querySelector<HTMLInputElement>('#new-project-name')!
  name.value = 'Workflow project'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector<HTMLInputElement>('input[type="radio"][value="workflow"]')!.click()
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  const choose = async (content: string) => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([content], 'Scene.json', { type: 'application/json' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }
  await choose('{')
  expect(document.body.textContent).toContain('Choose a valid Dinkster workflow JSON file.')
  expect(button('Create')!.disabled).toBe(true)
  const content = JSON.stringify({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'source', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'Root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
    view: { graphs: { g0: { nodes: {} } } } }, null, 2) + '\n'
  await choose(content)
  expect(document.body.textContent).not.toContain('Choose a valid Dinkster workflow JSON file.')
  expect(button('Create')!.disabled).toBe(false)
  button('Create')!.click()
  await settle()
  expect(created).toEqual({ filesFolder: '/configured/projects/workflow-project', startWith: { kind: 'workflow', name: 'Scene', content } })
})

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
  expect(rows()).toContain('Film grain' + 'Opened 2 hours ago')
})

it('keeps the Delete consequence and selected project after a refused deletion', async () => {
  const data = source(projects)
  data.deleteProject = async () => { throw new RequestFailure('DELETE', '/api/projects/test', 409, 'Project changed. Try again.') }
  render(() => <ProjectsView shell={shell()} source={data} />, document.body)
  await settle()
  document.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click()
  menuItem('Delete')!.click()
  await settle()
  expect(document.activeElement).toBe(button('Cancel'))
  const consequence = document.querySelector('dialog .dinkster-description')!.textContent
  button('Delete project')!.click()
  await settle()
  expect(document.querySelector('dialog .dinkster-description')?.textContent).toBe(consequence)
  expect(document.querySelector('dialog')?.textContent).toContain('Project changed. Try again.')
  expect(document.querySelector('h2')?.textContent).toBe('Film grain tests')
  button('Cancel')!.click()
  await settle()
  expect(document.querySelector('dialog')).toBeNull()
  expect(rows()).toHaveLength(3)
})

it('moves a deleted project under Deleted projects, selects the next one, and restores it selected', async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const old = { ...project('p-old', 'Old storyboard', hoursAgo(24 * 40)), deleted: true, revision: 3, modified: new Date(NOW - 60_000).toISOString() }
  const data = source([...projects, old])
  const restored = vi.spyOn(data, 'restoreProject')
  render(() => <ProjectsView shell={shell()} source={data} />, document.body)
  await settle()
  const deletedRows = () => [...document.querySelectorAll('[data-testid="deleted-projects"] li')].map((row) => row.textContent)
  expect(rows()).toEqual(['Film grain testsOpened 2 hours ago', 'Valley matte paintingsOpened yesterday', 'Bookshop dioramaNever opened'])
  expect(document.querySelector('summary')?.textContent).toBe('Deleted projects (1)')
  expect(deletedRows()).toEqual(['Old storyboardDeleted 1 minute agoRestore'])

  document.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click()
  expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Rename', 'Delete'])
  menuItem('Delete')!.click()
  await settle()
  expect(document.querySelector('dialog')?.textContent).toContain('It moves to Deleted projects at the bottom of this list')
  button('Delete project')!.click()
  await settle()
  expect(rows().map((row) => row?.split(/Opened|Never opened/)[0])).toEqual(['Valley matte paintings', 'Bookshop diorama'])
  expect(document.querySelector('h2')?.textContent).toBe('Valley matte paintings')
  expect(deletedRows()).toEqual(['Film grain testsDeleted just nowRestore', 'Old storyboardDeleted 1 minute agoRestore'])

  ;[...document.querySelectorAll<HTMLButtonElement>('[data-testid="deleted-projects"] button')][1]!.click()
  await settle()
  expect(restored).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-old', revision: 3 }))
  expect(rows().map((row) => row?.split(/Opened|Never opened/)[0])).toContain('Old storyboard')
  expect(document.querySelector('h2')?.textContent).toBe('Old storyboard')
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Old storyboard')
  expect(deletedRows()).toEqual(['Film grain testsDeleted just nowRestore'])
})

it('keeps both projects when two restores complete together', async () => {
  const deleted = [
    { ...project('p-old-a', 'Old storyboard', hoursAgo(48)), deleted: true },
    { ...project('p-old-b', 'Old lighting', hoursAgo(24)), deleted: true },
  ]
  render(() => <ProjectsView shell={shell()} source={source([...projects, ...deleted])} />, document.body)
  await settle()
  document.querySelector('summary')!.click()
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-testid="deleted-projects"] button')) button.click()
  await settle()
  expect(rows().filter((row) => row?.startsWith('Old')).length).toBe(2)
  expect(document.querySelector('[data-testid="deleted-projects"]')).toBeNull()
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

it.each([
  { registered: false, libraryUnavailable: false },
  { registered: true, libraryUnavailable: false },
  { registered: true, libraryUnavailable: true },
])('keeps setup visible until an installation is complete (%j)', async ({ registered, libraryUnavailable }) => {
  let found: readonly PageInstallation[] = registered ? [stable] : []
  let settingUp = registered
  const counted = vi.fn()
  const data = {
    ...source([]),
    listProjects: async () => {
      if (settingUp && libraryUnavailable) throw new Error('Library helper paused during setup')
      return []
    },
    installations: async () => ({ all: found, settingUp }),
  }
  render(() => <ProjectsView shell={shell()} source={data} onCount={counted} />, document.body)
  await settle()
  expect(document.querySelector('[data-testid="setup-form"]')?.textContent).toContain('NVIDIA graphics card build')
  expect(document.querySelector('[data-testid="setup-form"]')?.textContent).toContain('/install/nightly')
  expect(document.querySelector('code')).toBeNull()
  expect(rows()).toEqual([])
  expect(counted).not.toHaveBeenCalled()
  found = [stable]
  settingUp = false
  window.dispatchEvent(new Event('focus'))
  await settle()
  expect(document.querySelector('[data-testid="setup-form"]')).toBeNull()
  expect(counted).toHaveBeenLastCalledWith(0)
})

it('does not suggest opening a project to create workflows without an installation', async () => {
  render(() => <ProjectsView shell={shell()} source={{ ...source(projects), installations: async () => ({ all: [] }) }} />, document.body)
  await settle()
  expect(document.body.textContent).toContain('No workflows yet.')
  expect(document.body.textContent).not.toContain('Open the project to make one.')
})

it('shows unlabeled workflows across library pages without including tagged non-workflows', async () => {
  const records = [
    { id: 'w1', name: 'Imported scene', mediaType: 'application/x-dinkster-workflow+json', labels: [] },
    { id: 'image', name: 'Reference image', mediaType: 'image/png', labels: ['workflow'] },
    { id: 'w2', name: 'Copied scene', mediaType: 'application/x-dinkster-workflow+json', labels: ['favorite'] },
  ].map((record) => ({ ...record, scope: 'local', project: 'p-film', digest: 'blake3:1', created: 1, modified: 1, revision: 1 }))
  const connection = new DinksterConnection({
    id: asConnectionId('projects-test'), baseUrl: 'http://test', clientId: 'projects-test',
    fetchFn: async (url) => {
      const query = new URL(url).searchParams
      const matching = records.filter((record) =>
        record.project === query.get('project') &&
        (!query.has('label') || record.labels.includes(query.get('label')!)) &&
        (!query.has('mediaType') || record.mediaType === query.get('mediaType')))
      const offset = Number(query.get('cursor') ?? 0)
      return new Response(JSON.stringify({ records: matching.slice(offset, offset + 1),
        cursor: offset + 1 < matching.length ? String(offset + 1) : null }))
    },
  })
  render(() => <ProjectsView shell={shell()} source={{ ...source(projects), listWorkflows: processSource(connection).listWorkflows }} />, document.body)
  await settle()
  await settle()
  expect([...document.querySelectorAll('.dinkster-tile-name')].map((name) => name.textContent)).toEqual(['Imported scene', 'Copied scene'])
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

it('shows the Files parent with an output fallback and offers local folder reveal only when available', async () => {
  const folder = '/home/u/Dinkster/library/output'
  const parent = '/home/u/Dinkster/library'
  const withFolder = [{ ...projects[1]!, folder, filesFolder: parent }, { ...projects[0]!, folder: null }]
  const data = source(withFolder)
  const opened = vi.spyOn(data, 'openFolder').mockRejectedValueOnce(new Error('POST failed: 404'))
  const facts = () => document.querySelector('[aria-label="About this project"]')?.textContent ?? ''
  const first = render(() => <ProjectsView shell={shell()} source={data} />, document.body)
  await settle()
  expect(facts()).toContain('Files' + parent)
  expect(facts()).not.toContain(folder)
  button('Show in folder')!.click()
  await settle()
  expect(opened).toHaveBeenCalledWith('p-film')
  expect(document.body.textContent).toContain('The folder could not be opened on this computer.')
  ;[...document.querySelectorAll('[role="option"]')].find((row) => row.textContent?.startsWith('Bookshop'))!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  expect(facts()).not.toContain('Files')
  first()
  document.body.replaceChildren()
  render(() => <ProjectsView shell={shell()} source={{ ...source([{ ...projects[1]!, folder }]), installations: async () => ({ all: [stable], openFolder: false }) }} />, document.body)
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

it('keeps the project name and exact template choice through picker cancellation, then creates from that document', async () => {
  const documentFor = (pack: string) => loadDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: pack, root: 'g0',
    graphs: { g0: { id: 'g0', name: 'Root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
    view: { graphs: { g0: { nodes: {} } } } }).document!
  const entries: CollectionEntry[] = ['photos', 'lines'].map((pack) => ({ id: `${pack}/starter`, title: `${pack} starter`,
    ref: { kind: 'local', pack, id: 'starter', template: { pack, id: 'starter', name: `${pack} starter`, digest: `sha256:${pack}` }, models: [] } }))
  let created: ProjectCreation | undefined
  const data: ProjectsSource = { ...source(projects), templates: async () => ({ entries, resolve: () => undefined,
    document: async (entry) => documentFor(entry === entries[0] ? 'photos' : 'lines') }),
    registerProject: async (id, name, creation) => { created = creation; return project(id, name, new Date(NOW).toISOString()) } }
  render(() => <ProjectsView shell={{ ...shell(), view: () => ({ kind: 'projects', newProject: true }) }} source={data} />, document.body)
  await settle()
  const name = document.querySelector<HTMLInputElement>('#new-project-name')!
  name.value = 'My template project'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector<HTMLInputElement>('input[type="radio"][value="template"]')!.click()
  expect(document.body.textContent).toContain('No template selected')
  expect(button('Create')!.disabled).toBe(true)
  button('Choose')!.click()
  await settle()
  const tile = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent?.includes(title))!
  tile('lines starter').click()
  button('Use template')!.click()
  await settle()
  expect(document.querySelector<HTMLInputElement>('#new-project-name')!.value).toBe('My template project')
  expect(document.querySelector('[role="group"][aria-label="Template"]')?.textContent).toContain('lines starter')
  expect(created).toBeUndefined()
  document.querySelector<HTMLButtonElement>('[role="group"][aria-label="Template"] button')!.click()
  await settle()
  tile('photos starter').click()
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
  search.value = 'photos'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  expect(search.value).toBe('photos')
  expect(tile('photos starter')).toBe(document.activeElement)
  tile('photos starter').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  expect(search.value).toBe('')
  expect(document.activeElement).toBe(search)
  expect(document.querySelector('[data-testid="project-template-picker"]')).not.toBeNull()
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('[role="group"][aria-label="Template"]')?.textContent).toContain('lines starter')
  button('Create')!.click()
  await settle()
  expect(created?.startWith?.kind).toBe('workflow')
  expect(created?.startWith).toMatchObject({ kind: 'workflow', name: 'lines starter' })
  expect(JSON.parse((created!.startWith as { content: string }).content).lineage).toBe('lines')
})

it('revokes a pending template choice when the feature turns off without creating a project', async () => {
  let enabled = true
  let complete!: (document: WorkflowDocument | undefined) => void
  const body = new Promise<WorkflowDocument | undefined>((resolve) => { complete = resolve })
  let created = false
  const entry: CollectionEntry = { id: 'demo/starter', title: 'Starter',
    ref: { kind: 'local', pack: 'demo', id: 'starter', template: { pack: 'demo', id: 'starter', name: 'Starter', digest: 'sha256:starter' }, models: [] } }
  const data: ProjectsSource = { ...source(projects), templates: async () => enabled ? { entries: [entry], resolve: () => undefined, document: () => body } : undefined,
    registerProject: async (id, name) => { created = true; return project(id, name, new Date(NOW).toISOString()) } }
  render(() => <ProjectsView shell={{ ...shell(), view: () => ({ kind: 'projects', newProject: true }) }} source={data} />, document.body)
  await settle()
  document.querySelector<HTMLInputElement>('input[type="radio"][value="template"]')!.click()
  button('Choose')!.click()
  await settle()
  button('Use template')!.click()
  button('Use template')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('[data-testid="project-template-picker"]')).not.toBeNull()
  enabled = false
  window.dispatchEvent(new Event('focus'))
  await settle()
  complete(loadDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'revoked', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'Root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
    view: { graphs: { g0: { nodes: {} } } } }).document)
  await settle()
  expect(document.querySelector('[data-testid="project-template-picker"]')).toBeNull()
  expect(document.querySelector('input[type="radio"][value="template"]')).toBeNull()
  expect(document.body.textContent).not.toContain('Starter')
  expect(created).toBe(false)
})
