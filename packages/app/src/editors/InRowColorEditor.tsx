import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, untrack, type Component } from 'solid-js'
import { documentResolver, effectiveWidgetDefault, jsonSameValue, type Json } from '@dinkster/core'
import {
  colorCode,
  colorFieldDraft,
  colorKind,
  colorFieldHasOpacity,
  hsvToHex,
  integerColorHex,
  intKind,
  parseColorText,
  pickedColor,
  pickedRgba,
  resolveColorText,
  workflowSwatches,
} from '@dinkster/widgets'
import {
  CanvasColorKeys,
  CanvasColorPicker,
  CanvasColorSide,
  CanvasColorSquare,
  CanvasRowField,
  canvasColorLayout,
  type CanvasColorControl,
  type CanvasColorPoint,
} from '@dinkster/ui'
import { placeRow, rowPlacement, visibleCanvas } from './row-placement.js'
import type { WidgetEditorImplementationProps } from '../WidgetEditorController.js'
import { widgetCommitError } from '../widget-commit.js'

/** Where Alt+Down and Alt+Up move the keyboard, in order. */
type Stop = CanvasColorControl | 'default' | 'text'

/**
 * A color row edited in its own row on the canvas, as a draft: the code is
 * the text field with a live square before it, the picker hangs under the
 * field and the side part says what leaving the field stores. The picker,
 * swatches and default link change the draft only; Enter, Tab, Ctrl+Enter
 * or a press elsewhere store it, through the same controller paths as
 * every other field, and Escape leaves the stored color as it was.
 */
