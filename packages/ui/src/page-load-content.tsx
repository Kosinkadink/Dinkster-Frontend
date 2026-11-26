import { Show, createMemo, type JSX } from 'solid-js'
import { ProductButton } from './controls.js'
import { ProductLoading } from './layout.js'
import { ProductNotice } from './messages.js'
import { createPageLoad } from './page-load.js'
import { useProductStrings } from './strings.js'

/** An additional region shares its main region's read, without duplicate feedback. */
export function ProductPageAnswer<T>(props: {
  page: ReturnType<typeof createPageLoad<T>>
  arrival?: 'fade' | 'rise'
  children: (value: T) => JSX.Element
}) {
  const answer = createMemo(() => {
    const value = props.page.value()
    return value === undefined ? undefined : { value }
  })
  return (
    <Show when={answer()} keyed>
      {(result) => (
        <div
          class="dinkster-page-load-answer"
          data-arrival={props.arrival ?? 'rise'}
        >
          {props.children(result.value)}
        </div>
      )}
    </Show>
  )
}

export function ProductPageLoad<T>(props: {
  page: ReturnType<typeof createPageLoad<T>>
  read: () => Promise<T>
  loadingLabel: string
  arrival?: 'fade' | 'rise'
  children: (value: T) => JSX.Element
}) {
  const strings = useProductStrings()
  return (
    <div class="dinkster-page-load" aria-busy={props.page.pending()}>
      <Show when={props.page.loading()}>
        <div class="dinkster-page-load-loading">
          <ProductLoading label={props.loadingLabel} />
        </div>
      </Show>
      <div class="dinkster-page-load-content">
        <Show when={props.page.error()}>
          {(error) => (
            <div class="dinkster-stack">
              <ProductNotice tone="error">{error().message}</ProductNotice>
              <ProductButton
                disabled={props.page.pending()}
                onClick={() => void props.page.load(props.read)}
              >
                {strings.tryAgain}
              </ProductButton>
            </div>
          )}
        </Show>
        <ProductPageAnswer page={props.page} arrival={props.arrival ?? 'rise'}>
          {(value) => props.children(value)}
        </ProductPageAnswer>
      </div>
    </div>
  )
}
