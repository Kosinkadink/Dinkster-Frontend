// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
  asRerouteId,
  asSelectorCandidateId,
  asSelectorId,
  asValueSourceId,
  createSignal,
  diag,
  registerCatalog,
  setLocale,
  type Diagnostic,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import type {
  AppState,
  CanvasSelectionSnapshot,
  DiagnosticFocusRequest,
  Tab,
  WidgetFocus,
} from '../src/app-state.js'
import { EMPTY_CANVAS_SELECTION } from '../src/app-state.js'
import { ContextPanel } from '../src/ContextPanel.js'

const schema: NodeSchema = {
  type: 'Sampler', displayName: 'KSampler', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'steps', displayName: 'Steps', type: { kind: 'concrete', name: 'INT' }, optional: false }],
}

const workflow: WorkflowDocument = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('lineage-ctx'), root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'), name: 'root', links: {
        'raw-link-tap': {
          id: asLinkId('raw-link-tap'),
          from: { node: asNodeId('n1'), tap: asPortId('raw-tap') },
          to: { reroute: asRerouteId('raw-reroute') },
        },
        'raw-link-value': {
          id: asLinkId('raw-link-value'),
          from: { valueSource: asValueSourceId('raw-value') },
          to: { selector: asSelectorId('raw-selector'), candidate: asSelectorCandidateId('raw-candidate') },
        },
      }, nets: {}, reroutes: {}, nextOrdinal: 3,
      nodes: {
        n1: { id: asNodeId('n1'), type: 'Sampler', title: 'First sampler', values: {} },
        n2: { id: asNodeId('n2'), type: 'Sampler', title: 'Second sampler', values: {} },
      },
    },
    g1: {
      id: asGraphDefId('g1'), name: 'raw-subgraph-name', links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      nodes: {},
    },
  },
  view: { graphs: {} },
}

const problemOn = (node: string, code: string): Diagnostic =>
  diag('error', 'schema', code, `problem on ${node}`, {
    anchor: { occurrence: { instancePath: [], node: asNodeId(node) } },
  })

const stepsProblem: Diagnostic = diag('warning', 'schema', 'value.range', 'steps out of range', {
  anchor: { port: { node: asNodeId('n1'), port: 'steps' as never } },
})

const diagnostics: readonly Diagnostic[] = [problemOn('n1', 'node.first'), problemOn('n2', 'node.second'), stepsProblem]
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function mountContextPanel() {
  const document_ = createSignal<WorkflowDocument>(workflow)
  const tab = {
    id: 'tab-ctx', title: 'My workflow',
    store: { doc: workflow, document: document_ },
    graphStack: createSignal<readonly string[]>(['g0']),
    instancePath: createSignal<readonly string[]>([]),
  } as unknown as Tab
  const canvasSelection = createSignal<CanvasSelectionSnapshot>(EMPTY_CANVAS_SELECTION)
  const widgetFocus = createSignal<WidgetFocus | undefined>(undefined)
  const diagnosticFocus = createSignal<DiagnosticFocusRequest | undefined>(undefined)
  const app = {
    tabs: createSignal<readonly Tab[]>([tab]),
    activeTabId: createSignal(tab.id),
    canvasSelection,
    widgetFocus,
    canvasBridge: createSignal(undefined),
    diagnosticFocus,
    activeTab: () => tab,
    registryForTab: () => ({ resolve: (type: string) => type === 'Sampler' ? schema : undefined }),
  } as unknown as AppState
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <ContextPanel app={app} diagnostics={() => diagnostics} />, root)
  return { app, tab, canvasSelection, widgetFocus, diagnosticFocus, root, unmount }
}

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
})

const summaryKind = (root: Element): string | null =>
  root.querySelector('[data-testid="context-summary"]')?.getAttribute('data-context-kind') ?? null

const problemCodes = (root: Element): readonly string[] =>
  [...root.querySelectorAll('[data-testid="context-problems"] details.problem summary')]
    .map((summary) => summary.textContent ?? '')

