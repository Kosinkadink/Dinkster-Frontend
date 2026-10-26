import { createMemo, createSignal, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton, ProductTextArea } from '../ProductControls.js'
import { ProductActionFooter, ProductField, productFieldIds } from '../ProductForm.js'
import { Markdown } from '../help/Markdown.js'
import { parseMarkdown } from '../help/markdownParser.js'
import { useAppMessage } from '../locale.js'
import {
  WidgetEditorController,
  type WidgetEditorImplementationProps,
  type WidgetEditorProps,
} from '../WidgetEditorController.js'

const MarkdownImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const message = useAppMessage()
  const initial = typeof ed.initial === 'string' ? ed.initial
    : typeof ed.spec?.default === 'string' ? ed.spec.default : ''
  const readonly = ed.spec?.options['read_only'] === true
  const [draft, setDraft] = createSignal(initial)
  const [editing, setEditing] = createSignal(false)
  const blocks = createMemo(() => parseMarkdown(draft()))
  const ids = productFieldIds('markdown-editor-source')
  const edit = (): void => { if (!readonly) setEditing(true) }
  const commit = (): void => {
    if (readonly || draft() === initial) props.close()
    else props.commitValue(draft())
  }
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => props.editor.bindClickAway?.(undefined))

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover markdown-editor" data-testid="markdown-editor" data-editor-surface="popover" role="dialog" aria-label={`Edit ${ed.label} MARKDOWN`}>
    <props.header type="MARKDOWN" />
    <Show when={editing()} fallback={
      <div class="markdown-editor-preview" role="region" aria-label={message('markdownWidget.preview')} tabIndex={0} onDblClick={edit} ref={(el) => queueMicrotask(() => el.focus())}>
        <Markdown blocks={blocks()} />
      </div>
    }>
      <ProductField controlId="markdown-editor-source" label={message('markdownWidget.source')}>
        <ProductTextArea id="markdown-editor-source" aria-labelledby={ids.label} value={draft()} rows={8}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
              event.preventDefault()
              commit()
            }
          }} />
      </ProductField>
    </Show>
    <ProductActionFooter>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <Show when={!readonly}>
        <ProductButton type="button" onClick={() => editing() ? setEditing(false) : edit()}>{message(editing() ? 'markdownWidget.preview' : 'markdownWidget.edit')}</ProductButton>
        <Show when={editing()}>
          <ProductButton type="button" variant="primary" onClick={commit}>{message('markdownWidget.commit')}</ProductButton>
        </Show>
      </Show>
    </ProductActionFooter>
  </div>
}

export const MarkdownWidgetEditor: Component<WidgetEditorProps> = (props) => (
  <WidgetEditorController {...props} implementation={MarkdownImplementation} />
)
