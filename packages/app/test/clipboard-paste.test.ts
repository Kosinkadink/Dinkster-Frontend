/**
 * pasteClipboardIntoTab unit tests: invocation-time
 * ownership held across the clipboard read - a tab that closed,
 * navigated, or froze during the await refuses without touching the
 * document, planner, or dispatch; a live owner commits the plan and
 * reports the fresh ids.
 */
import { describe, expect, it, vi } from 'vitest'
import { serializeSelection, type WorkflowDocument } from '@dinkster/core'
import { pasteClipboardIntoTab, type ClipboardPasteOutcome } from '../src/clipboard-paste.js'

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage' as never, root: 'g0' as never,
  graphs: { g0: {
    id: 'g0' as never, name: 'root', nextOrdinal: 10, nets: {}, reroutes: {}, links: {},
    nodes: { a: { id: 'a' as never, type: 'Producer', values: { seed: 7 } } },
  } },
  view: { graphs: { g0: { nodes: { a: { position: { x: 100, y: 200 } } } } } },
})

/** A real envelope produced by the same serializer the copy path uses. */
const envelopeText = (): string =>
  JSON.stringify(serializeSelection(document(), 'g0', { nodes: ['a'], reroutes: [] }))

interface Overrides {
  readonly readText?: () => Promise<string | undefined>
  readonly tabStillOpen?: () => boolean
  readonly frozen?: () => boolean
  readonly currentGraphId?: () => string
  readonly graphStillOwned?: () => boolean
  readonly dispatch?: (invocation: unknown) => boolean
  readonly connectInputs?: boolean
  readonly actor?: string
}

const run = async (overrides: Overrides = {}): Promise<{
  outcome: ClipboardPasteOutcome
  dispatch: ReturnType<typeof vi.fn>
  onPasted: ReturnType<typeof vi.fn>
  doc: ReturnType<typeof vi.fn>
}> => {
  const dispatch = vi.fn(overrides.dispatch ?? (() => true))
  const onPasted = vi.fn()
  const doc = vi.fn(() => document())
  const outcome = await pasteClipboardIntoTab({
    readText: overrides.readText ?? (() => Promise.resolve(envelopeText())),
    graphId: 'g0',
    anchor: { x: 20, y: 30 },
    ...(overrides.connectInputs !== undefined ? { connectInputs: overrides.connectInputs } : {}),
    ...(overrides.actor !== undefined ? { actor: overrides.actor } : {}),
    tabStillOpen: overrides.tabStillOpen ?? (() => true),
    frozen: overrides.frozen ?? (() => false),
    currentGraphId: overrides.currentGraphId ?? (() => 'g0'),
    graphStillOwned: overrides.graphStillOwned ?? (() => true),
    doc,
    dispatch,
    onPasted,
  })
  return { outcome, dispatch, onPasted, doc }
}

describe('pasteClipboardIntoTab (review AP8)', () => {

  it('commits a live owner: plans against the owner doc and reports fresh ids', async () => {
    const { outcome, dispatch, onPasted } = await run()
    expect(outcome).toBe('pasted')
    expect(dispatch).toHaveBeenCalledTimes(1)
    // Plan ids allocate from the owner document's nextOrdinal (10).
    expect(onPasted).toHaveBeenCalledWith(['n10'], [])
  })

  it('a tab closed during the read refuses without reading the doc or dispatching', async () => {
    const { outcome, dispatch, onPasted, doc } = await run({ tabStillOpen: () => false })
    expect(outcome).toBe('stale-tab')
    expect(doc).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(onPasted).not.toHaveBeenCalled()
  })

  it('a graph navigation during the read refuses (ownership before payload)', async () => {
    const { outcome, dispatch, doc } = await run({ currentGraphId: () => 'g1' })
    expect(outcome).toBe('stale-graph')
    expect(doc).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a tab frozen during the read refuses', async () => {
    const { outcome, dispatch } = await run({ frozen: () => true })
    expect(outcome).toBe('frozen')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('unreadable and non-envelope text are silent non-events', async () => {
    expect((await run({ readText: () => Promise.resolve(undefined) })).outcome).toBe('no-text')
    expect((await run({ readText: () => Promise.resolve('not json') })).outcome).toBe('unrecognized')
    expect((await run({ readText: () => Promise.resolve('{"some":"json"}') })).outcome).toBe('unrecognized')
  })

  it.each([false, true])('waits for final dispatch result %s before announcing pasted ids', async (accepted) => {
    let settle!: (accepted: boolean) => void
    const result = new Promise<boolean>((resolve) => { settle = resolve })
    let started!: () => void
    const dispatched = new Promise<void>((resolve) => { started = resolve })
    const onPasted = vi.fn()
    let finished = false
    const pending = pasteClipboardIntoTab({
      readText: async () => envelopeText(), graphId: 'g0', anchor: { x: 20, y: 30 },
      tabStillOpen: () => true, frozen: () => false, currentGraphId: () => 'g0', graphStillOwned: () => true,
      doc: document, dispatch: () => { started(); return result }, onPasted,
    }).then((outcome) => { finished = true; return outcome })
    await dispatched
    expect(finished).toBe(false)
    expect(onPasted).not.toHaveBeenCalled()
    settle(accepted)
    expect(await pending).toBe(accepted ? 'pasted' : 'rejected')
    expect(onPasted.mock.calls).toEqual(accepted ? [[['n10'], []]] : [])
  })
})
