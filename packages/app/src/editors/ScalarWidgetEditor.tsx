import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  Show,
  type Component,
} from 'solid-js'
import {
  isCanonicalUnsafeInteger,
  jsonSameValue,
  numericStepConstraints,
  type Json,
} from '@dinkster/core'
import { defaultTokens } from '@dinkster/canvas'
import { Check, X } from 'lucide-solid'
import { floatKind, floatSliderView, intKind } from '@dinkster/widgets'
import { ProductSlider } from '../ProductSlider.js'
import { ColorWidgetEditor } from './ColorWidgetEditor.js'
import { InRowFieldImplementation } from './InRowFieldEditor.js'
import { createTextCompletions, type TextControl } from './text-completions.js'
import {
  WidgetEditorController,
  type WidgetEditorImplementationProps,
  type WidgetEditorProps,
  type WidgetEditorState,
} from '../WidgetEditorController.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { Icon } from '../Icon.js'
import { canvasBaselineRow, devicePixelSnap, domFirstBaseline, editorScreenAnchor } from '../widget-editor-position.js'
import { parseNumericCommit, parsePrimitiveListCommit, resolveTextCommit, widgetCommitError } from '../widget-commit.js'

export function isInNodeTextEditor(ed: WidgetEditorState): boolean {
  return ed.outputDescriptors === undefined && ed.target.kind === 'input' &&
    ed.spec?.widgetType === 'STRING' && ed.multiline
}


const scalarStrategies = {
  INT: (raw: string) => parseNumericCommit(raw, 'INT'),
  FLOAT: (raw: string, round?: unknown, precision?: unknown) => parseNumericCommit(raw, 'FLOAT', round, precision),
} as const

const ScalarImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const host = props.editor
  const ed = host.ed
  const list = ed.spec?.widgetType === 'LIST'
  const text = ed.spec?.widgetType === 'STRING'
  const initialText = list ? JSON.stringify(ed.initial ?? []) : String(ed.initial ?? '')
  const [draft, setDraft] = createSignal(initialText)
  const slider = ed.spec !== undefined && ed.spec.widgetType === floatKind.type && floatSliderView.isCompatible(ed.spec)
    && (ed.viewId ?? floatKind.defaultView(ed.spec)) === 'core.slider'
  const fieldIds = productFieldIds('widget-editor-value')
  const [error, setError] = createSignal<string>()
  let live = true
  let popover: HTMLDivElement | undefined
  onCleanup(() => { live = false })

  /** Resolves true once the editor is closed, false while it stays open. */
  const commitTarget = (value: Json): Promise<boolean> => {
    if (!live || props.commitPending()) return Promise.resolve(false)
    if (text && typeof value === 'string' && ed.target.kind === 'input') {
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

  const parse = (raw: string): Json | undefined => {
    let value: Json
    if (ed.spec === undefined) {
      try { value = JSON.parse(raw) as Json } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Invalid JSON')
        return undefined
      }
    } else if (list) {
      const parsed = parsePrimitiveListCommit(raw, ed.spec)
      if (!parsed.ok) { setError(parsed.error); return undefined }
      value = parsed.value
    } else if (ed.spec.widgetType === 'INT') {
      const parsed = scalarStrategies.INT(raw)
      if (!parsed.ok) { setError(parsed.error); return undefined }
      value = parsed.value
    } else if (ed.spec.widgetType === floatKind.type) {
      const parsed = scalarStrategies.FLOAT(raw, ed.spec.options['round'], ed.spec.options['precision'])
      if (!parsed.ok) { setError(parsed.error); return undefined }
      const min = ed.spec.options['min']
      const max = ed.spec.options['max']
      value = Math.min(typeof max === 'number' && Number.isFinite(max) ? max : Infinity,
        Math.max(typeof min === 'number' && Number.isFinite(min) ? min : -Infinity, parsed.value))
    } else {
      value = raw
    }
    if (ed.spec !== undefined) {
      const validation = widgetCommitError(host.app.widgetRegistryForTab(ed.tab).kind(ed.spec.widgetType), value, ed.spec)
      if (validation !== undefined) { setError(validation); return undefined }
    }
    return value
  }

  const commit = (raw: string, closeOnInvalid = false, skipUnchanged = false): Promise<boolean> => {
    if (!live || props.commitPending()) return Promise.resolve(false)
    setError(undefined)
    const value = parse(raw)
    if (value === undefined) {
      if (closeOnInvalid) props.close()
      return Promise.resolve(closeOnInvalid)
    }
    if (skipUnchanged) {
      let initial = ed.initial
      if (ed.spec === undefined) {
        try { initial = JSON.parse(String(initial)) as Json } catch { initial = undefined }
      }
      if (jsonSameValue(value, initial)) { props.close(); return Promise.resolve(true) }
    }
    return commitTarget(value)
  }

  const completions = createTextCompletions(host, () => live)
  const { open, entries, interaction, requestCompletions, completionHandlers, completionKeyDown, Suggestions } = completions

  // In the multiline box Ctrl+Enter stores the text and then runs the
  // workflow, as it does everywhere. Where rows are edited in place, Tab
  // stores it and opens the next or previous row of the node; a tab
  // character cannot be typed. The suggestion list keeps the first Tab.
  const multilineKeyDown = (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void => {
    if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      const queue = host.app.commands.get('workflow.queue')
      void commit(event.currentTarget.value).then((closed) => { if ((closed || !live) && queue?.enabled?.() !== false) queue?.run() })
      return
    }
    if (completionKeyDown(event)) return
    const moveRow = host.moveRow
    if (event.isComposing || event.key !== 'Tab' || moveRow === undefined || ed.target.kind !== 'input') return
    event.preventDefault()
    const from = { nodeId: ed.target.nodeId, valueKey: ed.target.valueKey }
    const direction = event.shiftKey ? -1 : 1
    void commit(event.currentTarget.value).then((closed) => { if (closed || !live) moveRow(from, direction) })
  }

  const clickAway = (): void => {
    if (ed.spec !== undefined && ed.multiline && !list) {
      props.close()
      return
    }
    const field = popover?.querySelector<TextControl>('input, textarea')
    if (field == null || field.value === initialText) props.close()
    else commit(field.value, true, true)
  }
  host.bindClickAway?.(clickAway)
  onCleanup(() => host.bindClickAway?.(undefined))

  if (isInNodeTextEditor(ed)) {
    // The canvas draws at the viewport offset rounded to device pixels.
    const anchor = () => {
      const viewport = host.viewport()
      const ratio = window.devicePixelRatio || 1
      return editorScreenAnchor(ed.rect, { ...viewport, x: Math.round(viewport.x * ratio) / ratio, y: Math.round(viewport.y * ratio) / ratio })
    }
    const scale = () => host.viewport().scale
    const [snap, setSnap] = createSignal({ x: 0, y: 0 })
    const [lift, setLift] = createSignal({ label: 0, text: 0 })
    const box = defaultTokens.multilineText
    let root: HTMLDivElement | undefined
    let label!: HTMLSpanElement
    let field!: HTMLTextAreaElement
    // The label and the first line of text move onto the very rows the
    // canvas painted them on, so opening the box moves no pixel of either.
    const align = () => {
      if (root === undefined) return
      setSnap(devicePixelSnap(root))
      const origin = root.getBoundingClientRect().top - anchor().y
      const row = (px: number, center: number) => origin + canvasBaselineRow(px, defaultTokens.fontFamily, scale(), anchor().y + center * scale())
      const current = lift()
      setLift({
        label: current.label + domFirstBaseline(label) - row(defaultTokens.fontSize, box.labelHeight / 2),
        text: current.text + domFirstBaseline(field) - row(box.fontSize, box.labelHeight + box.padding + box.lineHeight / 2),
      })
    }
    createEffect(on(() => host.viewport(), align, { defer: true }))
    return <div ref={(el) => { root = el; queueMicrotask(align) }} class="widget-editor widget-editor-in-node" data-testid="widget-editor" data-editor-target="input" data-editor-mode="STRING" data-editor-surface="in-node" role="dialog" aria-label={`Edit ${ed.label} STRING`} style={{ left: `${anchor().x + snap().x}px`, top: `${anchor().y + snap().y}px`, width: `${anchor().width}px`, height: `${anchor().height}px`, 'border-radius': `${4 * scale()}px` }}>
      <div class="widget-editor-in-node-surface"><span ref={label} class="widget-editor-in-node-label" style={{ width: '100%', height: `${box.labelHeight * scale()}px`, 'font-family': defaultTokens.fontFamily, 'font-size': `${defaultTokens.fontSize * scale()}px`, 'padding-left': `${6 * scale()}px`, position: 'relative', top: `${-lift().label}px` }}>{ed.label}</span>
        <textarea aria-label={`Edit ${ed.label}`} aria-autocomplete="list" aria-controls={open() ? interaction.listboxId : undefined} aria-describedby={open() ? interaction.statusId : undefined} aria-expanded={open()} aria-activedescendant={interaction.activeOptionId(entries())} ref={(el) => { field = el; completions.anchor(el); queueMicrotask(() => el.focus()) }} value={String(ed.initial ?? '')} style={{ 'font-family': defaultTokens.fontFamily, 'font-size': `${box.fontSize * scale()}px`, 'line-height': `${box.lineHeight * scale()}px`, padding: `${box.padding * scale() - lift().text}px ${box.padding * scale()}px ${box.padding * scale() + lift().text}px ${box.textInset * scale()}px`, width: `calc(100% - ${box.scrollbarInset * scale()}px)`, 'align-self': 'flex-start', 'scrollbar-gutter': 'stable', '--multiline-scrollbar-width': `${box.scrollbarWidth * scale()}px` }} onInput={(event) => completionHandlers.input(event as InputEvent & { currentTarget: TextControl })} onClick={(event) => requestCompletions(event.currentTarget, '')} onKeyUp={(event) => { if (entries().length === 0 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) requestCompletions(event.currentTarget, '') }} onBlur={(event) => event.currentTarget.value === String(ed.initial ?? '') ? props.close() : commit(event.currentTarget.value)} onKeyDown={multilineKeyDown} />
        <Suggestions />
      </div>
      <Show when={props.commitError()}>{(error) => <ProductNotice tone="error" testId="widget-commit-error">{error()}</ProductNotice>}</Show>
    </div>
  }

  const numeric = ed.spec !== undefined && Object.hasOwn(scalarStrategies, ed.spec.widgetType)
  return <div ref={(el) => { popover = el; props.bindPopover(el) }} class="widget-editor floating-surface widget-editor-popover" data-testid="widget-editor" data-editor-target={ed.target.kind} data-editor-mode={ed.spec?.widgetType ?? 'raw'} data-editor-surface="popover" role="dialog" aria-label={`Edit ${ed.label} ${ed.spec?.widgetType ?? 'JSON'}`} style={props.popoverStyle}>
    <props.header type={ed.spec?.widgetType ?? 'JSON'} />
    <Show when={slider}>
      <ProductSlider ariaLabel={`${ed.label} slider`} value={Number.isFinite(Number(draft())) ? Number(draft()) : Number(ed.initial ?? 0)} min={Number(ed.spec!.options['min'])} max={Number(ed.spec!.options['max'])} step={Number(numericStepConstraints(ed.spec!).step)} onInput={(value) => { setError(undefined); const parsed = parse(String(value)); if (typeof parsed === 'number') setDraft(String(parsed)) }} />
    </Show>
    <ProductField controlId="widget-editor-value" label="Value" layout="compact" message={error()} messageTestId="widget-editor-error" invalid={error() !== undefined}>
      <Show when={ed.multiline || list} fallback={<input id="widget-editor-value" aria-labelledby={fieldIds.label} aria-autocomplete={text ? 'list' : undefined} aria-controls={open() ? interaction.listboxId : undefined} aria-describedby={error() !== undefined ? fieldIds.message : open() ? interaction.statusId : undefined} aria-invalid={error() === undefined ? undefined : 'true'} aria-expanded={text ? open() : undefined} aria-activedescendant={text ? interaction.activeOptionId(entries()) : undefined} ref={(el) => { if (text) completions.anchor(el); queueMicrotask(() => { el.focus(); if (numeric) el.select() }) }} value={draft()} placeholder={typeof ed.spec?.options['placeholder'] === 'string' ? ed.spec.options['placeholder'] : undefined} onInput={(event) => { setDraft(event.currentTarget.value); setError(undefined); if (text) completionHandlers.input(event as InputEvent & { currentTarget: TextControl }) }} onClick={(event) => { if (text) requestCompletions(event.currentTarget, '') }} onKeyUp={(event) => { if (text && entries().length === 0 && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) requestCompletions(event.currentTarget, '') }} onKeyDown={(event) => { if (text && completionKeyDown(event)) return; if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); commit(event.currentTarget.value) } }} />}>
        <textarea id="widget-editor-value" aria-labelledby={fieldIds.label} aria-describedby={error() === undefined ? undefined : fieldIds.message} aria-invalid={error() === undefined ? undefined : 'true'} ref={(el) => queueMicrotask(() => el.focus())} value={initialText} placeholder={typeof ed.spec?.options['placeholder'] === 'string' ? ed.spec.options['placeholder'] : undefined} onInput={() => setError(undefined)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); commit(event.currentTarget.value) } }} />
      </Show>
    </ProductField>
    <Suggestions />
    <div class="widget-editor-meta" data-testid="widget-editor-meta"><Show when={numeric}><dl class="widget-numeric-constraints" data-testid="widget-numeric-constraints" aria-label="Numeric constraints"><dt>Minimum</dt><dd>{Number.isFinite(ed.spec!.options['min']) || isCanonicalUnsafeInteger(ed.spec!.options['min']) ? String(ed.spec!.options['min']) : 'unbounded'}</dd><dt>Maximum</dt><dd>{Number.isFinite(ed.spec!.options['max']) || isCanonicalUnsafeInteger(ed.spec!.options['max']) ? String(ed.spec!.options['max']) : 'unbounded'}</dd><dt>Step</dt><dd>{(Number.isFinite(ed.spec!.options['step']) && Number(ed.spec!.options['step']) > 0) || isCanonicalUnsafeInteger(ed.spec!.options['step']) ? String(ed.spec!.options['step']) : `${numericStepConstraints(ed.spec!).step} (default)`}</dd></dl></Show><Show when={ed.multiline}>{ed.spec ? 'Ctrl+Enter to commit' : 'JSON'}</Show></div>
    <ProductActionFooter><button type="button" data-testid="widget-editor-cancel" onPointerDown={(event) => event.preventDefault()} onClick={props.close}><Icon icon={X} /> Cancel</button><button type="button" class="primary" data-testid="widget-editor-commit" onPointerDown={(event) => event.preventDefault()} onClick={(event) => { const field = event.currentTarget.closest('.widget-editor')?.querySelector<TextControl>('input, textarea'); if (field) commit(field.value) }}><Icon icon={Check} /> Commit</button></ProductActionFooter>
  </div>
}

export const ScalarWidgetEditor: Component<WidgetEditorProps> = (props) => {
  if (props.ed.spec?.widgetType === intKind.type && props.ed.viewId === 'core.integerColor') {
    return <ColorWidgetEditor {...props} />
  }
  return <WidgetEditorController {...props} implementation={props.ed.inRow === undefined ? ScalarImplementation : InRowFieldImplementation} />
}
