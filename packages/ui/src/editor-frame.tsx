import { Show, createUniqueId, type JSX } from 'solid-js'
import { X } from 'lucide-solid'
import { ProductButton, ProductIconButton } from './controls.js'
import { ProductLoading } from './layout.js'
import { ProductErrorBanner } from './messages.js'
import { useProductStrings } from './strings.js'

/**
 * Where a full editor's draft stands. Apply is available only for `changed`:
 * a draft that differs from the stored value, is valid, and has loaded.
 */
export type ProductEditorFramePhase =
  | 'loading'
  | 'unavailable'
  | 'unchanged'
  | 'changed'
  | 'invalid'

/**
 * The one frame around every full editor: a title with the close button, an
 * error banner when applying failed, the editor's own body, and a footer
 * with Cancel and Apply. The body stays mounted while it loads or is
 * unavailable, so the editor keeps its state; it is only hidden.
 */
export function ProductEditorFrame(props: {
  title: string
  titleId?: string
  phase: ProductEditorFramePhase
  /** Footer words in place of the phase's own, such as what to fix. */
  status?: string
  applying?: boolean
  error?: string
  onDismissError?: () => void
  /** What is shown while the editor loads; default "Loading preview". */
  loadingLabel?: string
  /** What could not load; default "Could not load the preview." */
  unavailableLabel?: string
  onRetry?: () => void
  /**
   * An editor that is a few controls keeps them at their own width in one
   * centered column at the top of the body; a picture or scene fills it.
   */
  form?: boolean
  /**
   * Stores the draft. An editor that can never store, such as a comparison
   * view, leaves it out: its footer has one Close button instead.
   */
  onApply?: () => void
  onCancel: () => void
  children: JSX.Element
}) {
  const strings = useProductStrings()
  const generatedId = createUniqueId()
  const titleId = () => props.titleId ?? generatedId
  const applying = () => props.applying === true
  const status = () => {
    if (applying()) return strings.editorApplying
    if (props.status !== undefined) return props.status
    switch (props.phase) {
      case 'loading':
        return strings.loading
      case 'unavailable':
        return strings.editorUnavailableStatus
      case 'unchanged':
        return strings.editorUnchanged
      case 'changed':
        return strings.editorChanged
      case 'invalid':
        return strings.editorInvalid
    }
  }
  const bodyHidden = () =>
    props.phase === 'loading' || props.phase === 'unavailable'
  return (
    <section
      class="dinkster-editor-frame"
      aria-labelledby={titleId()}
      aria-busy={applying() ? 'true' : undefined}
      data-phase={props.phase}
      data-applying={applying() ? 'true' : undefined}
    >
      <header class="dinkster-editor-frame-header">
        <h2 id={titleId()} class="dinkster-editor-frame-title" title={props.title}>
          {props.title}
        </h2>
        <ProductIconButton
          icon={X}
          label={strings.closeEditor}
          data-testid="editor-frame-close"
          disabled={applying()}
          onClick={() => props.onCancel()}
        />
      </header>
      <Show when={props.error}>
        {(error) => (
          <div class="dinkster-editor-frame-banner" data-testid="editor-frame-error">
            <ProductErrorBanner
              onDismiss={() => props.onDismissError?.()}
            >
              {error()}
            </ProductErrorBanner>
          </div>
        )}
      </Show>
      <Show when={props.phase === 'loading'}>
        <div class="dinkster-editor-frame-state">
          <ProductLoading label={props.loadingLabel ?? strings.editorLoading} />
        </div>
      </Show>
      <Show when={props.phase === 'unavailable'}>
        <div class="dinkster-editor-frame-state" role="alert">
          <p class="dinkster-description">
            {props.unavailableLabel ?? strings.editorUnavailable}
          </p>
          <Show when={props.onRetry}>
            {(retry) => (
              <ProductButton onClick={() => retry()()}>
                {strings.tryAgain}
              </ProductButton>
            )}
          </Show>
        </div>
      </Show>
      <div
        class="dinkster-editor-frame-body"
        data-size={props.form === true ? 'form' : undefined}
        hidden={bodyHidden()}
        inert={applying()}
      >
        {props.children}
      </div>
      <footer class="dinkster-editor-frame-footer">
        <span class="dinkster-editor-frame-status" role="status">
          {status()}
        </span>
        <Show
          when={props.onApply}
          fallback={
            <ProductButton data-testid="editor-frame-cancel" onClick={() => props.onCancel()}>
              {strings.close}
            </ProductButton>
          }
        >
          {(apply) => (
            <>
              <ProductButton data-testid="editor-frame-cancel" disabled={applying()} onClick={() => props.onCancel()}>
                {strings.cancel}
              </ProductButton>
              <ProductButton
                data-testid="editor-frame-apply"
                fill="solid"
                pending={applying()}
                disabled={props.phase !== 'changed'}
                onClick={() => apply()()}
              >
                {strings.apply}
              </ProductButton>
            </>
          )}
        </Show>
      </footer>
    </section>
  )
}
