// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asNodeId,
  createSignal,
  diag,
  registerCatalog,
  setLocale,
  type Diagnostic,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import type { AppState, DiagnosticFocusRequest, Tab } from '../src/app-state.js'
import { ProblemsPanel } from '../src/ProblemsPanel.js'
import { shortcutSuppressed } from '../src/settings.js'

const schema: NodeSchema = {
  type: 'Sampler', displayName: 'KSampler', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'model', displayName: 'Model input', type: { kind: 'concrete', name: 'MODEL' }, optional: false }],
}

const workflow: WorkflowDocument = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('lineage-dom'), root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'), name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      nodes: {
        n1: { id: asNodeId('n1'), type: 'Sampler', title: 'Error sampler', values: {} },
        n2: { id: asNodeId('n2'), type: 'Sampler', title: 'Warning sampler', values: {} },
      },
    },
  },
  view: { graphs: {} },
}

const diagnostics: readonly Diagnostic[] = [
  diag('error', 'runtime', 'runtime.exploded', 'a very long runtime message that remains selectable', {
    refs: [{ graphId: 'g0', nodeId: 'n1' }],
    anchor: { occurrence: { instancePath: [], node: asNodeId('n1') } },
    runtime: {
      exceptionType: 'RuntimeError', exceptionMessage: 'exploded',
      hints: [{ code: 'repair', message: 'Select this complete repair hint before collapsing the group.' }],
      traceback: ['traceback line'],
    },
  }),
  diag('warning', 'schema', 'solve.linkMismatch', 'warning detail', {
    refs: [{ graphId: 'g0', nodeId: 'n2', portId: 'model', direction: 'input' }],
    anchor: { port: { node: asNodeId('n2'), port: 'model' as never } },
    runtime: {
      exceptionType: 'Warning', exceptionMessage: 'warning detail',
      hints: [{ code: 'warning-help', message: 'Nested warning guidance.' }],
      traceback: ['warning traceback'],
    },
  }),
]

function mountPanel(
  onShowInContext?: (diagnostic: Diagnostic) => void,
  panelDiagnostics: () => readonly Diagnostic[] = () => diagnostics,
  compatSkips: () => readonly { readonly packId: string; readonly nodeId: string; readonly reason: string }[] = () => [],
) {
  const tab = {
    id: 'tab-dom', store: { doc: workflow },
    graphStack: createSignal<readonly string[]>(['g0']), instancePath: createSignal<readonly string[]>([]),
  } as unknown as Tab
  const diagnosticFocus = createSignal<DiagnosticFocusRequest | undefined>(undefined)
  const app = {
    tabs: createSignal<readonly Tab[]>([tab]),
    activeTabId: createSignal(tab.id),
    diagnosticFocus,
    activeTab: () => tab,
    registryForTab: () => ({ resolve: (type: string) => type === 'Sampler' ? schema : undefined }),
  } as unknown as AppState
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => (
    <ProblemsPanel app={app} diagnostics={panelDiagnostics} compatSkips={compatSkips}
      {...(onShowInContext === undefined ? {} : { onShowInContext })} />
  ), root)
  return { app, diagnosticFocus, root, unmount }
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  setLocale('en')
})

