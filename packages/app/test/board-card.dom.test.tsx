import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyBoard, exposedKey, type BoardCardItem, type NodeSchema } from '@dinkster/core'
import { BoardCard } from '../src/BoardCard.js'
import { WORKFLOW_MEDIA_TYPE } from '../src/app-state.js'
import { activeProjectId } from '../src/projects.js'
import { useSignal } from '../src/solid-adapter.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('refreshes saved-source controls, drops hidden values made fixed, and ignores superseded source replies', async () => {
  const schema: NodeSchema = { type: 'CardControls', displayName: 'Controls', category: 'test', source: 'v3', isOutputNode: true,
    body: ['seed', 'amount'].map((id) => ({ kind: 'input', id, optional: false, type: { kind: 'concrete', name: 'INT' },
      widget: { widgetType: 'INT', options: { min: 0, max: 100, step: 1 }, controller: 'after_generate' } })),
  }
  const app = createWorkflowApp([schema])
  const backend = app.backends.get()[0]!
  const input = (inputId: string) => ({ graphId: 'g0', nodeId: 'n0', inputId })
  let source = { format: 'dinkster-workflow', formatVersion: 1, lineage: 'source', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'Controls', nodes: { n0: { id: 'n0', type: schema.type,
      values: { seed: 7, amount: 5 }, controllers: { seed: 'increment', amount: 'fixed' },
    } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
    view: { graphs: { g0: { nodes: {} } } }, ext: { 'dinkster.exposed': [input('amount')] },
  }
  vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue({ id: 'controls', scope: 'local', name: 'Controls',
    digest: `blake3:${'a'.repeat(64)}`, mediaType: WORKFLOW_MEDIA_TYPE, labels: ['workflow'], created: 1, modified: 1, revision: 1 })
  const fetch = vi.spyOn(backend.connection, 'fetchAssetText').mockImplementation(async () => JSON.stringify(source))
  const board = app.boards.open(emptyBoard(), 'Controls', backend.baseUrl)
  const id = await app.boards.placeCard(board.id, { project: activeProjectId(), baseUrl: backend.baseUrl,
    kind: 'workflow', source: { kind: 'library', recordId: 'controls' }, name: 'Controls' }, { x: 0, y: 0 })
  board.session.dispatch({ command: 'board.card.inputs', params: { id, values: {
    [exposedKey(input('seed'))]: 13, [exposedKey(input('amount'))]: 17,
  } } })
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => {
    const doc = useSignal(board.session.document)
    return <BoardCard app={app} entry={board} card={doc().items[id] as BoardCardItem}
      onOpen={() => undefined} onChooseInputs={() => undefined} onRemove={() => undefined} />
  }, root)
  const values = () => [...root.querySelectorAll<HTMLInputElement>('[role="spinbutton"]')].map((input) => input.value)
  try {
    await vi.waitFor(() => expect(values()).toEqual(['17']))
    const modeButton = () => root.querySelector<HTMLButtonElement>('[aria-label="After run for amount"]')!
    modeButton().click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="seed-controller-fixed"]')?.getAttribute('aria-checked')).toBe('true'))
    document.querySelector<HTMLButtonElement>('[data-testid="seed-controller-increment"]')!.click()
    expect(document.querySelector('[data-testid="seed-controller-menu"]')).toBeNull()
    expect(document.activeElement).toBe(modeButton())
    expect((board.session.doc.items[id] as BoardCardItem).controllers).toEqual({ [exposedKey(input('amount'))]: 'increment' })
    expect(source.graphs.g0.nodes.n0.controllers.amount).toBe('fixed')
    source = { ...source, graphs: { g0: { ...source.graphs.g0, nodes: { n0: { ...source.graphs.g0.nodes.n0,
      values: { seed: 41, amount: 23 }, controllers: { seed: 'fixed', amount: 'fixed' },
    } } } } }
    app.backendsTick.update((value) => value + 1)
    await vi.waitFor(() => expect((board.session.doc.items[id] as BoardCardItem).values[exposedKey(input('seed'))]).toBeUndefined())
    expect(values()).toEqual(['17'])
    source = { ...source, ext: { 'dinkster.exposed': [input('seed'), input('amount')] } }
    app.backendsTick.update((value) => value + 1)
    await vi.waitFor(() => expect(values()).toEqual(['41', '17']))
    let release!: (text: string) => void
    let entered!: () => void
    const loading = new Promise<void>((resolve) => { entered = resolve })
    fetch.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve }) })
    app.backendsTick.update((value) => value + 1)
    await loading
    const stale = JSON.stringify(source)
    source = { ...source, graphs: { g0: { ...source.graphs.g0, nodes: { n0: { ...source.graphs.g0.nodes.n0,
      values: { seed: 91, amount: 29 },
    } } } } }
    app.backendsTick.update((value) => value + 1)
    await vi.waitFor(() => expect(values()).toEqual(['91', '17']))
    release(stale)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(values()).toEqual(['91', '17'])
    expect(source.graphs.g0.nodes.n0.values).toEqual({ seed: 91, amount: 29 })
    modeButton().click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="seed-controller-increment"]')?.getAttribute('aria-checked')).toBe('true'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('[data-testid="seed-controller-menu"]')).toBeNull()
    board.session.dispatch({ command: 'board.card.input', params: { id, input: input('amount') } })
    await vi.waitFor(() => expect(values()).toEqual(['91', '29']))
    modeButton().click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="seed-controller-fixed"]')?.getAttribute('aria-checked')).toBe('true'))
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('[data-testid="seed-controller-menu"]')).toBeNull()
    modeButton().click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="seed-controller-fixed"]')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('[data-testid="seed-controller-fixed"]')!.click()
    source = { ...source, graphs: { g0: { ...source.graphs.g0, nodes: { n0: { ...source.graphs.g0.nodes.n0,
      controllers: { seed: 'fixed', amount: 'decrement' },
    } } } } }
    app.backendsTick.update((value) => value + 1)
    await vi.waitFor(() => expect(values()).toEqual(['91', '29']))
    modeButton().click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="seed-controller-decrement"]')?.getAttribute('aria-checked')).toBe('true'))
  } finally { dispose(); app.dispose() }
})
