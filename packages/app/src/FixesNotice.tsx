import { Show, createMemo } from 'solid-js'
import {
  ProductFixesNotice,
  type FixesNoticeChange,
  type FixesNoticeStrings,
} from '@dinkster/ui'
import type { Adjustment, AppState, Tab } from './app-state.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'

const targetOf = (adjustment: Adjustment) =>
  JSON.stringify([adjustment.graphId, adjustment.anchor?.occurrence?.instancePath ?? null, adjustment.nodeId])

/** The notice's words in the app's language. */
export function useFixesNoticeStrings(): () => FixesNoticeStrings {
  const message = useAppMessage()
  return () => ({
    adjusted: (count) => message('fixesNotice.adjusted', { count }),
    undone: message('fixesNotice.undone'),
    review: message('fixesNotice.review'),
    undo: message('fixesNotice.undo'),
    redo: message('fixesNotice.redo'),
    dismiss: message('fixesNotice.dismiss'),
    refused: message('fixesNotice.refused'),
    heading: message('fixesNotice.heading'),
    summary: (changes, nodes) => message('fixesNotice.summary', { changes, nodes }),
    group: (kind, count) => message('fixesNotice.group', { kind: message(`fixesNotice.kind.${kind}`), count }),
    settings: message('fixesNotice.settings'),
  })
}

/**
 * The active workflow tab's notice of the changes the editor made by itself,
 * in the canvas's bottom right corner until it is dismissed, saved or closed.
 */
export function FixesNotice(props: { app: AppState; tab: Tab }) {
  const message = useAppMessage()
  const strings = useFixesNoticeStrings()
  const notices = useSignal(props.app.adjustmentNotices)
  const document = useSignal(props.tab.store.document)
  const notice = () => notices().get(props.tab.id)
  const state = createMemo(() => {
    document()
    notices()
    return props.app.adjustmentNoticeState(props.tab.id)
  })
  const changes = createMemo((): readonly FixesNoticeChange[] =>
    (notice()?.adjustments ?? []).map((adjustment, index) => ({
      id: String(index),
      kind: adjustment.kind,
      target: targetOf(adjustment),
      node: adjustment.node,
      text: [
        ...(adjustment.kind === 'replaced' ? [message('fixesNotice.change.replaced')] : []),
        ...adjustment.details,
      ].join(' '),
      count: adjustment.count,
    })),
  )
  const choose = (target: string) => {
    const adjustment = notice()?.adjustments.find((candidate) => targetOf(candidate) === target)
    if (adjustment?.anchor === undefined) return
    props.app.activeTabId.set(props.tab.id)
    props.app.diagnosticFocus.set({ tab: props.tab, anchor: adjustment.anchor })
  }
  return (
    <Show when={notice() !== undefined && !notice()!.dismissed && state()}>
      {(current) => (
        <div class="canvas-fixes-notice" data-testid="fixes-notice">
          <ProductFixesNotice
            changes={changes()}
            state={current()}
            strings={strings()}
            reviewOpen={notice()!.reopened === true}
            onChoose={choose}
            onUndo={() => props.app.undoAdjustments(props.tab.id)}
            onRedo={() => props.app.redoAdjustments(props.tab.id)}
            onDismiss={() => props.app.dismissAdjustmentNotice(props.tab.id)}
            onSettings={() => props.app.modalPanel.set('settings')}
          />
        </div>
      )}
    </Show>
  )
}
