import type {
  CommandInvocation,
  CommandOutcome,
  DocumentSession,
} from '@dinkster/core'
import {
  demoAddPosition,
  demoEditSource,
  planLink,
  planMarker,
  planMoves,
  planNodeAdd,
  type DemoEditOptions,
} from './edits.js'

export interface RunDemoEditOptions extends DemoEditOptions {
  readonly delayMs?: number
  readonly onDispatch?: (invocation: CommandInvocation, outcome: CommandOutcome) => void
}

export interface DemoEditResult {
  readonly firstNodeId: string
  readonly secondNodeId?: string
  readonly dispatchCount: number
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

function addedNodeId(before: readonly string[], outcome: CommandOutcome): string {
  if (!outcome.ok) throw new Error('cannot inspect a rejected node.add outcome')
  const previous = new Set(before)
  const added = Object.keys(outcome.doc.graphs[outcome.doc.root]?.nodes ?? {})
    .filter((id) => !previous.has(id))
  if (added.length !== 1) {
    throw new Error(`node.add created ${added.length} nodes instead of one`)
  }
  return added[0]!
}

export async function runDemoEdits(
  session: DocumentSession,
  opts: RunDemoEditOptions = {},
): Promise<DemoEditResult> {
  const source = demoEditSource(session.doc, opts)
  const delayMs = opts.delayMs ?? 300
  let dispatchCount = 0

  const dispatch = async (invocation: CommandInvocation): Promise<CommandOutcome> => {
    const outcome = session.dispatch(invocation)
    dispatchCount += 1
    opts.onDispatch?.(invocation, outcome)
    if (!outcome.ok) {
      const detail = outcome.diagnostics.map((diagnostic) => diagnostic.message).join('; ')
      throw new Error(`${invocation.command} failed: ${detail}`)
    }
    if (delayMs > 0) await sleep(delayMs)
    return outcome
  }

  const beforeFirst = Object.keys(session.doc.graphs[source.graphId]!.nodes)
  const firstOutcome = await dispatch(planNodeAdd(source.graphId, source.first))
  const firstNodeId = addedNodeId(beforeFirst, firstOutcome)
  let secondNodeId: string | undefined

  if (source.second !== undefined && source.ports !== undefined) {
    const beforeSecond = Object.keys(session.doc.graphs[source.graphId]!.nodes)
    const secondOutcome = await dispatch(planNodeAdd(source.graphId, source.second))
    secondNodeId = addedNodeId(beforeSecond, secondOutcome)
    await dispatch(planLink(source.graphId, firstNodeId, secondNodeId, source.ports))
  }

  await dispatch(planMarker(source.graphId, firstNodeId, source.first.node))
  const start = demoAddPosition(source.first.position)
  for (const invocation of planMoves(source.graphId, firstNodeId, start)) {
    await dispatch(invocation)
  }

  return {
    firstNodeId,
    ...(secondNodeId !== undefined ? { secondNodeId } : {}),
    dispatchCount,
  }
}