export const InRowColorImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const host = props.editor
  const ed = host.ed
  const spec = ed.spec!
  const inRow = ed.inRow!
  // An integer color stores its color as a whole number and has no opacity.
  const integer = spec.widgetType === intKind.type
  const withOpacity = !integer && colorFieldHasOpacity(spec.options)
  const codeOf = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined
    const result = resolveColorText(text, withOpacity)
    return result.kind === 'color' ? result.code : undefined
  }
  const textOf = (value: Json | undefined): string | undefined =>
    integer ? integerColorHex(value) : typeof value === 'string' ? value : undefined
  const storedText = textOf(ed.initial) ?? ''
  const storedCode = codeOf(storedText)
  const declared = effectiveWidgetDefault(spec)
  const defaultCode = codeOf(textOf(declared as Json | undefined))
  const black = colorCode({ r: 0, g: 0, b: 0, a: 255 })

  const [text, setText] = createSignal(storedText)
  const [lastValid, setLastValid] = createSignal(storedCode ?? defaultCode ?? black)
  // The hue the edit is at, kept while the color is a grey, white or black.
  const [hue, setHue] = createSignal(pickedColor(parseColorText(lastValid())!, 0).h)
  createEffect(() => {
    const result = resolveColorText(text(), withOpacity)
    if (result.kind !== 'color') return
    setLastValid(result.code)
    setHue(pickedColor(result.color, untrack(hue)).h)
  })
  const draft = createMemo(() => colorFieldDraft(text(), storedCode ?? storedText, lastValid(), withOpacity))
  const point = createMemo((): CanvasColorPoint => pickedColor(parseColorText(draft().live)!, hue()))

  // The default first, then the colors stored in this workflow by use. They
  // are read once, so the draft never reorders them.
  const swatches = (() => {
    const doc = ed.tab.store.doc
    const registry = host.app.registryForTab(ed.tab)
    const used: string[] = []
    if (registry !== undefined) {
      const resolve = documentResolver(doc, registry.resolve)
      for (const graph of Object.values(doc.graphs)) {
        for (const node of Object.values(graph.nodes)) {
          for (const item of resolve(node.type)?.items ?? []) {
            if (item.kind !== 'input' || item.widget === undefined) continue
            const value = node.values[item.id]
            const color = item.widget.widgetType === colorKind.type ? (typeof value === 'string' ? value : undefined)
              : item.widget.widgetType === intKind.type && item.widget.options['display'] === 'color' ? integerColorHex(value)
                : undefined
            if (color !== undefined) used.push(color)
          }
        }
      }
    }
    return workflowSwatches(defaultCode, used, withOpacity)
  })()
  const [candidate, setCandidate] = createSignal<number>()

  const bounds = visibleCanvas(host.boundary)
  let live = true
  let input: HTMLInputElement | undefined
  let frame!: HTMLDivElement
  let controls: Partial<Record<CanvasColorControl, HTMLElement>> = {}
  onCleanup(() => { live = false })

  const pick = (next: CanvasColorPoint): void => {
    setHue(next.h)
    setText(colorCode(pickedRgba({ ...next, a: withOpacity ? next.a : 255 })))
    setInvalid(undefined)
  }
  const choose = (code: string): void => {
    setText(code)
    setInvalid(undefined)
  }

  // What leaving the field does now: close (nothing to store, or the text is
  // not a color and the stored color stays), store, or stay open while a
  // store is in flight or the value fails the check every value passes.
  const [invalid, setInvalid] = createSignal<string>()
  type Plan = { readonly kind: 'close' } | { readonly kind: 'blocked' } | { readonly kind: 'store'; readonly value: Json }
  const plan = (): Plan => {
    if (!live || props.commitPending()) return { kind: 'blocked' }
    if (text() === storedText) return { kind: 'close' }
    const result = resolveColorText(text(), withOpacity)
    // Text that is not a color, or another spelling of the stored color,
    // leaves the stored value as it is.
    if (result.kind === 'invalid' || result.code === storedCode) return { kind: 'close' }
    const value: Json = integer ? Number.parseInt(result.code.slice(1, 7), 16) : result.code
    if (jsonSameValue(value, ed.initial ?? null)) return { kind: 'close' }
    const problem = widgetCommitError(host.app.widgetRegistryForTab(ed.tab).kind(spec.widgetType), value, spec)
    if (problem !== undefined) { setInvalid(problem); return { kind: 'blocked' } }
    return { kind: 'store', value }
  }
  /** Resolves true once the field is closed, false while it stays open. */
  const commit = (): Promise<boolean> => {
    const next = plan()
    if (next.kind === 'blocked') return Promise.resolve(false)
    if (next.kind === 'close') { props.close(); return Promise.resolve(true) }
    return props.commitValue(next.value).then((closed) => closed || !live)
  }
  host.bindClickAway?.(() => {
    if (plan().kind === 'blocked') return false
    void commit()
    return true
  })
  onCleanup(() => host.bindClickAway?.(undefined))

  // Alt+Down and Alt+Up take the keyboard through the picker, the swatches
  // and the default link and back to the text; Tab always moves between
  // the node's rows.
  const defaultLink = (): HTMLElement | null => frame.querySelector<HTMLElement>('.dinkster-canvas-side-link')
  const stops = (): Stop[] => [
    'square', 'hue',
    ...(withOpacity ? ['opacity' as const] : []),
    ...(swatches.length > 0 ? ['swatches' as const] : []),
    ...(defaultCode === undefined ? [] : ['default' as const]),
    'text',
  ]
  const [focused, setFocused] = createSignal<Stop>('text')
  const stopOf = (element: EventTarget | null): Stop | undefined => {
    if (element === input) return 'text'
    if (element !== null && element === defaultLink()) return 'default'
    return (Object.keys(controls) as CanvasColorControl[]).find((name) => controls[name] === element)
  }
  const focusStop = (stop: Stop): void => {
    if (stop === 'swatches' && candidate() === undefined) setCandidate(Math.max(0, swatches.indexOf(draft().live)))
    const element = stop === 'text' ? input : stop === 'default' ? defaultLink() : controls[stop]
    element?.focus()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    const at = stopOf(event.target) ?? 'text'
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const order = stops()
      const index = order.indexOf(at)
      focusStop(order[(index + (event.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length]!)
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      const queue = host.app.commands.get('workflow.queue')
      void commit().then((closed) => { if (closed && queue?.enabled?.() !== false) queue?.run() })
    } else if (event.key === 'Enter' && at !== 'text') {
      // Enter on the picker puts the keyboard back in the text; on a swatch
      // or the default it first makes that color the draft.
      event.preventDefault()
      if (props.commitPending()) return
      if (at === 'swatches' && candidate() !== undefined) choose(swatches[candidate()!]!)
      if (at === 'default' && defaultCode !== undefined) choose(defaultCode)
      input?.focus()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = ed.target
      void commit().then((closed) => {
        if (closed && target.kind === 'input') host.focusRow?.({ nodeId: target.nodeId, valueKey: target.valueKey })
      })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      props.close()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const direction = event.shiftKey ? -1 : 1
      const target = ed.target
      if (target.kind !== 'input') return
      void commit().then((closed) => { if (closed) host.moveRow?.({ nodeId: target.nodeId, valueKey: target.valueKey }, direction) })
    }
  }

  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  const [panelHeight, setPanelHeight] = createSignal(0)
  const placement = createMemo(() => {
    const row = rowPlacement(
      { rect: ed.rect, look: inRow.look, nodeTop: inRow.nodeTop, nodeBottom: inRow.nodeBottom },
      host.viewport(),
      bounds(),
      sideSize(),
    )
    return { ...row, ...canvasColorLayout(row.screen, bounds(), panelHeight(), sideSize(), row.scale) }
  })
  createEffect(() => placeRow(frame, placement()))

  const problemId = createUniqueId()
  const problem = (): string | undefined => props.commitError() ?? invalid() ?? (draft().invalid ? 'Not a color.' : undefined)
  const side = createMemo(() => {
    const result = draft()
    const shown = problem()
    return (
      <CanvasColorSide
        {...(shown === undefined ? {} : { problem: shown, problemId })}
        pending={props.commitPending()}
        droppedOpacity={result.droppedOpacity}
        enter={{ verb: result.invalid || result.enter === storedCode ? 'keeps' : 'stores', color: result.enter }}
        {...(result.invalid ? { preview: result.live } : {})}
        {...(defaultCode === undefined ? {} : { defaultColor: defaultCode, onDefault: () => { choose(defaultCode); input?.focus() } })}
        {...(inRow.help === undefined ? {} : { help: inRow.help })}
      >
        {focused() === 'text' || focused() === 'default' ? undefined : <CanvasColorKeys control={focused() as CanvasColorControl} point={point()} />}
      </CanvasColorSide>
    )
  })

  const picker = (
    <div ref={(element) => {
      const observer = new ResizeObserver(() => setPanelHeight(element.offsetHeight))
      observer.observe(element)
      onCleanup(() => observer.disconnect())
    }}>
      <CanvasColorPicker
        point={point()}
        opacity={withOpacity}
        hex={hsvToHex}
        swatches={swatches}
        noDefault={defaultCode === undefined}
        {...(swatches.includes(draft().live) ? { chosen: draft().live } : {})}
        {...(candidate() === undefined ? {} : { candidate: candidate()! })}
        {...(focused() === 'text' || focused() === 'default' ? {} : { focused: focused() as CanvasColorControl })}
        onPick={pick}
        onSwatch={choose}
        onCandidate={setCandidate}
        controls={(found) => { controls = found }}
        disabled={props.commitPending()}
      />
    </div>
  )

  // The field cannot be typed into while a store is in flight.
  createEffect(() => { if (input !== undefined) input.readOnly = props.commitPending() })
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

  return (
    <div
      ref={frame}
      class="widget-in-row-field"
      data-testid="widget-editor"
      data-editor-target={ed.target.kind}
      data-editor-mode={spec.widgetType}
      data-editor-surface="in-row"
      onKeyDown={onKeyDown}
      onFocusIn={(event) => setFocused(stopOf(event.target) ?? 'text')}
    >
      <CanvasRowField
        look={inRow.look}
        rowWidth={placement().rowWidth}
        label={ed.label}
        {...(storedCode === undefined ? {} : { labelMark: <CanvasColorSquare color={storedCode} /> })}
        mark={<CanvasColorSquare color={draft().live} />}
        value={text()}
        onInput={(value) => {
          setText(value)
          setInvalid(undefined)
        }}
        inputRef={(element) => {
          input = element
          element.setAttribute('aria-description', integer ? 'COLOR (whole number)' : 'COLOR')
          queueMicrotask(() => { element.focus(); element.select() })
        }}
        inputLabel={ed.label}
        zoomed={placement().scale > 1}
        place={placement().place}
        sideTop={placement().sideTop}
        {...(placement().sideMaxHeight === undefined ? {} : { sideMaxHeight: placement().sideMaxHeight! })}
        onSideSize={setSideSize}
        side={side()}
        panel={picker}
        panelPlace={placement().panelPlace}
        {...(placement().panelMaxHeight === undefined ? {} : { panelMaxHeight: placement().panelMaxHeight! })}
      />
    </div>
  )
}
