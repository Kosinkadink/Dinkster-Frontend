// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { diag } from '@dinkster/core'
import type { ExecutionLogEntry } from '@dinkster/client'
import { BadgePopover, type BadgeAnchor } from '../src/BadgePopover.js'

const logEntry = (over: Partial<ExecutionLogEntry>): ExecutionLogEntry => ({
  level: 'info',
  message: 'loading checkpoint',
  timestamp: 1_755_000_000_000,
  seq: 1,
  ...over,
} as ExecutionLogEntry)

const anchorFor = (badgeId: string): BadgeAnchor => ({
  x: 12,
  y: 34,
  nodeId: 'sampler',
  badge: { id: badgeId, glyph: '!', color: '#f00' },
})

function mount(props: {
  badgeId: string
  logs?: readonly ExecutionLogEntry[]
  onDismissError?: (nodeId: string) => void
  onOpenExecutionLog?: (nodeId: string) => void
}): HTMLElement {
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => (
    <BadgePopover
      anchor={anchorFor(props.badgeId)}
      errors={() => [diag('error', 'runtime', 'runtime.OOM', 'CUDA out of memory')]}
      nodeLogs={(_nodeId, level) => (props.logs ?? []).filter((entry) => entry.level === level)}
      problems={() => []}
      subgraphInfo={() => undefined}
      replacementInfo={() => undefined}
      onOpenSubgraph={() => {}}
      onApplyReplacement={() => {}}
      onClose={() => {}}
      {...(props.onDismissError !== undefined ? { onDismissError: props.onDismissError } : {})}
      {...(props.onOpenExecutionLog !== undefined ? { onOpenExecutionLog: props.onOpenExecutionLog } : {})}
    />
  ), root)
  cleanups.push(() => {
    dispose()
    root.remove()
  })
  return root
}

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const mousedown = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

describe('BadgePopover log badge branches', () => {
  it('lists warning records with timestamps under a Node warnings title', () => {
    const root = mount({
      badgeId: 'core.log.warning',
      logs: [
        logEntry({ level: 'warning', message: 'low vram', seq: 1 }),
        logEntry({ level: 'warning', message: 'clip skipped', seq: 2 }),
        logEntry({ level: 'info', message: 'not shown here', seq: 3 }),
      ],
    })
    expect(root.querySelector('.badge-popover-title')?.textContent).toBe('Node warnings: sampler')
    const rows = [...root.querySelectorAll('[data-testid="badge-log-entry"]')]
    expect(rows.map((row) => row.textContent)).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('low vram')
    expect(rows[0]?.querySelector('.badge-log-time')?.textContent).not.toBe('')
    expect(rows[1]?.textContent).toContain('clip skipped')
  })

  it('lists info records under a Node messages title with an empty fallback', () => {
    const root = mount({ badgeId: 'core.log.info', logs: [logEntry({ level: 'info', message: 'decoded 4 frames' })] })
    expect(root.querySelector('.badge-popover-title')?.textContent).toBe('Node messages: sampler')
    expect(root.querySelector('[data-testid="badge-log-entry"]')?.textContent).toContain('decoded 4 frames')

    const empty = mount({ badgeId: 'core.log.info', logs: [] })
    expect(empty.textContent).toContain('No log records for this run.')
  })

  it('opens the execution log from a log badge via mousedown', () => {
    const onOpen = vi.fn()
    const root = mount({ badgeId: 'core.log.warning', logs: [], onOpenExecutionLog: onOpen })
    mousedown(root.querySelector('[data-testid="badge-open-execution-log"]')!)
    expect(onOpen).toHaveBeenCalledWith('sampler')
  })

  it('offers Dismiss and Open in Execution log on the error badge', () => {
    const onDismiss = vi.fn()
    const onOpen = vi.fn()
    const root = mount({ badgeId: 'core.error', onDismissError: onDismiss, onOpenExecutionLog: onOpen })
    mousedown(root.querySelector('[data-testid="badge-dismiss-error"]')!)
    expect(onDismiss).toHaveBeenCalledWith('sampler')
    mousedown(root.querySelector('[data-testid="badge-open-execution-log"]')!)
    expect(onOpen).toHaveBeenCalledWith('sampler')
  })

  it('renders no action buttons when the callbacks are absent', () => {
    const root = mount({ badgeId: 'core.error' })
    expect(root.querySelector('[data-testid="badge-dismiss-error"]')).toBeNull()
    expect(root.querySelector('[data-testid="badge-open-execution-log"]')).toBeNull()
  })
})
