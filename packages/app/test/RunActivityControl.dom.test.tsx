// @vitest-environment happy-dom

import { asConnectionId, asLineageId, asPromptId, type CompileArtifact } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChosenRun, RunActivityControl, runAge, tookText } from '../src/RunControls.js'

const job = (connection: string, prompt: string, lineage: string, status: ExecutionState['status']): ExecutionState => ({
  ref: { connection: asConnectionId(connection), prompt: asPromptId(prompt) },
  key: `${connection}:${prompt}`,
  artifact: { snapshot: { lineage: asLineageId(lineage) }, scope: { kind: 'full' }, prompt: {} } as unknown as CompileArtifact,
  status,
  nodes: {},
  blockedNodes: {},
  expandedNodes: {},
  regions: {},
  outputs: {},
  artifacts: [],
  artifactsHydrated: false,
  previews: {},
  activities: [],
  errors: [],
  logs: [],
  logsDropped: 0,
  queuedAt: 1,
})

const titles: Readonly<Record<string, string>> = { long: 'Long run', mixed: 'Mixed run' }

afterEach(() => document.body.replaceChildren())

describe('RunActivityControl', () => {
  it('cancels the one running job from its X, opens the list instead while two run, keeps the queued count without an X while none runs, and is absent while nothing waits', () => {
    const cancel = vi.fn()
    const openList = vi.fn()
    const [executions, setExecutions] = createSignal<readonly ExecutionState[]>([
      job('local', 'waiting', 'mixed', 'queued'),
      job('local', 'working', 'long', 'running'),
    ])
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <RunActivityControl
        executions={executions()}
        title={(entry) => titles[entry.artifact!.snapshot.lineage]!}
        cancelling={new Set()}
        onCancel={cancel}
        onOpenList={openList}
      />
    ), root)

    expect(root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('1 running, 1 queued')
    const x = () => root.querySelector<HTMLButtonElement>('[data-testid="cancel-execution"]')!
    expect(x().getAttribute('aria-label')).toBe('Cancel Long run')
    x().click()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel.mock.calls[0]![0].ref.prompt).toBe('working')
    expect(openList).not.toHaveBeenCalled()

    setExecutions([job('local', 'working', 'long', 'running'), job('second', 'elsewhere', 'mixed', 'running')])
    expect(x().getAttribute('aria-label')).toBe('Show running jobs')
    x().click()
    expect(openList).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()

    setExecutions([job('local', 'waiting', 'mixed', 'queued'), job('local', 'done', 'long', 'completed')])
    expect(root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('0 running, 1 queued')
    expect(root.querySelector('[data-testid="cancel-execution"]')).toBeNull()

    setExecutions([job('local', 'done', 'long', 'completed')])
    expect(root.querySelector('[data-testid="run-activity-control"]')).toBeNull()
    unmount()
  })
})

describe('runAge', () => {
  it('reads "just now" for the whole first minute, then counts whole minutes', () => {
    expect(runAge(100_000, 100_000)).toBe('just now')
    expect(runAge(100_000, 159_000)).toBe('just now')
    expect(runAge(100_000, 160_000)).toBe('1 minute ago')
    expect(runAge(100_000, 100_000 + 61 * 60_000)).toBe('1 hour ago')
  })
})

describe('tookText', () => {
  it('counts seconds, then minutes and seconds, then hours and minutes', () => {
    expect(tookText(12)).toBe('12s')
    expect(tookText(125)).toBe('2m 5s')
    expect(tookText(3725)).toBe('1h 2m')
  })
})

describe('ChosenRun', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const menuItem = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')]
    .find((item) => item.textContent?.trim() === name)!
  const mount = (props: { reason?: string; runAgain?: () => void; open?: () => void; copy?: () => void; remove?: () => void }) => {
    const [detailsOpen, setDetailsOpen] = createSignal(false)
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <ChosenRun name="Long run" reason={props.reason} detailsOpen={detailsOpen()} onDetails={setDetailsOpen}
        facts={[{ label: 'Took', text: '12s' }, { label: 'Nodes', text: '4 ran, 2 from cache' }]}
        onRunAgain={props.runAgain} onOpenWorkflow={props.open}
        onCopyJobId={props.copy ?? (() => {})} onDelete={props.remove ?? (() => {})} />
    ), root)
    const openMenu = async () => {
      root.querySelector<HTMLButtonElement>('button[aria-label="More for Long run"]')!.click()
      await settle()
    }
    return { root, unmount, openMenu }
  }

  it('offers Open workflow and a menu, shows Details only on request and copies the job ID without showing it', async () => {
    const open = vi.fn()
    const copy = vi.fn()
    const view = mount({ open, copy })
    expect(view.root.querySelector('.run-chosen-reason')).toBeNull()
    expect(view.root.querySelector('[data-testid="chosen-run-again"]')).toBeNull()
    view.root.querySelector<HTMLButtonElement>('[data-testid="chosen-run-open"]')!.click()
    expect(open).toHaveBeenCalledOnce()
    expect(view.root.querySelector('[data-testid="chosen-run-details"]')).toBeNull()

    await view.openMenu()
    expect([...document.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim()))
      .toEqual(['Details', 'Copy job ID', 'Delete record'])
    menuItem('Details').click()
    await settle()
    const details = view.root.querySelector('[data-testid="chosen-run-details"]')!
    expect([...details.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Took', 'Nodes'])
    expect(details.textContent).toContain('4 ran, 2 from cache')

    await view.openMenu()
    menuItem('Copy job ID').click()
    expect(copy).toHaveBeenCalledOnce()
    view.unmount()
  })

  it('says why an interrupted run stopped and offers Run again', () => {
    const runAgain = vi.fn()
    const view = mount({ reason: 'The engine stopped while this was running.', runAgain })
    expect(view.root.querySelector('.run-chosen-reason')?.textContent).toBe('The engine stopped while this was running.')
    view.root.querySelector<HTMLButtonElement>('[data-testid="chosen-run-again"]')!.click()
    expect(runAgain).toHaveBeenCalledOnce()
    view.unmount()
  })

  it('asks before deleting the record, and Cancel keeps it', async () => {
    const remove = vi.fn()
    const view = mount({ remove })
    const confirm = () => [...view.root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Delete record')
    const cancel = () => [...view.root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Cancel')

    await view.openMenu()
    menuItem('Delete record').click()
    await settle()
    expect(remove).not.toHaveBeenCalled()
    cancel()!.click()
    expect(confirm()).toBeUndefined()
    expect(view.root.querySelector('button[aria-label="More for Long run"]')).not.toBeNull()

    await view.openMenu()
    menuItem('Delete record').click()
    await settle()
    confirm()!.click()
    expect(remove).toHaveBeenCalledOnce()
    view.unmount()
  })
})
