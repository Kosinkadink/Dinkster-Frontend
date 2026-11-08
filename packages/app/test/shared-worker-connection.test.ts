import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COLLAB_PROTOCOL_VERSION,
  asGraphDefId,
  asLineageId,
  asNodeId,
  coreCommandRegistry,
  type CollabClientOp,
  type Json,
  type WorkflowDocument,
} from '@dinkster/core'
import { SharedWorkerDocumentAuthority, type WorkerPortLike } from '../src/shared-worker-authority.js'
import {
  SharedWorkerCollabConnection,
  connectSharedWorkerSession,
  type SharedWorkerPortFactory,
} from '../src/shared-worker-connection.js'

class MemoryPort implements WorkerPortLike {
  peer: MemoryPort | undefined
  closed = false
  paused = false
  private readonly queued: unknown[] = []
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()
  postMessage(message: unknown): void {
    if (this.closed) return
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
  close(): void { this.closed = true }
  release(): void {
    this.paused = false
    for (const data of this.queued.splice(0)) {
      for (const listener of this.listeners) listener({ data } as MessageEvent<unknown>)
    }
  }
}

afterEach(() => vi.useRealTimers())

const channel = (): [MemoryPort, MemoryPort] => {
  const first = new MemoryPort()
  const second = new MemoryPort()
  first.peer = second
  second.peer = first
  return [first, second]
}

const harness = (): { authority: SharedWorkerDocumentAuthority; factory: SharedWorkerPortFactory } => {
  const authority = new SharedWorkerDocumentAuthority()
  return {
    authority,
    factory: () => {
      const [renderer, worker] = channel()
      authority.connect(worker)
      return renderer
    },
  }
}

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('lineage'),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'),
      name: 'root',
      nodes: { n1: { id: asNodeId('n1'), type: 'X', values: {} } },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 10,
    },
  },
  view: { graphs: {} },
})

const title = (value: string) => ({
  command: 'node.setTitle',
  params: { graphId: 'g0', nodeId: 'n1', title: value },
})

