import { createSignal, For, Show } from 'solid-js'
import { ProductErrorBanner, ProductNotice } from '@dinkster/ui'
import type { AppState, ProjectNeedsReview } from './app-state.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductButton } from './ProductControls.js'
import { ProductActionFooter } from './ProductForm.js'
import { ProductListRow } from './ProductSurfaces.js'
import { useAppMessage } from './locale.js'

export function ProjectNeedsPrompt(props: { readonly app: AppState; readonly review: ProjectNeedsReview }) {
  const message = useAppMessage()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const close = (): void => { if (props.app.projectNeedsReview.get() === props.review) props.app.projectNeedsReview.set(undefined) }
  const enable = async (): Promise<void> => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try { await props.app.enableReviewedProjectPacks(props.review) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const reviewAgain = async (): Promise<void> => {
    if (busy()) return
    setBusy(true)
    try { await props.app.checkProjectNeeds(props.review.backend) }
    finally { setBusy(false) }
  }
  return <ModalSurface title={message('projectNeeds.title')} modalId="project-needs" dismissBlocked={busy()} onRequestClose={close}>
    <div class="projects-dialog" data-testid="project-needs">
      <Show when={error()}>{(detail) => <ProductErrorBanner onDismiss={() => setError(undefined)}>{detail()}</ProductErrorBanner>}</Show>
      <p>{props.review.project.name}</p>
      <Show when={props.review.enable.length > 0}>
        <p>{message('projectNeeds.enableDescription')}</p>
        <ul class="projects-dialog-list">
          <For each={props.review.enable}>{(pack) => <li><ProductListRow primary={pack}>
            <span>{props.review.needs.installed.find((entry) => entry.pack === pack)?.version ?? message('projectNeeds.unpinned')}</span>
          </ProductListRow></li>}</For>
        </ul>
      </Show>
      <Show when={props.review.changes.length > 0}>
        <ProductNotice>{message('projectNeeds.environmentChange')}</ProductNotice>
        <ul class="projects-dialog-list">
          <For each={props.review.changes}>{(pack) => <li><ProductListRow primary={pack.pack}>
            <span>{pack.version ?? message('projectNeeds.unpinned')}</span>
          </ProductListRow></li>}</For>
        </ul>
      </Show>
      <Show when={props.review.errors.length > 0}>
        <ProductNotice>{message('projectNeeds.unknown')}</ProductNotice>
        <ul class="projects-dialog-list"><For each={props.review.errors}>{(item) => <li>{item}</li>}</For></ul>
      </Show>
      <ProductActionFooter>
        <Show when={props.review.enable.length > 0}><ProductButton variant="primary" loading={busy()} disabled={busy()} onClick={() => { void enable() }}>{message('projectNeeds.enable')}</ProductButton></Show>
        <ProductButton disabled={busy()} onClick={() => { void reviewAgain() }}>{message('projectNeeds.reviewAgain')}</ProductButton>
        <ProductButton disabled={busy()} onClick={close}>{message('common.close')}</ProductButton>
      </ProductActionFooter>
    </div>
  </ModalSurface>
}
