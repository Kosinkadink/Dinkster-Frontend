import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, type Component, type JSX } from 'solid-js'
import { effectiveWidgetDefault, jsonSameValue, numericStepConstraints, randomNumericValue, type IntegerWidgetValue, type Json } from '@dinkster/core'
import { floatKind, intKind, numberFieldFacts } from '@dinkster/widgets'
import { CanvasRowField, CanvasSeedModeIcon, CanvasSideLink, CanvasSideModes, CanvasSidePart, ProductSpinner, type CanvasSeedMode } from '@dinkster/ui'
import { placeRow, rowPlacement, visibleCanvas } from './row-placement.js'
import type { WidgetEditorImplementationProps } from '../WidgetEditorController.js'
import { resolveTextCommit, resolveTypedNumber, stepTypedNumber, storedNumberNote, widgetCommitError } from '../widget-commit.js'
import { createTextCompletions } from './text-completions.js'
import { useAppMessage } from '../locale.js'

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
  const message = useAppMessage()
  const numeric = spec.widgetType === intKind.type || spec.widgetType === floatKind.type
  // An automatic field is empty while its value is automatic, with the value
  // in use as its hint; emptying a fixed one makes it automatic again.
  const automatic = inRow.automatic
  const unfixed = automatic !== undefined && inRow.storedAtOpen === null
  // The field holds the full stored value, not the row's formatted text.
  const initialText = unfixed || ed.initial === undefined || ed.initial === null ? '' : String(ed.initial)
  const [draft, setDraft] = createSignal(initialText)
  const emptied = (): boolean => automatic !== undefined && draft().trim() === ''
  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  const bounds = visibleCanvas(host.boundary)
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
    numeric && draft() !== initialText && !emptied() ? resolveTypedNumber(draft(), spec, ed.initial as IntegerWidgetValue) : undefined)
  const note = (): string | undefined =>
    numeric && !unfixed && draft() === initialText ? storedNumberNote(spec, ed.initial as IntegerWidgetValue) : undefined
  const problemId = createUniqueId()
  // A kept stored number's note is not a problem, so it does not mark the field invalid.
  const problem = (): string | undefined => props.commitError() ?? invalid() ?? typed()?.problem
  const shownProblem = (): string | undefined => problem() ?? note()

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
    if (next === previous) return
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
    const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
    const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
    const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
    const current = ed.tab.store.doc.graphs[graphId]?.nodes[nodeId]?.values[inputId]
    const resolution = resolveTextCommit(ed.initial, value, current)
    if (resolution.kind === 'none') { props.close(); return Promise.resolve(true) }
    if (resolution.kind === 'splice') {
      return props.commitCommand({ command: 'text.splice', params: { graphId, nodeId, inputId, ...resolution.splice } })
    }
    return props.commitValue(value)
  }
  // Removing the stored value makes an automatic field automatic again.
  const clearValue = (): Promise<boolean> => {
    if (ed.target.kind !== 'input') return Promise.resolve(false)
    return props.commitCommand({ command: 'node.setValues', params: {
      graphId: ed.target.familyOwner?.graphId ?? ed.graphId,
      nodeId: ed.target.familyOwner?.nodeId ?? ed.target.nodeId,
      values: {},
      unset: [ed.target.familyOwner?.valueKey ?? ed.target.valueKey],
    } })
  }

  // What leaving the field would do now: close (nothing changed), store a
  // value, or stay open, while a store is in flight or the value fails the
  // check every value passes before it is written.
  const [invalid, setInvalid] = createSignal<string>()
  type Plan =
    | { readonly kind: 'close' }
    | { readonly kind: 'blocked' }
    | { readonly kind: 'automatic' }
    | { readonly kind: 'store'; readonly value: Json }
  const plan = (): Plan => {
    if (!live || props.commitPending()) return { kind: 'blocked' }
    if (emptied()) return unfixed ? { kind: 'close' } : { kind: 'automatic' }
    if (draft() === initialText) return { kind: 'close' }
    let value: Json
    if (numeric) {
      const result = typed()
      if (result === undefined || result.kind === 'keep' || jsonSameValue(result.value as Json, ed.initial ?? null)) return { kind: 'close' }
      value = result.value as Json
    } else value = draft()
    const problem = widgetCommitError(host.app.widgetRegistryForTab(ed.tab).kind(spec.widgetType), value, spec)
    if (problem !== undefined) { setInvalid(problem); return { kind: 'blocked' } }
    return { kind: 'store', value }
  }

  /**
   * Store what Enter would store, or close when that is the stored value.
   * Resolves true once the field is closed, false when it stays open. A
   * stored value rebuilds the scene, which can unmount the field before the
   * store reports back, so an unmounted field counts as closed.
   */
  const commit = (): Promise<boolean> => {
    const next = plan()
    if (next.kind === 'blocked') return Promise.resolve(false)
    if (next.kind === 'close') { props.close(); return Promise.resolve(true) }
    const store = next.kind === 'automatic' ? clearValue()
      : numeric ? props.commitValue(next.value) : commitText(next.value as string)
    return store.then((closed) => closed || !live)
  }
  // A press elsewhere stores the field and goes on to what it pressed, unless
  // the field cannot be left yet; then the press does nothing.
  host.bindClickAway?.(() => {
    if (plan().kind === 'blocked') return false
    void commit()
    return true
  })
  onCleanup(() => host.bindClickAway?.(undefined))

  // Tab and Shift+Tab store the field and open the next or previous row of
  // the same node; Ctrl+Enter stores it and then runs the workflow. Both
  // wait for the store, so the next row opens on the updated document.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (completions?.open() === true && completions.completionKeyDown(event as KeyboardEvent & { currentTarget: HTMLInputElement })) return
    if (numeric && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Up and Down step what is typed, as the minus and plus do; Shift is ten steps.
      event.preventDefault()
      setDraft(stepTypedNumber(draft(), spec, ed.initial as IntegerWidgetValue, event.key === 'ArrowUp' ? 1 : -1, event.shiftKey))
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      const queue = host.app.commands.get('workflow.queue')
      void commit().then((closed) => { if (closed && queue?.enabled?.() !== false) queue?.run() })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      // Stored with Enter, the keyboard stays on the row.
      const target = ed.target
      void commit().then((closed) => {
        if (closed) host.focusRow?.({ nodeId: target.nodeId, valueKey: target.valueKey })
      })
    }
    else if (event.key === 'Escape') { event.preventDefault(); props.close() }
    else if (event.key === 'Tab') {
      event.preventDefault()
      const direction = event.shiftKey ? -1 : 1
      const target = ed.target
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

  const placement = createMemo(() => rowPlacement(
    { rect: ed.rect, look: inRow.look, nodeTop: inRow.nodeTop, nodeBottom: inRow.nodeBottom },
    host.viewport(),
    bounds(),
    sideSize(),
  ))

  // The side part's first line is a refusal or a failed check when there is
  // one; otherwise what Enter would store. The "default" line is a link that
  // stores the default, as "Reset to default" does. On an automatic field it
  // reads "automatic (24)", or "automatic (not known)" while the value cannot
  // be worked out, and its link empties the field, which makes the value
  // automatic.
  const defaultValue = effectiveWidgetDefault(spec)
  const storeDefault = (): void => {
    setDraft(automatic !== undefined || defaultValue === undefined || defaultValue === null ? '' : String(defaultValue))
    void commit()
  }
  const automaticText = automatic === undefined ? undefined
    : typeof automatic.value === 'string' ? automatic.value : JSON.stringify(automatic.value)
  const defaultLink = (text: string): JSX.Element => automatic === undefined
    ? <CanvasSideLink onClick={storeDefault}>{text}</CanvasSideLink>
    : (
        <span class="dinkster-canvas-side-loading">
          {automatic.state === 'loading' ? <ProductSpinner /> : null}
          <CanvasSideLink onClick={storeDefault}>
            {automatic.state === 'worked-out'
              ? message('automaticField.defaultLine', { value: automaticText! })
              : message('automaticField.notKnown')}
          </CanvasSideLink>
        </span>
      )
  // While the field is empty: the warning when the default is used, or one
  // plain line saying why a lookup's answer is not fresh.
  const automaticWarning = (): string | undefined => automatic?.state === 'default' && emptied()
    ? message('automaticField.warning', { field: ed.label, value: automaticText! })
    : undefined
  const lookupNote = (): string | undefined => {
    if (!emptied()) return undefined
    if (automatic?.kept === 'stale') return message('automaticField.couldNotRefresh')
    if (automatic?.kept === 'paused') return message('automaticField.paused')
    return automatic?.state === 'not-known' ? message('automaticField.offline') : undefined
  }
  const side = createMemo(() => {
    const facts = numeric
      ? numberFieldFacts(spec).map((fact) => ({
          key: fact.key,
          value: fact.key === 'default' && defaultValue !== undefined ? defaultLink(fact.text) : fact.text,
        }))
      : []
    const resolved = typed()
    const blocked = props.commitError() ?? invalid()
    const line = shownProblem() ?? automaticWarning()
    const result = blocked === undefined && resolved?.kind === 'store' ? resolved.result : undefined
    const noteLine = lookupNote()
    if (facts.length === 0 && line === undefined && result === undefined && inRow.help === undefined && inRow.controllerMode === undefined && noteLine === undefined) return undefined
    return (
      <CanvasSidePart
        {...(inRow.controllerMode === undefined && noteLine === undefined ? {} : {
          children: (
            <>
              {inRow.controllerMode === undefined ? null : (
                <CanvasSideModes
                  current={mode()!}
                  step={String(numericStepConstraints(spec).step)}
                  onMode={chooseMode}
                  onNewSeed={newSeed}
                />
              )}
              {noteLine === undefined ? null : <p class="dinkster-canvas-side-note">{noteLine}</p>}
            </>
          ),
        })}
        facts={facts}
        {...(result === undefined ? {} : { result })}
        {...(line === undefined ? {} : { problem: line, problemId })}
        {...(inRow.help === undefined ? {} : { help: inRow.help })}
      />
    )
  })

  // The field cannot be typed into while a store is in flight.
  createEffect(() => { if (input !== undefined) input.readOnly = props.commitPending() })
  // The problem line is the field's error message.
  createEffect(() => {
    if (input === undefined) return
    if (problem() === undefined) {
      input.removeAttribute('aria-invalid')
      input.removeAttribute('aria-errormessage')
    } else {
      input.setAttribute('aria-invalid', 'true')
      input.setAttribute('aria-errormessage', problemId)
    }
  })

  let frame!: HTMLDivElement
  createEffect(() => placeRow(frame, placement()))

  return (
    <div
      ref={frame}
      class="widget-in-row-field"
      data-testid="widget-editor"
      data-editor-target={ed.target.kind}
      data-editor-mode={spec.widgetType}
      data-editor-surface="in-row"
    >
      <CanvasRowField
        look={inRow.look}
        rowWidth={placement().rowWidth}
        label={ed.label}
        value={draft()}
        onInput={(value) => {
          setDraft(value)
          setInvalid(undefined)
          suggest(value.at((input?.selectionStart ?? 0) - 1) ?? '')
        }}
        onKeyDown={onKeyDown}
        inputRef={(element) => {
          input = element
          element.setAttribute('aria-description', spec.widgetType)
          if (completions !== undefined) {
            completions.anchor(element, () => element.closest<HTMLElement>('.dinkster-canvas-field-row'))
            element.addEventListener('click', () => suggest(''))
            element.addEventListener('keyup', (event) => {
              if (completions.entries().length === 0 && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) suggest('')
            })
          }
          queueMicrotask(() => placeCursor(element))
        }}
        inputLabel={ed.label}
        {...(automaticText !== undefined ? { placeholder: automaticText }
          : typeof spec.options['placeholder'] === 'string' ? { placeholder: spec.options['placeholder'] } : {})}
        {...(numeric ? {
          onStep: (direction: -1 | 1, fast: boolean) => {
            setDraft(stepTypedNumber(draft(), spec, ed.initial as IntegerWidgetValue, direction, fast))
            input?.focus()
          },
        } : {})}
        {...(fill() === undefined ? {} : { fill: fill()! })}
        {...(inRow.controllerMode !== undefined ? { mark: <CanvasSeedModeIcon mode={mode()!} /> }
          : emptied() ? { mark: <span>{message('automaticField.auto')}</span> } : {})}
        zoomed={placement().scale > 1}
        place={placement().place}
        sideTop={placement().sideTop}
        {...(placement().sideMaxHeight === undefined ? {} : { sideMaxHeight: placement().sideMaxHeight! })}
        onSideSize={setSideSize}
        {...(side() === undefined ? {} : { side: side()! })}
      />
      {completions === undefined ? null : <completions.Suggestions />}
    </div>
  )
}
