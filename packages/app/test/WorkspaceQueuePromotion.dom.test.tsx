// @vitest-environment happy-dom

import {
  asConnectionId,
  asGraphDefId,
  asLineageId,
  asNodeId,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppState } from '../src/app-state.js'
import { SharedWorkerDocumentAuthority, type WorkerPortLike } from '../src/shared-worker-authority.js'
import type { SharedWorkerPortFactory } from '../src/shared-worker-connection.js'
import { SharedWorkerTabAuthority } from '../src/workspace-worker-authority.js'
import type { WorkspaceWorkerPortFactory } from '../src/workspace-worker-connection.js'
import { WorkflowQueueControl } from '../src/WorkflowQueueControl.js'

class MemoryPort implements WorkerPortLike {
  peer: MemoryPort | undefined
  paused = false
  private readonly queued: unknown[] = []
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()

  postMessage(message: unknown): void {
    const data = structuredClone(message)
    queueMicrotask(() => {
      if (this.peer?.paused) {
        this.peer.queued.push(data)
        return
      }
      for (const listener of this.peer?.listeners ?? []) listener({ data } as MessageEvent<unknown>)
    })
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener)
  }

  release(): void {
    this.paused = false
    for (const data of this.queued.splice(0)) {
      for (const listener of this.listeners) listener({ data } as MessageEvent<unknown>)
    }
  }

  reject(id: number, message: string): void {
    for (const listener of this.listeners) {
      listener({ data: { kind: 'error', id, message } } as MessageEvent<unknown>)
    }
  }
}

const connect = (authority: { connect(port: WorkerPortLike): void }): MemoryPort => {
  const renderer = new MemoryPort()
  const worker = new MemoryPort()
  renderer.peer = worker
  worker.peer = renderer
  authority.connect(worker)
  return renderer
}

const outputSchema: NodeSchema = {
  type: 'QueueOutput',
  displayName: 'Queue output',
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  items: [],
}

const workflow = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('workspace-queue-promotion'),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'),
      name: 'root',
      nodes: { output: { id: asNodeId('output'), type: outputSchema.type, values: {} } },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 2,
    },
  },
  view: { graphs: {} },
})

beforeEach(() => localStorage.clear())

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
})

const workspaceApp = async (): Promise<{
  readonly app: AppState
  readonly promotionPorts: MemoryPort[]
  pausePromotions(): void
}> => {
  const app = new AppState()
  const schemas = new Map([[outputSchema.type, outputSchema]])
  app.registry.set({
    connection: asConnectionId('local'),
    schemas,
    diagnostics: [],
    resolve: (type) => schemas.get(type),
    hash: 'workspace-queue-test',
  })

  const documentAuthority = new SharedWorkerDocumentAuthority()
  const promotionPorts: MemoryPort[] = []
  let pausePromotion = false
  const documentFactory: SharedWorkerPortFactory = () => {
    const port = connect(documentAuthority)
    port.paused = pausePromotion
    if (pausePromotion) promotionPorts.push(port)
    return port
  }
  const tabAuthority = new SharedWorkerTabAuthority()
  const workspaceFactory: WorkspaceWorkerPortFactory = () => connect(tabAuthority)
  await app.enableWorkspaceAuthority(documentFactory, workspaceFactory)
  return {
    app,
    promotionPorts,
    pausePromotions: () => { pausePromotion = true },
  }
}

describe('workspace promotion queueing', () => {
  it('preserves an actual Queue control action until the replacement store is live', async () => {
    const { app, promotionPorts, pausePromotions } = await workspaceApp()
    pausePromotions()
    app.openDocument(workflow(), 'Workspace queue')
    const tab = app.activeTab()!
    const submit = vi.spyOn(app.connection, 'submit').mockResolvedValue({ ok: false, diagnostics: [] })
    await vi.waitFor(() => expect(promotionPorts).toHaveLength(1))

    let queueing: Promise<void> | undefined
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <WorkflowQueueControl
        owner={{ id: tab.id, title: tab.title, lineage: tab.store.doc.lineage }}
        executions={[]}
        canQueue={true}
        onQueue={() => { queueing = app.queue(tab) }}
        onOpenExecution={() => {}}
      />
    ), root)

    root.querySelector<HTMLButtonElement>('[data-testid="queue-button"]')!.click()
    await Promise.resolve()
    expect(submit).not.toHaveBeenCalled()

    for (const port of promotionPorts) port.release()
    await queueing

    expect(submit).toHaveBeenCalledOnce()
    const promoted = app.activeTab()!
    expect(promoted.id).toBe(tab.id)
    expect(promoted).not.toBe(tab)
    expect('status' in promoted.store).toBe(true)

    dispose()
    app.dispose()
  })

  it('does not retarget an accepted request to an independently replaced same-lineage document', async () => {
    const { app, promotionPorts, pausePromotions } = await workspaceApp()
    pausePromotions()
    app.openDocument(workflow(), 'Original workspace queue')
    const original = app.activeTab()!
    const submit = vi.spyOn(app.connection, 'submit').mockResolvedValue({ ok: false, diagnostics: [] })
    await vi.waitFor(() => expect(promotionPorts).toHaveLength(1))
    const queueing = app.queue(original)

    const initial = workflow()
    const replacement: WorkflowDocument = {
      ...initial,
      graphs: { ...initial.graphs, g0: { ...initial.graphs.g0!, name: 'replacement' } },
    }
    app.openDocument(replacement, 'Replacement workspace queue')
    await vi.waitFor(() => expect(promotionPorts).toHaveLength(2))
    promotionPorts[1]!.release()
    await vi.waitFor(() => {
      const active = app.activeTab()!
      expect('status' in active.store).toBe(true)
      expect(active.store.doc.graphs.g0!.name).toBe('replacement')
    })
    promotionPorts[0]!.release()
    await queueing

    expect(submit).not.toHaveBeenCalled()
    app.dispose()
  })

  it('drops an accepted request when its exact document closes during promotion', async () => {
    const { app, promotionPorts, pausePromotions } = await workspaceApp()
    pausePromotions()
    app.openDocument(workflow(), 'Closing workspace queue')
    const tab = app.activeTab()!
    const submit = vi.spyOn(app.connection, 'submit').mockResolvedValue({ ok: false, diagnostics: [] })
    await vi.waitFor(() => expect(promotionPorts).toHaveLength(1))
    const queueing = app.queue(tab)

    app.closeTab(tab.id)
    promotionPorts[0]!.release()
    await queueing

    expect(submit).not.toHaveBeenCalled()
    app.dispose()
  })

  it('queues against the still-live local document when promotion fails', async () => {
    const { app, promotionPorts, pausePromotions } = await workspaceApp()
    pausePromotions()
    app.openDocument(workflow(), 'Failed workspace promotion')
    const tab = app.activeTab()!
    const submit = vi.spyOn(app.connection, 'submit').mockResolvedValue({ ok: false, diagnostics: [] })
    await vi.waitFor(() => expect(promotionPorts).toHaveLength(1))
    const queueing = app.queue(tab)

    promotionPorts[0]!.reject(1, 'controlled promotion failure')
    await queueing

    expect(submit).toHaveBeenCalledOnce()
    expect(app.activeTab()).toBe(tab)
    expect('status' in tab.store).toBe(false)
    promotionPorts[0]!.release()
    app.dispose()
  })
})
