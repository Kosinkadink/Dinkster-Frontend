import { jsonSameValue, type CommandInvocation, type Json } from '@dinkster/core'
import { onCleanup, type Component } from 'solid-js'
import { videoEditContext } from '../video-edit-context.js'
import { VideoEditEditor } from '../VideoEditEditor.js'
import {
  WidgetEditorController,
  withMaterializeFrames,
  type WidgetEditorImplementationProps,
  type WidgetEditorProps,
} from '../WidgetEditorController.js'

const VideoEditImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const context = ed.target.kind === 'input'
    ? videoEditContext(props.editor.app, ed.tab, ed.target.familyOwner?.graphId ?? ed.graphId,
        ed.target.familyOwner?.nodeId ?? ed.target.nodeId, ed.instancePath)
    : undefined
  const revision = ed.tab.store.revision
  const initial = context?.initial ?? (ed.initial === undefined ? {} : ed.initial)
  let live = true
  onCleanup(() => { live = false })

  const commit = (value: Json, strictDuration: boolean): void => {
    if (!live || context?.editDisabledReason) return
    if (ed.tab.execution || ed.tab.store.revision !== revision) { props.close(); return }
    if (ed.target.kind === 'valueSource') {
      if (jsonSameValue(value, initial)) props.close()
      else props.commitValue(value)
      return
    }
    const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
    const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
    const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
    const invocations: CommandInvocation[] = jsonSameValue(value, initial) ? [] : [{
      command: 'node.setValue',
      params: { graphId, nodeId, inputId, value },
    }]
    if (context?.strictDuration !== undefined && context.strictDisabledReason === undefined && strictDuration !== context.strictDuration) {
      invocations.push({
        command: 'node.setValue',
        params: { graphId, nodeId, inputId: 'strict_duration', value: strictDuration },
      })
    }
    props.close()
    if (invocations.length === 0) return
    const action: CommandInvocation = invocations.length === 1
      ? invocations[0]!
      : { command: 'batch', params: { invocations } } as unknown as CommandInvocation
    props.editor.app.dispatchTo(ed.tab, withMaterializeFrames(graphId, nodeId, ed.target.materialize, action))
  }

  return <div
    class="widget-editor widget-modal-editor video-edit-modal"
    data-testid="widget-editor"
    data-editor-mode="VIDEO_EDIT"
    data-editor-surface="modal"
  >
    <props.header type="VIDEO_EDIT" />
    <VideoEditEditor
      value={initial}
      spec={ed.spec!}
      {...context}
      onCommit={commit}
      onCancel={props.close}
    />
  </div>
}

export const VideoEditWidgetEditor: Component<WidgetEditorProps> = (props) => (
  <WidgetEditorController
    {...props}
    implementation={VideoEditImplementation}
    modal={{
      type: 'VIDEO_EDIT',
      help: 'Edit the one-clip trim and crop node inputs. Cancel or close leaves the stored values unchanged.',
      onRequestClose: (close) => close(),
    }}
  />
)
