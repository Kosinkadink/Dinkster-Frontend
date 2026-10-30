import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { asPromptId, diag, type DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { App } from '../src/App.js'
import { AppState, GLOBAL_PROBLEMS_OWNER } from '../src/app-state.js'

vi.mock('../src/CanvasHost.js', async (original) => ({
  ...await original<typeof import('../src/CanvasHost.js')>(),
  CanvasHost: () => <div data-testid="canvas-stub" />,
}))

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
})

function fixture(clean = false) {
  const app = new AppState()
  const backend = app.backends.get()[0]!
  const payload: DinksterNodesPayload = {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'queue-test', schemaWire: 1 },
    nodes: {
      EmptyImage: {
        schemaVersion: 1, nodeType: 'EmptyImage', displayName: 'Empty Image', category: 'test',
        interface: [
          ...['width', 'height', 'batch_size', 'color'].map((id) => ({
            role: 'input' as const, id, type: { kind: 'concrete' as const, types: ['INT'] }, required: false,
          })),
          { role: 'output', id: 'out0', type: { kind: 'concrete', types: ['IMAGE'] } },
        ],
      },
      PreviewImage: {
        schemaVersion: 1, nodeType: 'PreviewImage', displayName: 'Preview Image', category: 'test', outputNode: true,
        interface: [{ role: 'input', id: 'images', type: { kind: 'concrete', types: ['IMAGE'] }, required: true }],
      },
    },
  }
  backend.registry.set(buildDinksterRegistry(backend.id, payload))
  const doc = JSON.parse(readFileSync(resolve('test/fixtures/unresolved-output-dependency.json'), 'utf8'))
  if (clean) {
    delete doc.graphs.g0.nodes.n1
    delete doc.graphs.g0.links.l1
    doc.graphs.g0.links.l0.to = { node: 'n2', port: 'images' }
  }
  app.openDocument(doc, 'Queue feedback')
  const root = document.createElement('div')
  document.body.append(root)
  dispose = render(() => <App app={app} />, root)
  const queue = root.querySelector<HTMLButtonElement>('[data-testid="queue-button"]')!
  expect(queue.disabled).toBe(false)
  return { app, backend, root, queue }
}

it('pressing Queue on an invalid graph shows the Problems summary and opens its hidden panel', async () => {
  const { app, root, queue } = fixture()
  app.dock.setOpen('right', false)
  app.reportProblems(GLOBAL_PROBLEMS_OWNER, [
    diag('warning', 'validation', 'warning.one', 'First advisory'),
    diag('warning', 'validation', 'warning.two', 'Second advisory'),
    diag('info', 'validation', 'info.one', 'First note'),
    diag('info', 'validation', 'info.two', 'Second note'),
    diag('info', 'validation', 'info.three', 'Third note'),
  ])
  expect(root.querySelector('[data-testid="queue-refusal-toast"]')).toBeNull()
  expect(app.dock.state.get().zones.right.open).toBe(false)
  queue.click()
  await vi.waitFor(() => expect(root.querySelector('[data-testid="queue-refusal-toast"]')).not.toBeNull())
  const toast = root.querySelector('[data-testid="queue-refusal-toast"]')!
  expect(app.problems.get().some((problem) => problem.severity === 'error')).toBe(true)
  expect(toast.textContent).toContain('Workflow not queued')
  expect(toast.textContent).toContain('6 problems, worst severity error')
  expect(toast.textContent).toContain('Errors: 1; warnings: 2; info: 3')
  const open = [...toast.querySelectorAll('button')].find((button) => button.textContent === 'Show Problems')!
  open.click()
  await vi.waitFor(() => expect(root.querySelector('[data-testid="problems-panel"]')).not.toBeNull())
  expect(app.dock.state.get().zones.right.open).toBe(true)
  expect(root.querySelector('[data-testid="problems-panel"]')!.closest('[role="tabpanel"]')!.hasAttribute('hidden')).toBe(false)
  expect(root.querySelector('[data-testid="queue-refusal-toast"]')).toBeNull()
})

it('pressing Queue on a clean graph submits without a refusal toast', async () => {
  const { app, backend, root, queue } = fixture(true)
  app.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag('warning', 'validation', 'advisory', 'Not a queue blocker')])
  const tab = app.activeTab()!
  expect(app.compileTab(tab)?.ok).toBe(true)
  vi.spyOn(backend.connection, 'submit').mockResolvedValue({
    ok: true, execution: { connection: backend.id, prompt: asPromptId('queue-clean') },
  })
  queue.click()
  await vi.waitFor(() => expect(app.executionsForTab(tab)).toHaveLength(1))
  expect(root.querySelector('[data-testid="queue-refusal-toast"]')).toBeNull()
})
