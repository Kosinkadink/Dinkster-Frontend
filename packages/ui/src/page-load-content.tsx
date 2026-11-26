import {
  Show,
  children,
  createMemo,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { ProductButton } from './controls.js'
import { ProductLoading } from './layout.js'
import { ProductNotice } from './messages.js'
import { createPageLoad } from './page-load.js'
import { useProductStrings } from './strings.js'

/** An additional region shares its main region's read, without duplicate feedback. */
export function ProductPageAnswer<T>(props: {
  page: ReturnType<typeof createPageLoad<T>>
  arrival?: 'fade' | 'rise'
  children: JSX.Element | ((value: T) => JSX.Element)
}) {
  const content = props.children
  const answer = createMemo(() => {
    const value = props.page.value()
    return value === undefined ? undefined : { value }
  })
  // Solid JSX can be a zero-argument accessor rather than a value renderer.
  if (typeof content !== 'function' || content.length === 0) {
    return (
      <Show when={answer() !== undefined}>
        <div
          class="dinkster-page-load-answer"
          data-arrival={props.arrival ?? 'rise'}
        >
          {content as JSX.Element}
        </div>
      </Show>
    )
  }
  return (
    <Show when={answer()} keyed>
      {(result) => (
        <div
          class="dinkster-page-load-answer"
          data-arrival={props.arrival ?? 'rise'}
        >
          {content(result.value)}
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
  /** Known headings and facts stay mounted outside the arriving answer. */
  known?: JSX.Element
  children: JSX.Element | ((value: T) => JSX.Element)
}) {
  const strings = useProductStrings()
  const knownContent = children(() => props.known)
  let host!: HTMLDivElement
  let known: HTMLDivElement | undefined
  let loading: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  const placeLoading = () => {
    if (!host || !known || !loading) return
    const bottom = known.offsetTop + known.offsetHeight
    const top =
      bottom + loading.offsetHeight / 2 > host.clientHeight / 2 ? bottom : 0
    loading.parentElement!.style.top = `${top}px`
  }
  onMount(() => {
    if (!known) return
    observer = new ResizeObserver(placeLoading)
    observer.observe(host)
    if (known) observer.observe(known)
    if (loading) observer.observe(loading)
  })
  onCleanup(() => observer?.disconnect())
  return (
    <div
      ref={host}
      class="dinkster-page-load"
      data-known={knownContent() ? '' : undefined}
      aria-busy={props.page.pending()}
    >
      <Show when={knownContent()}>
        <div ref={known} class="dinkster-page-load-known">
          {knownContent()}
        </div>
      </Show>
      <Show when={props.page.loading()}>
        <div class="dinkster-page-load-loading">
          <div
            ref={(element) => {
              if (loading) observer?.unobserve(loading)
              loading = element
              observer?.observe(element)
              onCleanup(() => {
                observer?.unobserve(element)
                loading = undefined
              })
            }}
          >
            <ProductLoading label={props.loadingLabel} />
          </div>
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
          {props.children}
        </ProductPageAnswer>
      </div>
    </div>
  )
}
