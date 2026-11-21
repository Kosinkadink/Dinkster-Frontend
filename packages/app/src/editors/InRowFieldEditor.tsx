import { createMemo, createSignal, onCleanup, Show, type Component } from 'solid-js'
import { jsonSameValue, type IntegerWidgetValue, type Json } from '@dinkster/core'
import { numberFieldFacts } from '@dinkster/widgets'
import { CanvasRowField, CanvasSidePart, canvasSidePlace } from '@dinkster/ui'
import type { WidgetEditorImplementationProps } from '../WidgetEditorController.js'
import { resolveTextCommit, resolveTypedNumber, stepTypedNumber, storedNumberNote } from '../widget-commit.js'

/**
 * A number, single-line text or seed row edited in its own row on the
 * canvas. The field sits on the row's field box and follows the canvas as it
 * pans and zooms; its side part says what Enter will store. Values are
 * stored through the same controller paths as the card, so undo and the
 * commands sent are unchanged.
 */
export const InRowFieldImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const host = props.editor
  const ed = host.ed
  const spec = ed.spec!
  const inRow = ed.inRow!
  const numeric = spec.widgetType === 'INT' || spec.widgetType === 'FLOAT'
  const initialText = ed.initial === undefined || ed.initial === null ? '' : String(ed.initial)
  const [draft, setDraft] = createSignal(initialText)
  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  let live = true
  let input: HTMLInputElement | undefined
  onCleanup(() => { live = false })

  const typed = createMemo(() =>
    numeric && draft() !== initialText ? resolveTypedNumber(draft(), spec, ed.initial as IntegerWidgetValue) : undefined)
  const note = (): string | undefined =>
    numeric && draft() === initialText ? storedNumberNote(spec, ed.initial as IntegerWidgetValue) : undefined

  const commitText = (value: string): void => {
    if (ed.target.kind === 'input') {
      const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
      const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
      const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
      const current = ed.tab.store.doc.graphs[graphId]?.nodes[nodeId]?.values[inputId]
      const resolution = resolveTextCommit(ed.initial, value, current)
      if (resolution.kind === 'none') { props.close(); return }
      if (resolution.kind === 'splice') {
        void props.commitCommand({ command: 'text.splice', params: { graphId, nodeId, inputId, ...resolution.splice } })
        return
      }
    }
    void props.commitValue(value)
  }

  /** Store what Enter would store, or close when that is the stored value. */
  const commit = (): void => {
    if (!live || props.commitPending()) return
    if (draft() === initialText) { props.close(); return }
    if (!numeric) { commitText(draft()); return }
    const result = typed()
    if (result === undefined || result.kind === 'keep' || jsonSameValue(result.value as Json, ed.initial ?? null)) {
      props.close()
      return
    }
    void props.commitValue(result.value as Json)
  }
  host.bindClickAway?.(commit)
  onCleanup(() => host.bindClickAway?.(undefined))

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (event.key === 'Enter') { event.preventDefault(); commit() }
    else if (event.key === 'Escape') { event.preventDefault(); props.close() }
  }

  // The open field is the row's field box grown by one pixel on every side in
  // the flat-title look, so its outline sits half in the gap between rows. It
  // keeps its normal size when zoomed out and scales with the canvas when
  // zoomed in.
  const grow = inRow.look === 'flat-title' ? 1 : 0
  const rowWidth = ed.rect.width + grow * 2
  const placement = createMemo(() => {
    const viewport = host.viewport()
    const scale = viewport.scale
    const screen = {
      x: ed.rect.x * scale + viewport.x - grow,
      y: ed.rect.y * scale + viewport.y - grow,
      width: rowWidth * Math.max(1, scale),
      height: (ed.rect.height + grow * 2) * Math.max(1, scale),
    }
    const bounds = { x: 0, y: 0, width: host.boundary?.clientWidth ?? Infinity, height: host.boundary?.clientHeight ?? Infinity }
    return {
      screen,
      scale,
      place: canvasSidePlace(screen, bounds, sideSize().width * Math.max(1, scale), scale),
      sideTop: (inRow.nodeBottom - ed.rect.y) * scale + grow,
    }
  })

  const side = createMemo(() => {
    const facts = numeric ? numberFieldFacts(spec).map((fact) => ({ key: fact.key, value: fact.text })) : []
    const resolved = typed()
    const problem = resolved?.problem ?? note()
    const result = resolved?.kind === 'store' ? resolved.result : undefined
    if (facts.length === 0 && problem === undefined && result === undefined && inRow.help === undefined) return undefined
    return (
      <CanvasSidePart
        facts={facts}
        {...(result === undefined ? {} : { result })}
        {...(problem === undefined ? {} : { problem })}
        {...(inRow.help === undefined ? {} : { help: inRow.help })}
      />
    )
  })

  return (
    <div
      class="widget-in-row-field"
      data-testid="widget-in-row-field"
      style={{
        position: 'absolute',
        left: `${placement().screen.x}px`,
        top: `${placement().screen.y}px`,
        'transform-origin': '0 0',
        transform: placement().scale > 1 ? `scale(${placement().scale})` : undefined,
      }}
    >
      <CanvasRowField
        look={inRow.look}
        rowWidth={rowWidth}
        label={ed.label}
        value={draft()}
        onInput={setDraft}
        onKeyDown={onKeyDown}
        inputRef={(element) => { input = element; queueMicrotask(() => { element.focus(); element.select() }) }}
        inputLabel={`Edit ${ed.label}`}
        {...(typeof spec.options['placeholder'] === 'string' ? { placeholder: spec.options['placeholder'] } : {})}
        {...(numeric ? {
          onStep: (direction: -1 | 1, fast: boolean) => {
            setDraft(stepTypedNumber(draft(), spec, ed.initial as IntegerWidgetValue, direction, fast))
            input?.focus()
          },
        } : {})}
        place={placement().place}
        sideTop={placement().sideTop}
        onSideSize={setSideSize}
        {...(side() === undefined ? {} : { side: side()! })}
      />
      <Show when={props.commitError()}>
        {(error) => <p class="dinkster-canvas-side-problem" role="alert" data-testid="widget-commit-error">{error()}</p>}
      </Show>
    </div>
  )
}
