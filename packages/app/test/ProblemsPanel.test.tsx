import { renderToString } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asNodeId,
  createSignal,
  diag,
  type Diagnostic,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import type { AppState, DiagnosticFocusRequest, Tab } from '../src/app-state.js'
import { activateProblem, createProblemsDisclosure, ProblemsPanel } from '../src/ProblemsPanel.js'

const schema: NodeSchema = {
  type: 'Sampler',
  displayName: 'KSampler',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'model', displayName: 'Model input', type: { kind: 'concrete', name: 'MODEL' }, optional: false },
  ],
}

const document: WorkflowDocument = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('lineage-a'),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'), name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      nodes: {
        n1: { id: asNodeId('n1'), type: 'Sampler', title: 'My sampler', values: {} },
        n2: { id: asNodeId('n2'), type: 'Sampler', title: 'Other sampler', values: {} },
      },
    },
  },
  view: { graphs: {} },
}

const tab = {
  id: 'tab-a',
  store: { doc: document },
  graphStack: createSignal<readonly string[]>(['g0']),
  instancePath: createSignal<readonly string[]>([]),
} as unknown as Tab

const tabs = createSignal<readonly Tab[]>([tab])
const activeTabId = createSignal(tab.id)
const diagnosticFocus = createSignal<DiagnosticFocusRequest | undefined>(undefined)
const app = {
  tabs,
  activeTabId,
  diagnosticFocus,
  activeTab: () => tab,
  registryForTab: () => ({ resolve: (type: string) => type === 'Sampler' ? schema : undefined }),
} as unknown as AppState

const anchored = diag('error', 'runtime', 'runtime.exploded', 'preview exploded', {
  refs: [{ graphId: 'g0', nodeId: 'n1', portId: 'model', direction: 'input' }],
  anchor: { occurrence: { instancePath: [], node: asNodeId('n1') } },
  runtime: {
    exceptionType: 'RuntimeError',
    exceptionMessage: 'preview exploded',
    traceback: ['line one', 'line two'],
  },
})
const other = diag('warning', 'compile', 'compile.other', 'other warning', {
  refs: [{ graphId: 'g0', nodeId: 'n2' }],
})
const diagnostics: readonly Diagnostic[] = [anchored, other]
const firstKey = JSON.stringify(['node', 'lineage-a', 'g0', 'n1'])
const secondKey = JSON.stringify(['node', 'lineage-a', 'g0', 'n2'])
const withoutSsrHydration = (html: string): string =>
  html.replace(/ data-hk="[^"]*"/g, '').replace(/<!--(?:\$|\/)-->/g, '')