describe('ContextPanel', () => {
  it('shows the whole document with every problem while nothing is focused', () => {
    const { root, unmount } = mountContextPanel()
    expect(root.querySelector('h2')?.textContent).toBe('Focused')
    expect(summaryKind(root)).toBe('document')
    expect(root.textContent).toContain('My workflow')
    expect(problemCodes(root)).toHaveLength(3)
    unmount()
  })

  it('follows canvas selection into a node context with only that node\'s problems', () => {
    const { root, canvasSelection, unmount } = mountContextPanel()
    canvasSelection.set({ nodes: ['n1'], links: [], groups: [] })
    expect(summaryKind(root)).toBe('node')
    expect(root.textContent).toContain('First sampler')
    const codes = problemCodes(root)
    expect(codes).toHaveLength(2) // occurrence problem + steps port problem
    expect(codes.join('\n')).toContain('node.first')
    expect(codes.join('\n')).not.toContain('node.second')

    // Clearing the selection returns to the document context.
    canvasSelection.set(EMPTY_CANVAS_SELECTION)
    expect(summaryKind(root)).toBe('document')
    expect(problemCodes(root)).toHaveLength(3)
    unmount()
  })

  it('widget focus outranks node selection and narrows to that value key', () => {
    const { root, canvasSelection, widgetFocus, unmount } = mountContextPanel()
    canvasSelection.set({ nodes: ['n2'], links: [], groups: [] })
    widgetFocus.set({ nodeId: 'n1', valueKey: 'steps', label: 'Steps' })
    expect(summaryKind(root)).toBe('widget')
    expect(root.textContent).toContain('Steps on First sampler')
    const codes = problemCodes(root)
    expect(codes).toHaveLength(1)
    expect(codes[0]).toContain('value.range')
    unmount()
  })

  it('relabels a mounted context without changing raw facts, identity, focus, disclosure, or activation', async () => {
    registerCatalog('de-DE', {
      'contextPanel.action.showOnCanvas': '[AUF LEINWAND ZEIGEN]',
      'contextPanel.context.group': '[GRUPPENAUSWAHL]',
      'contextPanel.context.link': '[VERBINDUNGSAUSWAHL]',
      'contextPanel.context.node': '[KNOTENAUSWAHL]',
      'contextPanel.context.subgraph': '[UNTERGRAPH-ANSICHT]',
      'contextPanel.context.widget': '[WIDGET-KONTEXT]',
      'contextPanel.entity.groupCount': '[{count, plural, one {# KNOTEN} other {# KNOTEN}}]',
      'contextPanel.entity.subgraphDepth': '[TIEFE {depth}]',
      'contextPanel.entity.widget': '[{widget} AUF {node}]',
      'contextPanel.link.reroute': '[UMLEITUNG {id}]',
      'contextPanel.link.selector': '[AUSWAHL {id}]',
      'contextPanel.link.tap': '[ABGRIFF {node}.{tap}]',
      'contextPanel.link.value': '[WERT {id}]',
      'contextPanel.problems.count': '[{count, plural, one {# PROBLEM} other {# PROBLEME}}]',
      'contextPanel.problems.title': '[PROBLEME IN DIESEM KONTEXT]',
      'contextPanel.title': '[FOKUSSIERTER KONTEXT MIT LANGEM TITEL]',
      'First sampler': '[NICHT UBERSETZEN]',
      'node.first': '[NICHT UBERSETZEN]',
      'problem on n1': '[NICHT UBERSETZEN]',
      'raw-group': '[NICHT UBERSETZEN]',
      'Steps': '[NICHT UBERSETZEN]',
    })
    const { tab, canvasSelection, widgetFocus, diagnosticFocus, root, unmount } = mountContextPanel()
    canvasSelection.set({ nodes: ['n1'], links: [], groups: [] })
    const panel = root.querySelector<HTMLElement>('[data-testid="context-panel"]')!
    const summary = root.querySelector<HTMLElement>('[data-testid="context-summary"]')!
    const entity = summary.querySelector('li')!
    const details = root.querySelector<HTMLDetailsElement>('[data-testid="context-problems"] details.problem')!
    const problemSummary = details.querySelector('summary')!
    const show = details.querySelector<HTMLButtonElement>('.problem-show-on-canvas')!
    details.open = true
    show.focus()

    setLocale('de-DE')
    await flush()

    expect(root.querySelector('[data-testid="context-panel"]')).toBe(panel)
    expect(root.querySelector('[data-testid="context-summary"]')).toBe(summary)
    expect(summary.querySelector('li')).toBe(entity)
    expect(root.querySelector('[data-testid="context-problems"] details.problem')).toBe(details)
    expect(details.querySelector('summary')).toBe(problemSummary)
    expect(details.querySelector('.problem-show-on-canvas')).toBe(show)
    expect(details.open).toBe(true)
    expect(document.activeElement).toBe(show)
    expect(root.querySelector('h2')?.textContent).toBe('[FOKUSSIERTER KONTEXT MIT LANGEM TITEL]')
    expect(summary.querySelector('.context-kind')?.textContent).toBe('[KNOTENAUSWAHL]')
    expect(entity.textContent).toContain('First sampler')
    expect(problemSummary.textContent).toContain('[error] node.first: problem on n1')
    expect(root.querySelector('.context-problems-title')?.textContent).toContain('[PROBLEME IN DIESEM KONTEXT]')
    expect(root.querySelector('.problems-group-count')?.getAttribute('aria-label')).toBe('[2 PROBLEME]')
    expect(show.textContent).toBe('[AUF LEINWAND ZEIGEN]')
    expect(diagnosticFocus.get()).toBeUndefined()

    show.click()
    expect(diagnosticFocus.get()).toMatchObject({ anchor: diagnostics[0]!.anchor })

    widgetFocus.set({ nodeId: 'n1', valueKey: 'steps', label: 'Steps' })
    expect(root.querySelector('.context-kind')?.textContent).toBe('[WIDGET-KONTEXT]')
    expect(root.querySelector('.context-entities')?.textContent).toContain('[Steps AUF First sampler]')
    widgetFocus.set(undefined)
    canvasSelection.set({ nodes: [], links: [], groups: ['raw-group'] })
    expect(root.querySelector('.context-kind')?.textContent).toBe('[GRUPPENAUSWAHL]')
    expect(root.querySelector('.context-entities')?.textContent).toContain('raw-group ([0 KNOTEN])')

    canvasSelection.set({ nodes: [], links: ['raw-link-tap', 'raw-link-value'], groups: [] })
    expect(root.querySelector('.context-kind')?.textContent).toBe('[VERBINDUNGSAUSWAHL]')
    expect(root.querySelector('.context-entities')?.textContent).toContain(
      '[ABGRIFF First sampler.raw-tap] -> [UMLEITUNG raw-reroute] (raw-link-tap)',
    )
    expect(root.querySelector('.context-entities')?.textContent).toContain(
      '[WERT raw-value] -> [AUSWAHL raw-selector] (raw-link-value)',
    )

    canvasSelection.set(EMPTY_CANVAS_SELECTION)
    tab.graphStack.set(['g0', 'g1'])
    tab.instancePath.set(['raw-subgraph-instance'])
    expect(root.querySelector('.context-kind')?.textContent).toBe('[UNTERGRAPH-ANSICHT]')
    expect(root.querySelector('.context-entities')?.textContent).toContain('raw-subgraph-name ([TIEFE 1])')
    unmount()
  })

  it('reports an empty context honestly instead of falling back to all problems', () => {
    const { root, canvasSelection, unmount } = mountContextPanel()
    canvasSelection.set({ nodes: [], links: ['l-clean'], groups: [] })
    expect(summaryKind(root)).toBe('link')
    expect(root.querySelector('[data-testid="context-no-problems"]')).not.toBeNull()
    expect(problemCodes(root)).toHaveLength(0)
    unmount()
  })

  it('activates Show on canvas without mutating the document', () => {
    const { root, canvasSelection, diagnosticFocus, unmount } = mountContextPanel()
    canvasSelection.set({ nodes: ['n1'], links: [], groups: [] })
    const details = root.querySelector<HTMLDetailsElement>('[data-testid="context-problems"] details.problem')!
    details.querySelector('summary')!.click()
    details.querySelector<HTMLButtonElement>('.problem-show-on-canvas')!.click()
    expect(diagnosticFocus.get()).toMatchObject({ anchor: diagnostics[0]!.anchor })
    unmount()
  })
})
