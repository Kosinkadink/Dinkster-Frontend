// @vitest-environment happy-dom

import { asConnectionId, asLineageId, asPromptId, diag, type CompileArtifact } from '@dinkster/core'
import { registerCatalog, setLocale } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionLogPanel, executionLogRows } from '../src/ExecutionLogPanel.js'

const entry = (over: Partial<ExecutionState> = {}): ExecutionState => ({
  ref: { connection: asConnectionId('c0'), prompt: asPromptId('run-1') },
  key: 'c0:run-1',
  artifact: {
    snapshot: { lineage: asLineageId('lineage-1') },
    scope: { kind: 'full' },
    prompt: {},
  } as unknown as CompileArtifact,
  status: 'running',
  nodes: {},
  regions: {},
  outputs: {},
  artifacts: [],
  artifactsHydrated: false,
  previews: {},
  activities: [],
  errors: [],
  logs: [],
  logsDropped: 0,
  queuedAt: 1_000,
  ...over,
} as unknown as ExecutionState)

const populated = (): ExecutionState => entry({
  status: 'error',
  endedAt: 5_000,
  logs: [
    { level: 'info', message: 'loading checkpoint', timestamp: 2_000, runtimeNodeId: 'sampler', seq: 1 },
    { level: 'warning', message: 'low vram', timestamp: 3_000, origin: 'logging', seq: 2 },
    { level: 'info', message: 'decoding latents', timestamp: 4_000, runtimeNodeId: 'decoder', seq: 3 },
  ],
  errors: [
    diag('error', 'runtime', 'runtime.OOM', 'CUDA out of memory', { data: { runtimeId: 'sampler' } }),
  ],
})

function mount(props: {
  executions?: () => readonly ExecutionState[]
  active?: () => ExecutionState | undefined
  onFocusNode?: (execution: ExecutionState, id: string) => void
  filterRequest?: () => { readonly runtimeNodeIds: readonly string[]; readonly token: number } | undefined
  onFilterApplied?: (token: number) => void
}): HTMLElement {
  const active = props.active ?? (() => undefined)
  const root = document.createElement('div')
  document.body.append(root)
  render(() => (
    <ExecutionLogPanel
      executions={props.executions ?? (() => active() === undefined ? [] : [active()!])}
      active={active}
      nodeTitle={(_execution, id) => `Title of ${id}`}
      {...(props.onFocusNode !== undefined ? { onFocusNode: props.onFocusNode } : {})}
      {...(props.filterRequest !== undefined ? { filterRequest: props.filterRequest } : {})}
      {...(props.onFilterApplied !== undefined ? { onFilterApplied: props.onFilterApplied } : {})}
    />
  ), root)
  return root
}

const rowsOf = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-testid="execution-log-row"]')]

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  setLocale('en')
})

describe('executionLogRows', () => {
  it('merges log records and error diagnostics chronologically', () => {
    const rows = executionLogRows(populated())
    expect(rows.map((row) => [row.level, row.source])).toEqual([
      ['info', 'log'],
      ['warning', 'log'],
      ['info', 'log'],
      ['error', 'diagnostic'],
    ])
    const error = rows[3]!
    expect(error.message).toBe('CUDA out of memory')
    expect(error.runtimeNodeId).toBe('sampler')
    expect(error.timestamp).toBe(5_000)
  })

  it('orders a run-end diagnostic by endedAt among later log records', () => {
    const rows = executionLogRows(entry({
      endedAt: 2_500,
      logs: [
        { level: 'info', message: 'early', timestamp: 2_000, seq: 1 },
        { level: 'info', message: 'late', timestamp: 3_000, seq: 2 },
      ],
      errors: [diag('error', 'runtime', 'runtime.X', 'failed')],
    }))
    expect(rows.map((row) => row.message)).toEqual(['early', 'failed', 'late'])
  })
})

