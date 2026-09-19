import type { CommandInvocation, Json, MaterializeFrame } from '@dinkster/core'
import type { WidgetEditorState } from './WidgetEditorController.js'

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
            frames: frames.map((frame) => ({ construct: frame.construct, members: [...frame.members] })),
          },
        },
        { command: action.command, params: action.params },
      ],
    },
  } as CommandInvocation
}

export function dynamicSelectorCommitCommand(
  ed: WidgetEditorState,
  value: Json,
): CommandInvocation | undefined {
  if (ed.target.kind !== 'input' || ed.target.selector === undefined) return undefined
  const owner = ed.target.selector.owner
  if (owner !== undefined) {
    return withMaterializeFrames(owner.graphId, owner.nodeId, ed.target.materialize, {
      command: 'dynamic.selectOption',
      params: {
        graphId: owner.graphId,
        nodeId: owner.nodeId,
        construct: owner.construct,
        option: String(value),
        ...(owner.ancestors === undefined ? {} : { ancestors: owner.ancestors }),
      },
    })
  }
  return withMaterializeFrames(ed.graphId, ed.target.nodeId, ed.target.materialize, {
    command: 'dynamic.selectOption',
    params: {
      graphId: ed.graphId,
      nodeId: ed.target.nodeId,
      construct: ed.target.selector.construct,
      option: String(value),
      ...(ed.target.selector.ancestors.length === 0 ? {} : {
        ancestors: ed.target.selector.ancestors.map((ancestor) => ({
          construct: ancestor.construct,
          member: ancestor.member,
        })),
      }),
    },
  })
}