describe('ProblemsPanel browser interactions', () => {
  it('updates mounted static chrome while preserving disclosure nodes and raw diagnostics', () => {
    registerCatalog('de-DE', {
      'shell.panel.problems.title': '[Probleme]',
      'problems.action.showInFocused': '[Im Fokus zeigen]',
      'problems.action.showOnCanvas': '[Auf Leinwand zeigen]',
      'problems.compat.advisory': '[HINWEIS]',
      'problems.compat.description': '[Nicht in den Katalog aufgenommen.]',
      'problems.compat.title': '[Kompatibilitatssprunge]',
      'problems.empty': '[Keine Probleme.]',
      'problems.hint.code': '[Diagnosecode: {code}]',
    })
    const panelDiagnostics = createSignal<readonly Diagnostic[]>(diagnostics)
    const compatSkips = createSignal([{ packId: 'raw-pack', nodeId: 'RawNode', reason: 'raw refusal reason' }])
    const shown: Diagnostic[] = []
    const { root, unmount } = mountPanel((diagnostic) => shown.push(diagnostic), panelDiagnostics.get, compatSkips.get)
    const panel = root.querySelector<HTMLElement>('[data-testid="problems-panel"]')!
    const group = root.querySelector<HTMLElement>('.problems-group')!
    const details = root.querySelector<HTMLDetailsElement>('details.problem')!
    const hint = root.querySelector<HTMLElement>('.runtime-error-hint')!
    details.querySelector('summary')!.click()
    expect(details.open).toBe(true)

    setLocale('de-DE')

    expect(root.querySelector('h2')!.textContent).toBe('[Probleme]')
    expect(root.querySelector<HTMLButtonElement>('.problem-show-on-canvas')!.textContent).toBe('[Auf Leinwand zeigen]')
    expect(root.querySelector<HTMLButtonElement>('.problem-show-in-context')!.textContent).toBe('[Im Fokus zeigen]')
    expect(root.querySelector<HTMLElement>('.compat-skips-group')!.getAttribute('aria-label')).toBe('[Kompatibilitatssprunge]')
    expect(root.querySelector<HTMLElement>('.compat-skips-group .problems-group-title')!.textContent).toBe('[Kompatibilitatssprunge]')
    expect(root.querySelector<HTMLElement>('.compat-skips-group .problems-group-severity')!.textContent).toBe('[HINWEIS]')
    expect(root.querySelector<HTMLElement>('.compat-skips-explanation')!.textContent).toBe('[Nicht in den Katalog aufgenommen.]')
    expect(root.querySelector<HTMLElement>('.runtime-error-hint-code')!.getAttribute('aria-label')).toBe('[Diagnosecode: repair]')
    expect(root.querySelector<HTMLElement>('.runtime-error-hint-code')!.getAttribute('data-tooltip-label')).toBe('[Diagnosecode: repair]')
    expect(root.textContent).toContain('runtime.exploded')
    expect(root.textContent).toContain('a very long runtime message that remains selectable')
    expect(root.textContent).toContain('Select this complete repair hint before collapsing the group.')
    expect(root.textContent).toContain('raw-pack: RawNode')
    expect(root.textContent).toContain('raw refusal reason')
    expect(root.querySelector('[data-testid="problems-panel"]')).toBe(panel)
    expect(root.querySelector('.problems-group')).toBe(group)
    expect(root.querySelector('details.problem')).toBe(details)
    expect(root.querySelector('.runtime-error-hint')).toBe(hint)
    expect(details.open).toBe(true)
    expect(shown).toEqual([])

    unmount()
    document.body.replaceChildren()
    setLocale('en')
    const empty = mountPanel(undefined, () => [], () => [])
    const emptyState = empty.root.querySelector<HTMLElement>('.empty')!
    expect(emptyState.textContent).toBe('None.')
    setLocale('de-DE')
    expect(empty.root.querySelector('.empty')).toBe(emptyState)
    expect(emptyState.textContent).toBe('[Keine Probleme.]')
    empty.unmount()
  })

  it('keeps group and diagnostic disclosure native and separates canvas activation', () => {
    const { diagnosticFocus, root, unmount } = mountPanel()
    const groupButtons = root.querySelectorAll<HTMLButtonElement>('.problems-group-header')
    expect(groupButtons).toHaveLength(2)
    groupButtons[0]!.click()
    expect(groupButtons[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelectorAll<HTMLElement>('.problems-group-items')[0]!.hidden).toBe(true)
    groupButtons[0]!.click()
    expect(groupButtons[0]!.getAttribute('aria-expanded')).toBe('true')

    const details = root.querySelectorAll<HTMLDetailsElement>('details.problem')
    const errorSummary = details[0]!.querySelector('summary')!
    const warningSummary = details[1]!.querySelector('summary')!
    errorSummary.click()
    warningSummary.click()
    expect(details[0]!.open).toBe(true)
    expect(details[1]!.open).toBe(true)
    expect(details[1]!.textContent).toContain('Nested warning guidance.')
    expect(diagnosticFocus.get()).toBeUndefined()

    errorSummary.click()
    warningSummary.click()
    expect(details[0]!.open).toBe(false)
    expect(details[1]!.open).toBe(false)
    expect(diagnosticFocus.get()).toBeUndefined()

    errorSummary.click()
    details[0]!.querySelector<HTMLButtonElement>('.problem-show-on-canvas')!.click()
    expect(diagnosticFocus.get()).toMatchObject({ anchor: diagnostics[0]!.anchor })
    unmount()
  })

  it('offers Show in Focused beside Show on canvas only when the host wires it', () => {
    const plain = mountPanel()
    expect(plain.root.querySelector('.problem-show-in-context')).toBeNull()
    plain.unmount()
    document.body.replaceChildren()

    const shown: Diagnostic[] = []
    const { root, unmount } = mountPanel((diagnostic) => shown.push(diagnostic))
    // Both fixture diagnostics have owning anchors, so both rows offer it.
    const buttons = root.querySelectorAll<HTMLButtonElement>('.problem-show-in-context')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.textContent).toBe('Show in Focused')
    buttons[0]!.click()
    expect(shown).toEqual([diagnostics[0]])
    unmount()
  })

  it('preserves selected detail text across disclosure and leaves copy native inside Problems', () => {
    const { diagnosticFocus, root, unmount } = mountPanel()
    const details = root.querySelector<HTMLDetailsElement>('details.problem')!
    details.querySelector('summary')!.click()
    const summary = details.querySelector<HTMLElement>('summary')!
    const range = document.createRange()
    range.selectNodeContents(summary)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const selected = selection.toString()

    const selectStart = new Event('selectstart', { bubbles: true, cancelable: true })
    const pointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    const pointerMove = new PointerEvent('pointermove', { bubbles: true, cancelable: true })
    const pointerUp = new PointerEvent('pointerup', { bubbles: true, cancelable: true })
    summary.dispatchEvent(selectStart)
    summary.dispatchEvent(pointerDown)
    summary.dispatchEvent(pointerMove)
    summary.dispatchEvent(pointerUp)
    expect([selectStart, pointerDown, pointerMove, pointerUp].every((event) => !event.defaultPrevented)).toBe(true)
    expect(selection.toString()).toBe(selected)
    expect(details.open).toBe(true)
    expect(diagnosticFocus.get()).toBeUndefined()

    let canvasCopies = 0
    const routeCanvasCopy = (event: KeyboardEvent): void => {
      if (shortcutSuppressed(event)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        canvasCopies += 1
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', routeCanvasCopy)
    const problemsCopy = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
    summary.dispatchEvent(problemsCopy)
    expect(problemsCopy.defaultPrevented).toBe(false)
    expect(canvasCopies).toBe(0)

    const canvas = document.createElement('div')
    document.body.append(canvas)
    canvas.tabIndex = 0
    canvas.focus()
    expect(document.activeElement).toBe(canvas)
    const canvasCopy = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true })
    canvas.dispatchEvent(canvasCopy)
    expect(canvasCopy.defaultPrevented).toBe(false)
    expect(canvasCopies).toBe(0)

    selection.removeAllRanges()
    const canvasCopyWithoutTextSelection = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true })
    canvas.dispatchEvent(canvasCopyWithoutTextSelection)
    expect(canvasCopyWithoutTextSelection.defaultPrevented).toBe(true)
    expect(canvasCopies).toBe(1)
    window.removeEventListener('keydown', routeCanvasCopy)
    unmount()
  })
})
