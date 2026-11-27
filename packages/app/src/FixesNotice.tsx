import { Show, createMemo, onCleanup, onMount } from 'solid-js'
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
 * at the canvas's bottom centre until it is dismissed, saved or closed.
 */
export function FixesNotice(props: { app: AppState; tab: Tab }) {
  const message = useAppMessage()
  const strings = useFixesNoticeStrings()
  const notices = useSignal(props.app.adjustmentNotices)
  const document = createMemo(() => useSignal(props.tab.store.document))
  const notice = () => notices().get(props.tab.id)
  const state = createMemo(() => {
    document()()
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
      ].join('\n'),
      count: adjustment.count,
    })),
  )
  const choose = (target: string) => {
    const adjustments = notice()?.adjustments.filter((candidate) => targetOf(candidate) === target) ?? []
    const adjustment = adjustments[0]
    if (adjustment?.anchor === undefined) return
    const row = adjustments.every((candidate) => candidate.rowValueKey === adjustment.rowValueKey)
      ? adjustment.rowValueKey : undefined
    props.app.activeTabId.set(props.tab.id)
    props.app.diagnosticFocus.set({ tab: props.tab, anchor: adjustment.anchor,
      ...(row === undefined ? {} : { focusRow: row }) })
  }
  return (
    <Show when={notice() !== undefined && !notice()!.dismissed && state()}>
      {(current) => (
        <div class="canvas-fixes-notice" data-testid="fixes-notice" ref={(element) => onMount(() => {
          const stage = element.closest<HTMLElement>('.canvas-stage')
          const controls = stage?.querySelector<HTMLElement>('.canvas-corner-controls')
          if (!stage || !controls) return
          const place = () => {
            const area = stage.getBoundingClientRect()
            element.style.setProperty('--canvas-fixes-width', `${area.width - 20}px`)
            const line = element.querySelector<HTMLElement>('.dinkster-fixes-line')!.getBoundingClientRect()
            const review = element.querySelector<HTMLElement>('.dinkster-fixes-review')?.getBoundingClientRect()
            const corner = controls.getBoundingClientRect()
            const touches = Math.max(line.right, review?.right ?? line.right) + 8 > corner.left &&
              Math.min(line.left, review?.left ?? line.left) - 8 < corner.right
            element.style.bottom = `${touches ? area.bottom - corner.top + 6 : 10}px`
          }
          const observer = new ResizeObserver(place)
          for (const target of [stage, controls, element]) observer.observe(target)
          const review = new MutationObserver(place)
          review.observe(element, { childList: true, subtree: true })
          place()
          onCleanup(() => { observer.disconnect(); review.disconnect() })
        })}>
          <ProductFixesNotice
            changes={changes()}
            state={current()}
            strings={{ ...strings(),
              ...(notice()!.adjustments.some(adjustment => adjustment.kind === 'outputCount')
                ? { refused: message('fixesNotice.countRefused') } : {}),
              ...(notice()!.undone?.kept ? { undone: message('fixesNotice.undoneKept', { count: notice()!.undone!.kept }) } : {}),
            }}
            reviewOpen={notice()!.reopened === true}
            onChoose={choose}
            onUndo={() => props.app.undoAdjustments(props.tab.id)}
            onRedo={() => props.app.redoAdjustments(props.tab.id)}
            onDismiss={() => props.app.dismissAdjustmentNotice(props.tab.id)}
            onSettings={() => {
              props.app.settingsOpenRequest.set({ category: 'execution', id: 'execution.reviewUpgrades' })
              props.app.modalPanel.set('settings')
            }}
          />
        </div>
      )}
    </Show>
  )
}
