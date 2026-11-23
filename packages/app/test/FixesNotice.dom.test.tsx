// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import { asGraphDefId, asLineageId, asNodeId, setLocale, type WorkflowDocument } from '@dinkster/core'
import { AppState, type Tab } from '../src/app-state.js'
import { FixesNotice } from '../src/FixesNotice.js'
import { prepareWorkflowApp } from './fixtures/workflow-app.js'

const nodesNamed = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => {
  const id = `n${index + 1}`
  return [id, { id: asNodeId(id), type: 'Previous', title: `Old ${index + 1}`, values: { oldAmount: index } }]
}))

/** A workflow whose `count` nodes all have a newer replacement on open. */
const outdated = (count: number): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId(`notice-${count}`), root: asGraphDefId('g0'),
  graphs: { g0: {
    id: asGraphDefId('g0'), name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: count + 1,
    nodes: nodesNamed(count),
  } },
  view: { graphs: {} },
})

async function openOutdated(count: number): Promise<{ app: AppState; tab: Tab; root: HTMLElement; unmount: () => void }> {
  const app = prepareWorkflowApp(new AppState())
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'notice-test', schemaWire: 2 }, packs: {},
    nodes: { Current: {
      body: [{ kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 7 }],
      replacements: [{ from: 'Previous', cases: [{ to: 'Current', inputs: { amount: { kind: 'copy', input: 'oldAmount' } } }] }],
    } },
  }))
  expect(await app.openDocument(outdated(count), 'Outdated')).toEqual([])
  const tab = app.activeTab()!
  if (count > 0) await vi.waitFor(() => expect(app.adjustmentNotices.get().has(tab.id)).toBe(true))
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <FixesNotice app={app} tab={app.tabs.get().find((candidate) => candidate.id === tab.id)!} />, root)
  return { app, tab, root, unmount }
}

const button = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name)
const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('.dinkster-fixes-review-row')]
const types = (tab: Tab) => Object.values(tab.store.doc.graphs.g0!.nodes).map((node) => node.type)

