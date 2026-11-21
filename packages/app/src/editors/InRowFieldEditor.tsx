import { createEffect, createMemo, createSignal, onCleanup, Show, type Component } from 'solid-js'
import { jsonSameValue, numericStepConstraints, randomNumericValue, type IntegerWidgetValue, type Json } from '@dinkster/core'
import { numberFieldFacts } from '@dinkster/widgets'
import { CanvasRowField, CanvasSeedModeIcon, CanvasSideModes, CanvasSidePart, canvasSidePlace, type CanvasSeedMode } from '@dinkster/ui'
import type { WidgetEditorImplementationProps } from '../WidgetEditorController.js'
import { resolveTextCommit, resolveTypedNumber, stepTypedNumber, storedNumberNote } from '../widget-commit.js'
import { createTextCompletions } from './text-completions.js'

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
  // The field holds the full stored value, not the row's formatted text.
  const initialText = ed.initial === undefined || ed.initial === null ? '' : String(ed.initial)
  const [draft, setDraft] = createSignal(initialText)
  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  let live = true
  let input: HTMLInputElement | undefined
  onCleanup(() => { live = false })

  // Text keeps today's suggestion list. It is part of the open field: while
  // it is open, Tab and Enter pick and Escape closes only the list.
  const completions = numeric ? undefined : createTextCompletions(host, () => live, (control) => setDraft(control.value))
  const suggest = (trigger: string): void => {
    if (completions !== undefined && input !== undefined) completions.requestCompletions(input, trigger)
  }
  createEffect(() => {
    if (completions === undefined || input === undefined) return
    const open = completions.open()
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-expanded', String(open))
    const active = completions.interaction.activeOptionId(completions.entries())
    if (open) input.setAttribute('aria-controls', completions.interaction.listboxId)
    else input.removeAttribute('aria-controls')
    if (active === undefined) input.removeAttribute('aria-activedescendant')
    else input.setAttribute('aria-activedescendant', active)
  })

  const typed = createMemo(() =>
    numeric && draft() !== initialText ? resolveTypedNumber(draft(), spec, ed.initial as IntegerWidgetValue) : undefined)
  const note = (): string | undefined =>
    numeric && draft() === initialText ? storedNumberNote(spec, ed.initial as IntegerWidgetValue) : undefined

  // A slider keeps its fill while typing. The fill follows what Enter would
  // store while that lies inside the range, and stays where it was while the
  // text is not a number or is past a limit.
  const range = (() => {
    const min = spec.options['min']
    const max = spec.options['max']
    return ed.viewId === 'core.slider' && typeof min === 'number' && typeof max === 'number' && max > min ? { min, max } : undefined
  })()
  const fill = createMemo<number | undefined>((previous) => {
    if (range === undefined) return undefined
    const at = (value: number): number => (value - range.min) / (range.max - range.min)
    if (draft() === initialText) return at(Number(ed.initial))
    const result = typed()
    if (result?.kind !== 'store') return previous
    const value = Number(result.value)
    if (result.problem !== undefined && (value === range.min || value === range.max)) return previous
    return at(value)
  })

  // A seed's side part sets what happens after each run; the choice is
  // stored at once, as its own undo step, and the field stays open. "new
  // seed" puts a random seed in the field, stored like a typed one.
  const [mode, setMode] = createSignal<CanvasSeedMode | undefined>(inRow.controllerMode)
  const chooseMode = (next: CanvasSeedMode): void => {
    const previous = mode()
    if (next === previous || ed.target.kind !== 'input') return
    setMode(next)
    void props.commitCommand({ command: 'node.setController', params: {
      graphId: ed.target.familyOwner?.graphId ?? ed.graphId,
      nodeId: ed.target.familyOwner?.nodeId ?? ed.target.nodeId,
      inputId: ed.target.familyOwner?.valueKey ?? ed.target.valueKey,
      mode: next,
    } }, false).then((stored) => { if (!stored && live) setMode(previous) })
  }
  const newSeed = (): void => {
    setDraft(String(randomNumericValue(numericStepConstraints(spec))))
    input?.focus()
    input?.select()
  }

  const commitText = (value: string): Promise<boolean> => {
    if (ed.target.kind === 'input') {
      const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
      const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
      const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
      const current = ed.tab.store.doc.graphs[graphId]?.nodes[nodeId]?.values[inputId]
      const resolution = resolveTextCommit(ed.initial, value, current)
      if (resolution.kind === 'none') { props.close(); return Promise.resolve(true) }
      if (resolution.kind === 'splice') {
        return props.commitCommand({ command: 'text.splice', params: { graphId, nodeId, inputId, ...resolution.splice } })
      }
    }
    return props.commitValue(value)
  }

  /**
   * Store what Enter would store, or close when that is the stored value.
   * Resolves true once the field is closed, false when it stays open (a
   * store in flight or refused). A stored value rebuilds the scene, which
   * can unmount the field before the store reports back, so an unmounted
   * field counts as closed.
   */
  const commit = (): Promise<boolean> => {
    if (!live || props.commitPending()) return Promise.resolve(false)
    if (draft() === initialText) { props.close(); return Promise.resolve(true) }
    const result = typed()
    const store = !numeric
      ? commitText(draft())
      : result === undefined || result.kind === 'keep' || jsonSameValue(result.value as Json, ed.initial ?? null)
        ? (props.close(), Promise.resolve(true))
        : props.commitValue(result.value as Json)
    return store.then((closed) => closed || !live)
  }
  host.bindClickAway?.(() => { void commit() })
  onCleanup(() => host.bindClickAway?.(undefined))

  // Tab and Shift+Tab store the field and open the next or previous row of
  // the same node; Ctrl+Enter stores it and then runs the workflow. Both
  // wait for the store, so the next row opens on the updated document.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (completions?.open() === true && completions.completionKeyDown(event as KeyboardEvent & { currentTarget: HTMLInputElement })) return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      const queue = host.app.commands.get('workflow.queue')
      void commit().then((closed) => { if (closed && queue?.enabled?.() !== false) queue?.run() })
    } else if (event.key === 'Enter') { event.preventDefault(); void commit() }
    else if (event.key === 'Escape') { event.preventDefault(); props.close() }
    else if (event.key === 'Tab') {
      event.preventDefault()
      const direction = event.shiftKey ? -1 : 1
      const target = ed.target
      if (target.kind !== 'input') return
      void commit().then((closed) => { if (closed) host.moveRow?.({ nodeId: target.nodeId, valueKey: target.valueKey }, direction) })
    }
  }

  // A number is selected. Text opened by a click has its cursor where it was
  // clicked; text opened by Tab is selected.
  const placeCursor = (element: HTMLInputElement): void => {
    element.focus()
    const at = inRow.caret === undefined ? null : document.caretPositionFromPoint?.(inRow.caret.x, inRow.caret.y)
    if (at !== null && at !== undefined && at.offsetNode === element) element.setSelectionRange(at.offset, at.offset)
    else if (inRow.caret !== undefined && !numeric) element.setSelectionRange(element.value.length, element.value.length)
    else element.select()
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
    if (facts.length === 0 && problem === undefined && result === undefined && inRow.help === undefined && inRow.controllerMode === undefined) return undefined
    return (
      <CanvasSidePart
        {...(inRow.controllerMode === undefined ? {} : {
          children: (
            <CanvasSideModes
              current={mode()!}
              step={String(numericStepConstraints(spec).step)}
              onMode={chooseMode}
              onNewSeed={newSeed}
            />
          ),
        })}
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
        onInput={(value) => {
          setDraft(value)
          suggest(value.at((input?.selectionStart ?? 0) - 1) ?? '')
        }}
        onKeyDown={onKeyDown}
        inputRef={(element) => {
          input = element
          if (completions !== undefined) {
            completions.anchor(element, () => element.closest<HTMLElement>('.dinkster-canvas-field-row'))
            element.addEventListener('click', () => suggest(''))
            element.addEventListener('keyup', (event) => {
              if (completions.entries().length === 0 && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) suggest('')
            })
          }
          queueMicrotask(() => placeCursor(element))
        }}
        inputLabel={`Edit ${ed.label}`}
        {...(typeof spec.options['placeholder'] === 'string' ? { placeholder: spec.options['placeholder'] } : {})}
        {...(numeric ? {
          onStep: (direction: -1 | 1, fast: boolean) => {
            setDraft(stepTypedNumber(draft(), spec, ed.initial as IntegerWidgetValue, direction, fast))
            input?.focus()
          },
        } : {})}
        {...(fill() === undefined ? {} : { fill: fill()! })}
        {...(inRow.controllerMode === undefined ? {} : { mark: <CanvasSeedModeIcon mode={mode()!} /> })}
        place={placement().place}
        sideTop={placement().sideTop}
        onSideSize={setSideSize}
        {...(side() === undefined ? {} : { side: side()! })}
      />
      {completions === undefined ? null : <completions.Suggestions />}
      <Show when={props.commitError()}>
        {(error) => <p class="dinkster-canvas-side-problem" role="alert" data-testid="widget-commit-error">{error()}</p>}
      </Show>
    </div>
  )
}