describe('ExecutionLogPanel', () => {
  it('updates mounted chrome without changing selected execution, filters, rows, or raw values', async () => {
    registerCatalog('de-DE', {
      'executionLog.action.jumpLatest': '[Zum neuesten Eintrag]',
      'executionLog.aria.contents': '[Ausfuhrungsprotokoll]',
      'executionLog.aria.levelFilters': '[Stufenfilter]',
      'executionLog.aria.records': '[Protokolleintrage]',
      'executionLog.field.node': '[Knoten]',
      'executionLog.field.run': '[Lauf]',
      'executionLog.level.error': '[FEHLER]',
      'executionLog.level.info': '[INFO]',
      'executionLog.level.warning': '[WARNUNG]',
      'executionLog.notice.discarded': '{count, plural, one {[# ALTER EINTRAG]} other {[# ALTE EINTRAGE]}}',
      'executionLog.option.allNodes': '[Alle Knoten]',
      'executionLog.option.current': '[Aktuell]',
      'executionLog.run.label': '[{prompt} :: {status}]',
      'executionLog.status.error': '[STATUS-FEHLER]',
      'executionLog.title.showNode': '[Knoten {id} auf Leinwand zeigen]',
      'raw diagnostic Nachricht': '[UBERSETZTE DIAGNOSE]',
      'raw log Nachricht': '[UBERSETZTER PROTOKOLLEINTRAG]',
      stdout: '[AUSGABE]',
      'Title of sampler': '[UBERSETZTER KNOTEN]',
    })
    const pinned = populated()
    const selected = entry({
      key: 'c0:raw-prompt-INK',
      ref: { connection: asConnectionId('c0'), prompt: asPromptId('raw-prompt-INK') },
      status: 'error',
      logsDropped: 2,
      logs: [
        { level: 'info', message: 'raw log Nachricht', timestamp: 2_000, runtimeNodeId: 'sampler', origin: 'stdout', seq: 1 },
        { level: 'warning', message: 'raw warning Nachricht', timestamp: 3_000, runtimeNodeId: 'decoder', seq: 2 },
      ],
      errors: [diag('error', 'runtime', 'runtime.raw', 'raw diagnostic Nachricht', { data: { runtimeId: 'sampler' } })],
    })
    const onFocusNode = vi.fn()
    const root = mount({ executions: () => [pinned, selected], active: () => pinned, onFocusNode })
    await flush()
    const panel = root.querySelector('[data-testid="execution-log-panel"]')
    const runSelect = root.querySelector<HTMLSelectElement>('[data-testid="execution-log-run-select"]')!
    runSelect.value = selected.key
    runSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    const nodeSelect = root.querySelector<HTMLSelectElement>('[data-testid="execution-log-node-select"]')!
    nodeSelect.value = 'sampler'
    nodeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-testid="execution-log-level-info"]')!.click()
    await flush()
    const rows = rowsOf(root)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('raw diagnostic Nachricht')

    const list = root.querySelector<HTMLElement>('[data-testid="execution-log-list"]')!
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 600 },
    })
    list.scrollTop = 0
    list.dispatchEvent(new Event('scroll'))
    list.dispatchEvent(new Event('scroll'))
    await flush()
    expect(root.querySelector('[data-testid="execution-log-resume"]')).not.toBeNull()

    setLocale('de-DE')
    await flush()

    expect(root.querySelector('[data-testid="execution-log-panel"]')).toBe(panel)
    expect(runSelect.value).toBe(selected.key)
    expect(nodeSelect.value).toBe('sampler')
    expect(root.querySelector('[data-testid="execution-log-level-info"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(rowsOf(root)).toHaveLength(rows.length)
    rowsOf(root).forEach((row, index) => expect(row).toBe(rows[index]))
    expect(root.querySelector('.execution-log-run > span')?.textContent).toBe('[Lauf]')
    expect(root.querySelector('.execution-log-node-filter > span')?.textContent).toBe('[Knoten]')
    expect(root.querySelector('[data-testid="execution-log-panel"]')?.getAttribute('aria-label')).toBe('[Ausfuhrungsprotokoll]')
    expect(root.querySelector('[data-testid="execution-log-list"]')?.getAttribute('aria-label')).toBe('[Protokolleintrage]')
    expect(root.querySelector('[data-testid="execution-log-resume"]')?.textContent).toContain('[Zum neuesten Eintrag]')
    expect(root.querySelector('[data-testid="execution-log-truncated"]')?.textContent).toBe('[2 ALTE EINTRAGE]')
    expect([...runSelect.options].find((option) => option.value === selected.key)?.textContent)
      .toBe('[raw-prompt-INK :: [STATUS-FEHLER]]')
    expect(rows[0]!.textContent).toContain('[FEHLER]')
    expect(rows[0]!.textContent).toContain('Title of sampler')
    expect(rows[0]!.textContent).toContain('raw diagnostic Nachricht')
    expect(root.querySelector('[data-testid="execution-log-node"]')?.getAttribute('title'))
      .toBe('[Knoten sampler auf Leinwand zeigen]')
    expect(onFocusNode).not.toHaveBeenCalled()

    root.querySelector<HTMLButtonElement>('[data-testid="execution-log-level-info"]')!.click()
    await flush()
    const rawLogRow = rowsOf(root).find((row) => row.textContent?.includes('raw log Nachricht'))
    expect(rawLogRow?.textContent).toContain('Title of sampler')
    expect(rawLogRow?.textContent).toContain('stdout')
  })

  it('shows an empty state without an execution', () => {
    const root = mount({})
    expect(root.querySelector('[data-testid="execution-log-empty"]')?.textContent).toContain('No execution selected')
  })

  it('renders merged rows with level, node title, and origin', async () => {
    const root = mount({ active: () => populated() })
    await flush()
    const rows = rowsOf(root)
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.dataset['level'])).toEqual(['info', 'warning', 'info', 'error'])
    expect(rows[3]!.dataset['source']).toBe('diagnostic')
    expect(rows[1]!.dataset['origin']).toBe('logging')
    expect(rows[0]!.querySelector('[data-testid="execution-log-node"]')?.textContent).toBe('Title of sampler')
    expect(rows[3]!.textContent).toContain('CUDA out of memory')
  })

  it('level toggles hide matching rows, including diagnostic-backed error rows', async () => {
    const root = mount({ active: () => populated() })
    await flush()
    const infoToggle = root.querySelector<HTMLButtonElement>('[data-testid="execution-log-level-info"]')!
    infoToggle.click()
    await flush()
    expect(infoToggle.getAttribute('aria-pressed')).toBe('false')
    expect(rowsOf(root).map((row) => row.dataset['level'])).toEqual(['warning', 'error'])

    root.querySelector<HTMLButtonElement>('[data-testid="execution-log-level-error"]')!.click()
    await flush()
    expect(rowsOf(root).map((row) => row.dataset['level'])).toEqual(['warning'])

    infoToggle.click()
    await flush()
    expect(rowsOf(root).map((row) => row.dataset['level'])).toEqual(['info', 'warning', 'info'])
  })

  it('node filter keeps only that node, spanning log and diagnostic rows', async () => {
    const root = mount({ active: () => populated() })
    await flush()
    const select = root.querySelector<HTMLSelectElement>('[data-testid="execution-log-node-select"]')!
    expect([...select.options].map((option) => option.value)).toEqual(['', 'sampler', 'decoder'])
    select.value = 'sampler'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    const rows = rowsOf(root)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.dataset['source'])).toEqual(['log', 'diagnostic'])
  })

  it('clicking a node chip asks the host to focus that node', async () => {
    const onFocusNode = vi.fn()
    const execution = populated()
    const root = mount({ active: () => execution, onFocusNode })
    await flush()
    rowsOf(root)[0]!.querySelector<HTMLButtonElement>('[data-testid="execution-log-node"]')!.click()
    expect(onFocusNode).toHaveBeenCalledWith(execution, 'sampler')
  })

  it('reports discarded records when the buffer overflowed', async () => {
    const root = mount({ active: () => populated() })
    expect(root.querySelector('[data-testid="execution-log-truncated"]')).toBeNull()
    const overflowed = entry({
      logs: [{ level: 'info', message: 'tail', timestamp: 9_000, seq: 1 }],
      logsDropped: 25,
    })
    const rerooted = mount({ active: () => overflowed })
    expect(rerooted.querySelector('[data-testid="execution-log-truncated"]')?.textContent)
      .toContain('25 earlier records discarded')
  })

  it('pinning a run in the selector shows that run instead of the active one', async () => {
    const pinned = entry({
      key: 'c0:run-2',
      ref: { connection: asConnectionId('c0'), prompt: asPromptId('run-2') },
      logs: [{ level: 'info', message: 'from pinned run', timestamp: 2_000, seq: 1 }],
    })
    const activeRun = populated()
    const [executions] = createSignal<readonly ExecutionState[]>([activeRun, pinned])
    const root = mount({ executions, active: () => activeRun })
    await flush()
    const select = root.querySelector<HTMLSelectElement>('[data-testid="execution-log-run-select"]')!
    select.value = 'c0:run-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    const rows = rowsOf(root)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('from pinned run')
  })

  it('a filter request selects the current run and that node, and repeats re-apply', async () => {
    const activeRun = populated()
    const applied: number[] = []
    const [request, setRequest] = createSignal<{ runtimeNodeIds: readonly string[]; token: number } | undefined>(undefined)
    const root = mount({ active: () => activeRun, filterRequest: request, onFilterApplied: (token) => applied.push(token) })
    await flush()
    expect(rowsOf(root)).toHaveLength(4)

    setRequest({ runtimeNodeIds: ['sampler'], token: 1 })
    await flush()
    const select = root.querySelector<HTMLSelectElement>('[data-testid="execution-log-node-select"]')!
    expect(select.value).toBe('sampler')
    expect(rowsOf(root).every((row) => row.textContent!.includes('Title of sampler'))).toBe(true)
    expect(applied).toEqual([1])

    // The user widens the filter by hand; a NEW request for the SAME node
    // narrows it again (the token distinguishes repeats).
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(rowsOf(root)).toHaveLength(4)
    setRequest({ runtimeNodeIds: ['sampler'], token: 2 })
    await flush()
    expect(select.value).toBe('sampler')
    expect(applied).toEqual([1, 2])
  })

  it('a multi-occurrence request filters to the whole set until a manual selection', async () => {
    const activeRun = populated()
    const [request, setRequest] = createSignal<{ runtimeNodeIds: readonly string[]; token: number } | undefined>(undefined)
    const root = mount({ active: () => activeRun, filterRequest: request })
    await flush()
    expect(rowsOf(root)).toHaveLength(4)

    setRequest({ runtimeNodeIds: ['sampler', 'decoder'], token: 1 })
    await flush()
    const select = root.querySelector<HTMLSelectElement>('[data-testid="execution-log-node-select"]')!
    expect(select.selectedIndex).toBe(0)
    expect(select.selectedOptions[0]!.dataset['groupFilter']).toBe('true')
    expect(select.selectedOptions[0]!.textContent).toBe('Focused node (2 occurrences)')
    const grouped = rowsOf(root)
    expect(grouped.length).toBeGreaterThan(0)
    expect(grouped.every((row) =>
      row.textContent!.includes('Title of sampler') || row.textContent!.includes('Title of decoder'))).toBe(true)

    registerCatalog('de-DE', {
      'executionLog.option.focusedNode': '{count, plural, one {[FOKUS # VORKOMMEN]} other {[FOKUS # VORKOMMEN]}}',
    })
    setLocale('de-DE')
    await flush()
    expect(select.selectedOptions[0]!.dataset['groupFilter']).toBe('true')
    expect(select.selectedOptions[0]!.textContent).toBe('[FOKUS 2 VORKOMMEN]')
    rowsOf(root).forEach((row, index) => expect(row).toBe(grouped[index]))

    // Manually picking one node clears the grouped filter.
    select.value = 'decoder'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(select.value).toBe('decoder')
    expect(rowsOf(root).every((row) => row.textContent!.includes('Title of decoder'))).toBe(true)
  })

  it('selects a real __group node without confusing it for the grouped filter', async () => {
    const activeRun = entry({
      logs: [
        { level: 'info', message: 'real magic-looking id', timestamp: 2_000, runtimeNodeId: '__group', seq: 1 },
        { level: 'info', message: 'ordinary id', timestamp: 3_000, runtimeNodeId: 'decoder', seq: 2 },
      ],
    })
    const [request, setRequest] = createSignal<{ runtimeNodeIds: readonly string[]; token: number } | undefined>(undefined)
    const root = mount({ active: () => activeRun, filterRequest: request })
    setRequest({ runtimeNodeIds: ['__group', 'decoder'], token: 1 })
    await flush()
    const select = root.querySelector<HTMLSelectElement>('[data-testid="execution-log-node-select"]')!

    expect(select.selectedOptions[0]!.dataset['groupFilter']).toBe('true')
    expect([...select.options].filter((option) => option.value === '__group')).toHaveLength(1)
    select.value = '__group'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    expect(select.value).toBe('__group')
    expect(select.selectedOptions[0]!.dataset['groupFilter']).toBeUndefined()
    expect(rowsOf(root)).toHaveLength(1)
    expect(rowsOf(root)[0]!.textContent).toContain('real magic-looking id')
  })

  it('keeps a requested node with no rows selectable and clearable', async () => {
    const activeRun = populated()
    const [request, setRequest] = createSignal<{ runtimeNodeIds: readonly string[]; token: number } | undefined>(undefined)
    const root = mount({ active: () => activeRun, filterRequest: request })
    setRequest({ runtimeNodeIds: ['missing-node'], token: 1 })
    await flush()
    const select = root.querySelector<HTMLSelectElement>('[data-testid="execution-log-node-select"]')!

    expect(select.value).toBe('missing-node')
    expect(rowsOf(root)).toHaveLength(0)
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    expect(select.value).toBe('')
    expect(rowsOf(root)).toHaveLength(4)
  })
})
