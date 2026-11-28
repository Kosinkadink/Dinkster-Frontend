import type { CommandInvocation, Json, MaterializeFrame } from '@dinkster/core'
import type { EditorTarget } from './WidgetEditorController.js'

/** Materialization and its triggering write must remain one undoable command. */
export function withMaterializeFrames(
  graphId: string,
  nodeId: string,
  frames: readonly MaterializeFrame[] | undefined,
  action: CommandInvocation,
): CommandInvocation {
  if (frames === undefined || frames.length === 0) return action
  return {
    command: 'batch',
    params: {
      invocations: [
        {
          command: 'dynamic.materialize',
          params: {
            graphId,
            nodeId,
            frames: frames.map((frame) => ({ ...frame, members: [...frame.members] })),
          },
        },
        { command: action.command, params: action.params },
      ],
    },
  } as CommandInvocation
}

/** Build an input write independently of an editor's mounted lifetime. */
export function widgetInputValueCommand(
  graphId: string,
  target: Extract<EditorTarget, { kind: 'input' }>,
  value: Json,
): CommandInvocation {
  const owner = target.familyOwner
  if (target.selector === undefined) {
    return withMaterializeFrames(owner?.graphId ?? graphId, owner?.nodeId ?? target.nodeId, target.materialize, {
      command: 'node.setValue',
      params: {
        graphId: owner?.graphId ?? graphId,
        nodeId: owner?.nodeId ?? target.nodeId,
        inputId: owner?.valueKey ?? target.valueKey,
        value,
      },
    })
  }
  // A choice shown whole on a subgraph node is picked on that node.
  if (owner?.valueKey !== undefined) {
    return {
      command: 'dynamic.selectOption',
      params: { graphId: owner.graphId, nodeId: owner.nodeId, construct: owner.valueKey, option: String(value) },
    }
  }
  return withMaterializeFrames(graphId, target.nodeId, target.materialize, {
    command: 'dynamic.selectOption',
    params: {
      graphId,
      nodeId: target.nodeId,
      construct: target.selector.construct,
      option: String(value),
    },
  })
}