afterEach(() => {
  document.body.replaceChildren()
  setLocale('en')
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('the notice of the editor\'s own fixes', () => {
  it('reports twelve replacements on open in one line, groups them, goes to a node and takes all twelve back in one step', async () => {
    const { app, tab, root, unmount } = await openOutdated(12)
    expect(types(tab)).toEqual(Array(12).fill('Current'))
    expect(root.querySelector('.dinkster-fixes-title')?.textContent).toBe('12 things were adjusted')
    button(root, 'Review')!.click()
    expect([...root.querySelectorAll('.dinkster-fixes-review-kind')].map((kind) => kind.textContent)).toEqual(['Nodes replaced by newer ones (12)'])
    expect(rows(root)).toHaveLength(12)
    const before = tab.store.doc
    rows(root)[3]!.click()
    expect(app.diagnosticFocus.get()?.anchor.occurrence?.node).toBe('n4')
    expect(tab.store.doc).toBe(before)
    button(root, 'Undo')!.click()
    expect(types(tab)).toEqual(Array(12).fill('Previous'))
    expect(root.querySelector('.dinkster-fixes-title')?.textContent).toBe('Adjustments undone')
    // One undo step puts all twelve back.
    expect(tab.store.undo()).toBe(true)
    expect(types(tab)).toEqual(Array(12).fill('Current'))
    unmount()
    app.dispose()
  })

  it.each([[10, false], [11, true]])('lists %i changes one row per node, grouped by kind=%s', async (count, grouped) => {
    const { app, root, unmount } = await openOutdated(count)
    button(root, 'Review')!.click()
    expect(rows(root)).toHaveLength(count)
    expect(root.querySelectorAll('.dinkster-fixes-review-kind')).toHaveLength(grouped ? 1 : 0)
    expect(root.querySelector('.dinkster-fixes-review-heading')?.textContent).toContain(`${count} adjustments across ${count} nodes`)
    unmount()
    app.dispose()
  })

  it('adds a change arriving while Review is open without losing the chosen row, and Undo leaves edits in between alone', async () => {
    const { app, tab, root, unmount } = await openOutdated(12)
    button(root, 'Review')!.click()
    rows(root)[2]!.click()
    const list = root.querySelector('.dinkster-fixes-review-list')!
    expect(tab.store.dispatch({ command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Renamed by hand' } }).ok).toBe(true)
    const late = tab.store.dispatch({ command: 'node.setValues', params: { graphId: 'g0', nodeId: 'n12', values: { amount: 99 } } })
    if (!late.ok) throw new Error('late change refused')
    app.reportAdjustments(tab, late, [{ kind: 'removedChoice', graphId: 'g0', nodeId: 'n12', node: 'Old 12', details: ['amount: 11 to 99'], count: 1 }])
    await Promise.resolve()
    expect(root.querySelector('.dinkster-fixes-title')?.textContent).toBe('13 things were adjusted')
    expect(root.querySelector('.dinkster-fixes-review-list')).toBe(list)
    expect(rows(root)[2]!.getAttribute('aria-current')).toBe('true')
    expect([...root.querySelectorAll('.dinkster-fixes-review-kind')].map((kind) => kind.textContent))
      .toEqual(['Nodes replaced by newer ones (12)', 'Removed choices replaced (1)'])
    button(root, 'Undo')!.click()
    expect(types(tab)).toEqual(Array(12).fill('Previous'))
    expect(tab.store.doc.graphs.g0!.nodes.n12!.values).toEqual({ oldAmount: 11 })
    expect(tab.store.doc.graphs.g0!.nodes.n1!.title).toBe('Renamed by hand')
    unmount()
    app.dispose()
  })

  it('keeps a node whose adjusted value the user changed since, puts back the rest, and says how many it kept', async () => {
    const { app, tab, root, unmount } = await openOutdated(3)
    expect(tab.store.dispatch({ command: 'node.setValues', params: { graphId: 'g0', nodeId: 'n2', values: { amount: 50 } } }).ok).toBe(true)
    button(root, 'Undo')!.click()
    expect(types(tab)).toEqual(['Previous', 'Current', 'Previous'])
    expect(tab.store.doc.graphs.g0!.nodes.n2!.values).toEqual({ amount: 50 })
    expect(root.querySelector('.dinkster-fixes-title')?.textContent).toBe('Adjustments undone. 1 node you changed since was kept.')
    button(root, 'Redo adjustments')!.click()
    expect(types(tab)).toEqual(Array(3).fill('Current'))
    expect(root.querySelector('.dinkster-fixes-title')?.textContent).toBe('3 things were adjusted')
    unmount()
    app.dispose()
  })

  it('closes only Review on Escape and leaves a count after the cross until the workflow is cleared', async () => {
    const { app, tab, root, unmount } = await openOutdated(3)
    button(root, 'Review')!.click()
    root.querySelector('.dinkster-fixes-review-row')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(root.querySelector('.dinkster-fixes-review')).toBeNull()
    expect(root.querySelector('.dinkster-fixes-line')).not.toBeNull()
    button(root, 'Dismiss')!.click()
    expect(root.querySelector('.dinkster-fixes-line')).toBeNull()
    expect(app.adjustmentNotices.get().get(tab.id)?.dismissed).toBe(true)
    app.reopenAdjustmentNotice(tab.id)
    await Promise.resolve()
    expect(root.querySelector('.dinkster-fixes-review')).not.toBeNull()
    button(root, 'Automatic fixes...')!.click()
    expect(app.modalPanel.get()).toBe('settings')
    expect(app.settingsOpenRequest.get()).toEqual({ category: 'execution', id: 'execution.reviewUpgrades' })
    app.clearAdjustmentNotice(tab.id)
    await Promise.resolve()
    expect(root.querySelector('.dinkster-fixes-notice')).toBeNull()
    expect(types(tab)).toEqual(Array(3).fill('Current'))
    unmount()
    app.dispose()
  })

  it('shows nothing for a workflow that needed no change', async () => {
    const { app, tab, root, unmount } = await openOutdated(0)
    await Promise.resolve()
    expect(app.adjustmentNotices.get().has(tab.id)).toBe(false)
    expect(root.querySelector('.dinkster-fixes-notice')).toBeNull()
    unmount()
    app.dispose()
  })
})