describe('SharedWorker document authority', () => {
  it('orders concurrent edits, rebases the loser, and converges both shared sessions', async () => {
    const { factory } = harness()
    const revisions: number[] = []
    const first = await connectSharedWorkerSession('doc', document(), coreCommandRegistry(), { actorId: 'first' }, factory)
    const second = await connectSharedWorkerSession('doc', document(), coreCommandRegistry(), { actorId: 'second' }, factory)
    first.onOp((op) => revisions.push(op.revision))

    expect(first.dispatch(title('one')).ok).toBe(true)
    expect(second.dispatch(title('two')).ok).toBe(true)
    await Promise.all([first.settle(), second.settle()])

    expect(first.doc).toEqual(second.doc)
    expect(first.doc.graphs.g0!.nodes.n1!.title).toBe('two')
    expect(revisions).toEqual([1, 2])
  })

  it('broadcasts an edit and undo, keeps a remaining client live, and restores on reconnect', async () => {
    const { factory } = harness()
    const first = await connectSharedWorkerSession('doc', document(), coreCommandRegistry(), { actorId: 'first' }, factory)
    const second = await connectSharedWorkerSession('doc', document(), coreCommandRegistry(), { actorId: 'second' }, factory)
    expect(first.dispatch(title('changed')).ok).toBe(true)
    await first.settle()
    expect(first.undo()).toBe(true)
    await first.settle()
    expect(second.doc.graphs.g0!.nodes.n1!.title).toBeUndefined()

    first.close()
    expect(second.dispatch(title('survives')).ok).toBe(true)
    await second.settle()
    const reconnect = await connectSharedWorkerSession('doc', document(), coreCommandRegistry(), { actorId: 'third' }, factory)
    expect(reconnect.doc).toEqual(second.doc)
    expect(reconnect.revision).toBe(3)
  })

  it('forgets a workflow only after its final client closes', async () => {
    const { factory } = harness()
    const first = await connectSharedWorkerSession('doc', document(), coreCommandRegistry(), { actorId: 'first' }, factory)
    const second = await connectSharedWorkerSession('doc', document(), coreCommandRegistry(), { actorId: 'second' }, factory)
    expect(first.dispatch(title('retained')).ok).toBe(true)
    await first.settle()
    first.close()
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const whileOpen = await connectSharedWorkerSession('doc', document(), coreCommandRegistry(), { actorId: 'third' }, factory)
    expect(whileOpen.doc.graphs.g0!.nodes.n1!.title).toBe('retained')
    second.close()
    whileOpen.close()
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const fresh = { ...document(), lineage: asLineageId('lineage'), graphs: {
      ...document().graphs,
      g0: { ...document().graphs.g0!, name: 'fresh' },
    } }
    const reopened = await connectSharedWorkerSession('doc', fresh, coreCommandRegistry(), { actorId: 'fourth' }, factory)
    expect(reopened.doc.graphs.g0!.name).toBe('fresh')
    expect(reopened.revision).toBe(0)
  })

  it('allows exclusive promotion only while no peer has joined', async () => {
    const { factory } = harness()
    const first = await SharedWorkerCollabConnection.open('doc', document(), factory, 'first')
    const second = await SharedWorkerCollabConnection.open('doc', document(), factory, 'second')
    const initial = document()
    const changed: WorkflowDocument = {
      ...initial,
      graphs: {
        ...initial.graphs,
        g0: {
          ...initial.graphs.g0!,
          nodes: {
            ...initial.graphs.g0!.nodes,
            n1: { ...initial.graphs.g0!.nodes.n1!, title: 'local edit' },
          },
        },
      },
    }
    expect(await first.adoptExclusive(changed)).toBe(false)
    second.close()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(await first.adoptExclusive(changed)).toBe(true)
    expect((await first.fetchSnapshot()).document).toEqual(changed)
  })

  it('reclaims a crashed peer lease before exclusive promotion', async () => {
    vi.useFakeTimers()
    const { authority } = harness()
    let crashedPort: MemoryPort | undefined
    const factory: SharedWorkerPortFactory = () => {
      const [renderer, worker] = channel()
      authority.connect(worker)
      if (!crashedPort) crashedPort = renderer
      return renderer
    }
    const crashed = await SharedWorkerCollabConnection.open('doc', document(), factory, 'crashed')
    const survivor = await SharedWorkerCollabConnection.open('doc', document(), factory, 'survivor')
    crashedPort!.closed = true
    const initial = document()
    const adopted: WorkflowDocument = {
      ...initial,
      graphs: { ...initial.graphs, g0: { ...initial.graphs.g0!, name: 'after crash' } },
    }

    await vi.advanceTimersByTimeAsync(SharedWorkerDocumentAuthority.PORT_LEASE_MS + 15_001)
    expect(await survivor.adoptExclusive(adopted)).toBe(true)
    survivor.close()
    void crashed
  })

  it('rejects stale and malformed mutations without changing the canonical snapshot', async () => {
    const { factory } = harness()
    const connection = await SharedWorkerCollabConnection.open('doc', document(), factory)
    expect((await connection.fetchSnapshot()).revision).toBe(0)
    const valid: CollabClientOp = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      opId: 'a#1',
      actorId: 'a',
      baseRevision: 0,
      patch: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'n2'], value: { id: 'n2', type: 'X', values: {} } as Json }],
    }
    expect((await connection.postOp(valid)).kind).toBe('accepted')
    expect(await connection.postOp(valid)).toMatchObject({ kind: 'accepted', op: { replayed: true, revision: 1 } })
    expect(await connection.postOp({
      ...valid,
      patch: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'other'], value: { id: 'other', type: 'X', values: {} } as Json }],
    })).toEqual({ kind: 'error', message: 'op id was already used for different content' })
    expect((await connection.postOp({ ...valid, opId: 'stale', baseRevision: 0 })).kind).toBe('stale-base')
    const malformed = { ...valid, opId: 'bad', baseRevision: 1, patch: [{ op: 'replace', path: ['missing'], value: 1 }] } as unknown as CollabClientOp
    expect((await connection.postOp(malformed)).kind).toBe('error')
    const before = await connection.fetchSnapshot()
    expect(before.revision).toBe(1)
    expect(await connection.putSnapshot(1, { ...document(), root: asGraphDefId('missing') })).toEqual({ kind: 'conflict' })
    expect(await connection.fetchSnapshot()).toEqual(before)
  })

  it('refuses a malformed initial snapshot atomically', async () => {
    const { factory } = harness()
    let rejectedPort: MemoryPort | undefined
    const recordingFactory: SharedWorkerPortFactory = (sessionId) => {
      rejectedPort = factory(sessionId) as MemoryPort
      return rejectedPort
    }
    await expect(SharedWorkerCollabConnection.open('bad', { broken: true } as unknown as WorkflowDocument, recordingFactory))
      .rejects.toThrow('initial document failed to load')
    expect(rejectedPort?.closed).toBe(true)
    const connection = await SharedWorkerCollabConnection.open('bad', document(), factory)
    expect((await connection.fetchSnapshot()).revision).toBe(0)
  })

  it('bounds a lost worker request and closes the failed port', async () => {
    vi.useFakeTimers()
    const renderer = new MemoryPort()
    renderer.peer = new MemoryPort()
    const opening = SharedWorkerCollabConnection.open('lost', document(), () => renderer)
    const rejection = expect(opening).rejects.toThrow("request 'open' timed out")
    await vi.advanceTimersByTimeAsync(15_000)
    await rejection
    expect(renderer.closed).toBe(true)
  })
})
