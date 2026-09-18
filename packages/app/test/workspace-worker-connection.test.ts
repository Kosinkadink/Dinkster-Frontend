import { afterEach, describe, expect, it, vi } from 'vitest'
import { asGraphDefId, asLineageId, type WorkflowDocument } from '@dinkster/core'
import { type WorkerPortLike } from '../src/shared-worker-authority.js'
import {
  SharedWorkerTabAuthority,
  type WorkspaceTabMutation,
  type WorkspaceTabRecord,
} from '../src/workspace-worker-authority.js'
import {
  SharedWorkerTabConnection,
  type WorkspaceWorkerPortFactory,
} from '../src/workspace-worker-connection.js'

class MemoryPort implements WorkerPortLike {
  peer: MemoryPort | undefined
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()
  postMessage(message: unknown): void {
    const data = structuredClone(message)
    queueMicrotask(() => {
      for (const listener of this.peer?.listeners ?? []) listener({ data } as MessageEvent<unknown>)
    })
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener)
  }
}

let operationSequence = 0
afterEach(() => {
  operationSequence = 0
  vi.useRealTimers()
})

const document = (id: string): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId(id),
  root: asGraphDefId('g0'),
  graphs: {
    g0: { id: asGraphDefId('g0'), name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
  },
  view: { graphs: {} },
})

const record = (id: string): WorkspaceTabRecord => ({ id, title: id, document: document(id) })

const factoryFor = (authority: SharedWorkerTabAuthority): WorkspaceWorkerPortFactory => () => {
  const renderer = new MemoryPort()
  const worker = new MemoryPort()
  renderer.peer = worker
  worker.peer = renderer
  authority.connect(worker)
  return renderer
}

const mutation = (
  opId: string,
  additions: readonly WorkspaceTabRecord[],
  removals: readonly string[],
  order: readonly string[],
): WorkspaceTabMutation => ({
  opId,
  actorId: 'test',
  sequence: operationSequence++,
  baseRevision: 0,
  additions,
  removals,
  updates: [],
  order,
  active: order[0] ?? '',
})

describe('SharedWorker tab authority', () => {
  it('merges concurrent creates and rejects stale reorder resurrection', async () => {
    const authority = new SharedWorkerTabAuthority()
    const factory = factoryFor(authority)
    const first = await SharedWorkerTabConnection.open([record('a')], factory)
    const second = await SharedWorkerTabConnection.open([record('a')], factory)

    await Promise.all([
      first.connection.mutate(mutation('first-add', [record('b')], [], ['a', 'b'])),
      second.connection.mutate(mutation('second-add', [record('c')], [], ['a', 'c'])),
    ])
    await first.connection.mutate(mutation('close-b', [], ['b'], ['a', 'c']))
    await second.connection.mutate(mutation('stale-reorder', [], [], ['b', 'c', 'a']))

    const observer = await SharedWorkerTabConnection.open([], factory)
    expect(observer.snapshot.tabs.map((tab) => tab.id)).toEqual(['c', 'a'])
  })

  it('deduplicates operations and can restart from the durable converged snapshot', async () => {
    const firstAuthority = new SharedWorkerTabAuthority()
    const opened = await SharedWorkerTabConnection.open([record('a')], factoryFor(firstAuthority))
    const operation = mutation('add-b', [record('b')], [], ['b', 'a'])
    const converged = await opened.connection.mutate(operation)
    const replayed = await opened.connection.mutate(operation)
    expect(replayed).toEqual(converged)
    opened.connection.close()
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const restarted = await SharedWorkerTabConnection.open(
      converged.tabs,
      factoryFor(new SharedWorkerTabAuthority()),
    )
    expect(restarted.snapshot.tabs.map((tab) => tab.id)).toEqual(['b', 'a'])
    expect(restarted.snapshot.tabs.map((tab) => tab.document.lineage)).toEqual(['b', 'a'])
  })

  it('revisions active ownership without forcing a peer-local selection', async () => {
    const authority = new SharedWorkerTabAuthority()
    const factory = factoryFor(authority)
    const first = await SharedWorkerTabConnection.open([record('a'), record('b')], factory, 0, 'a')
    const second = await SharedWorkerTabConnection.open([record('a'), record('b')], factory, 0, 'a')
    const broadcast = new Promise<string>((resolve) => {
      first.connection.onSnapshot((snapshot) => resolve(snapshot.active))
    })
    const snapshot = await second.connection.mutate({
      ...mutation('activate-b', [], [], ['a', 'b']),
      active: 'b',
    })

    expect(snapshot.active).toBe('b')
    expect(await broadcast).toBe('b')
  })

  it('turns an expired port response into a reconnect signal', async () => {
    vi.useFakeTimers()
    const authority = new SharedWorkerTabAuthority()
    const factory: WorkspaceWorkerPortFactory = () => {
      const renderer = new MemoryPort()
      const worker = new MemoryPort()
      renderer.peer = worker
      worker.peer = renderer
      authority.connect(worker)
      return renderer
    }
    const expired = await SharedWorkerTabConnection.open([record('a')], factory, 0, 'a')
    const survivor = await SharedWorkerTabConnection.open([record('a')], factory, 0, 'a')
    clearInterval((expired.connection as unknown as {
      heartbeat: ReturnType<typeof setInterval>
    }).heartbeat)
    const disconnected = new Promise<string>((resolve) => {
      expired.connection.onDisconnect((error) => resolve(error.message))
    })

    await vi.advanceTimersByTimeAsync(SharedWorkerTabAuthority.PORT_LEASE_MS + 15_001)
    await expect(expired.connection.mutate(mutation('late', [record('b')], [], ['a', 'b'])))
      .rejects.toThrow('workspace connection is not open')
    expect(await disconnected).toBe('workspace connection is not open')
    survivor.connection.close()
  })

  it('does not replay an operation covered by another window persisted snapshot', async () => {
    const authority = new SharedWorkerTabAuthority()
    const factory = factoryFor(authority)
    const actorA = await SharedWorkerTabConnection.open([record('a')], factory, 5, 'a')
    const create = {
      ...mutation('a-create', [record('t')], [], ['a', 't']),
      actorId: 'actor-a', sequence: 0, baseRevision: 5,
    }
    await actorA.connection.mutate(create)
    const actorB = await SharedWorkerTabConnection.open([], factory)
    const persisted = await actorB.connection.mutate({
      ...mutation('b-close', [], ['t'], ['a']),
      actorId: 'actor-b', sequence: 0, baseRevision: 6,
    })

    const restartedAuthority = new SharedWorkerTabAuthority()
    const restarted = await SharedWorkerTabConnection.open(
      persisted.tabs,
      factoryFor(restartedAuthority),
      persisted.revision,
      persisted.active,
      persisted.operationWatermarks,
    )
    const replayed = await restarted.connection.mutate(create)
    expect(replayed.tabs.map((tab) => tab.id)).toEqual(['a'])
    expect(replayed.revision).toBe(persisted.revision)
  })
})