describe('ProblemsPanel', () => {
  it('renders expanded accessible groups and preserves item content and focus activation', () => {
    const disclosure = createProblemsDisclosure()
    const renderPanel = () => renderToString(() => (
      <ProblemsPanel app={app} diagnostics={() => diagnostics} compatSkips={() => []} disclosure={disclosure} />
    ))

    const initial = renderPanel()
    expect(initial.match(/class="[^"]*\bproblems-group-header\b[^"]*"/g)).toHaveLength(2)
    expect(initial.match(/aria-expanded="true"/g)).toHaveLength(2)
    expect(initial).toContain('aria-controls="problems-group-0"')
    expect(initial).toContain('id="problems-group-0"')
    expect(initial).toContain('data-severity="error"')
    expect(initial).toContain('runtime.exploded')
    expect(initial).toContain('Node "My sampler" (n1), input "Model input" (model): preview exploded')
    expect(initial).toContain('line one\nline two')

    expect(activeTabId.get()).toBe('tab-a')
    expect(diagnosticFocus.get()).toBeUndefined()
    disclosure.toggle(firstKey)
    expect(disclosure.expanded(firstKey)).toBe(false)
    expect(disclosure.expanded(secondKey)).toBe(true)
    expect(activeTabId.get()).toBe('tab-a')
    expect(diagnosticFocus.get()).toBeUndefined()

    const collapsed = renderPanel()
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).toMatch(/id="problems-group-0"[^>]*hidden/)
    expect(collapsed).toContain('runtime.exploded')

    disclosure.toggle(firstKey)
    expect(disclosure.expanded(firstKey)).toBe(true)
    expect(renderPanel().match(/aria-expanded="true"/g)).toHaveLength(2)

    expect(initial).toMatch(/class="[^"]*\bproblem-show-on-canvas\b[^"]*"/)
    expect(initial).toContain('Show on canvas')
    activateProblem(app, anchored)
    expect(activeTabId.get()).toBe('tab-a')
    expect(diagnosticFocus.get()).toMatchObject({
      tab,
      anchor: anchored.anchor,
    })
  })

  it('renders multiple runtime hints with optional suggestions before the raw traceback', () => {
    const hinted = diag('error', 'runtime', 'runtime.RuntimeError', 'expected scalar type Half but found Float', {
      runtime: {
        exceptionType: 'RuntimeError',
        exceptionMessage: 'expected scalar type Half but found Float',
        hints: [
          {
            code: 'dtype-mismatch',
            message: 'Input dtype Float does not match required dtype Half.',
          },
          {
            code: 'tensor-shape-mismatch',
            message: 'Tensor dimensions do not match.',
            suggestion: 'Try permuting the input layout.',
          },
        ],
        traceback: ['raw traceback'],
      },
    })
    const html = renderToString(() => (
      <ProblemsPanel app={app} diagnostics={() => [hinted]} compatSkips={() => []} />
    ))

    expect(html.match(/class="runtime-error-hint"/g)).toHaveLength(2)
    expect(html.match(/class="runtime-error-hint-suggestion"/g)).toHaveLength(1)
    expect(html).toContain('data-tooltip-label="Diagnostic code: dtype-mismatch"')
    expect(html).not.toContain('title="Diagnostic code: dtype-mismatch"')
    expect(html).toContain('Input dtype Float does not match required dtype Half.')
    expect(html).toContain('data-tooltip-label="Diagnostic code: tensor-shape-mismatch"')
    expect(html).not.toContain('title="Diagnostic code: tensor-shape-mismatch"')
    expect(html).toContain('Try permuting the input layout.')
    expect(html.indexOf('expected scalar type Half')).toBeLessThan(html.indexOf('Diagnostic code: dtype-mismatch'))
    expect(html.indexOf('Diagnostic code: tensor-shape-mismatch')).toBeLessThan(html.indexOf('raw traceback'))
  })

  it('keeps the no-hints runtime detail markup unchanged', () => {
    const html = renderToString(() => (
      <ProblemsPanel app={app} diagnostics={() => [anchored]} compatSkips={() => []} />
    ))
    const detail = withoutSsrHydration(html).match(/<details class="problem"[\s\S]*?<\/details>/)?.[0]

    expect(detail).toBe('<details class="problem" data-severity="error" data-activatable="true"><summary>[error] runtime.exploded: Node "My sampler" (n1), input "Model input" (model): preview exploded</summary><button type="button" class="product-button problem-show-on-canvas " data-variant="secondary" data-size="compact" >Show on canvas</button><pre class="traceback">line one\nline two</pre></details>')
  })

  it('solver diagnostic activation requests focus while an anchorless row stays inert', () => {
    const solver = diag('warning', 'schema', 'solve.linkMismatch', 'types do not match', {
      anchor: { port: { node: asNodeId('n1'), port: 'model' as never } },
    })
    const anchorless = diag('warning', 'schema', 'solve.general', 'no canvas location')
    diagnosticFocus.set(undefined)

    activateProblem(app, solver)
    expect(diagnosticFocus.get()).toMatchObject({ tab, anchor: solver.anchor })

    diagnosticFocus.set(undefined)
    activateProblem(app, anchorless)
    expect(diagnosticFocus.get()).toBeUndefined()

    const html = renderToString(() => (
      <ProblemsPanel app={app} diagnostics={() => [solver, anchorless]} compatSkips={() => []} />
    ))
    expect(html.match(/data-activatable="true"/g)).toHaveLength(1)
    expect(html.match(/class="[^"]*\bproblem-show-on-canvas\b[^"]*"/g)).toHaveLength(1)
  })

  it('renders compat skips as non-anchored advisory entries with verbatim reasons', () => {
    const reason = "V3 Autogrow input 'inputs' has unsupported nested dynamic marker COMFY_MATCHTYPE_V3"
    const html = renderToString(() => (
      <ProblemsPanel
        app={app}
        diagnostics={() => []}
        compatSkips={() => [{ packId: 'comfy', nodeId: 'CreateList', reason }]}
      />
    ))

    expect(html).toContain('Compat skips')
    expect(html).toContain('aria-label="Compat skips"')
    expect(html).toContain('advisory')
    expect(html).toContain('These ComfyUI nodes were not added to the catalog.')
    expect(html).toContain('comfy: CreateList')
    expect(html).toContain(reason)
    expect(html).not.toContain('data-activatable')
    expect(html).not.toContain('None.')
  })

  it('omits the compat skips section when the backend reports none', () => {
    const html = renderToString(() => (
      <ProblemsPanel app={app} diagnostics={() => []} compatSkips={() => []} />
    ))

    expect(html).not.toContain('Compat skips')
    expect(html).toContain('None.')
  })

  it('renders one row per degraded pack with its reason and refused provider ids', () => {
    const reason = 'No live native sampling worker (dinkster.ksampler) is registered.'
    const html = renderToString(() => (
      <ProblemsPanel
        app={app}
        diagnostics={() => []}
        compatSkips={() => []}
        packInferenceUnavailable={() => [
          { pack: 'pack.degraded', reason, worker: 'dinkster.ksampler', providers: [
            { registry: 'sampler', id: 'euler' },
            { registry: 'scheduler', id: 'beta' },
          ] },
          { pack: 'pack.other', reason: 'worker missing', providers: [] },
        ]}
      />
    ))

    expect(html).toContain('Pack inference unavailable')
    expect(html).toContain('aria-label="Pack inference unavailable"')
    expect(html).toContain('data-testid="pack-inference-unavailable-group"')
    expect(html).toContain('data-severity="warning"')
    expect(html).toContain('These packs composed their nodes, routes and events')
    expect(html.match(/class="problem inference-unavailable"/g)).toHaveLength(2)
    expect(html).toContain('<strong>pack.degraded</strong>')
    expect(html).toContain('<strong>pack.other</strong>')
    expect(html).toContain(reason)
    // Provider ids render with a zero-width space after each dot so long
    // ids wrap on boundaries.
    expect(html).toContain('sampler.\u200Beuler')
    expect(html).toContain('scheduler.\u200Bbeta')
    expect(html).not.toContain('data-activatable')
    expect(html).not.toContain('None.')
  })

  it('omits the degraded pack section and keeps the empty state when none are reported', () => {
    const html = renderToString(() => (
      <ProblemsPanel app={app} diagnostics={() => []} compatSkips={() => []} packInferenceUnavailable={() => []} />
    ))

    expect(html).not.toContain('Pack inference unavailable')
    expect(html).toContain('None.')
  })

  it('renders no degraded pack section for hosts that do not supply the surface', () => {
    const html = renderToString(() => (
      <ProblemsPanel app={app} diagnostics={() => []} compatSkips={() => []} />
    ))

    expect(html).not.toContain('Pack inference unavailable')
    expect(html).toContain('None.')
  })
})
