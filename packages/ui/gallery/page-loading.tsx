import { Show } from 'solid-js'
import {
  createPageLoad,
  ProductButton,
  ProductLoading,
  ProductNotice,
  ProductSection,
} from '../src/index.js'

export function PageLoadingGallery() {
  const page = createPageLoad<[string, string]>()
  const read = (delay: number, fail = false, email = 'alex@example.test') =>
    page.load(() =>
      Promise.all([
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('Alex Morgan'), 20),
        ),
        new Promise<string>((resolve, reject) =>
          setTimeout(
            () =>
              fail
                ? reject(new Error('The account could not be read. Try again.'))
                : resolve(email),
            delay,
          ),
        ),
      ]),
    )
  return (
    <ProductSection title="Page loading">
      <p class="dinkster-description">
        The account and its settings arrive together. A quick read has no
        loading sign. Re-reading keeps the last answer visible.
      </p>
      <div class="dinkster-actions">
        <ProductButton onClick={() => void read(80)}>
          Load quickly
        </ProductButton>
        <ProductButton onClick={() => void read(250)}>
          Load briefly
        </ProductButton>
        <ProductButton onClick={() => void read(1000)}>
          Load slowly
        </ProductButton>
        <ProductButton onClick={() => void read(250, true)}>
          Fail to load
        </ProductButton>
        <ProductButton
          onClick={() => void read(1000, false, 'alex@updated.example.test')}
        >
          Refresh account
        </ProductButton>
      </div>
      <div class="dinkster-stack" aria-busy={page.pending()}>
        <Show when={page.loading()}>
          <ProductLoading label="Loading account" />
        </Show>
        <Show when={page.error()}>
          {(error) => (
            <ProductNotice tone="error">{error().message}</ProductNotice>
          )}
        </Show>
        <Show when={page.value()}>
          {(account) => (
            <div class="dinkster-stack">
              <strong>{account()[0]}</strong>
              <span>{account()[1]}</span>
            </div>
          )}
        </Show>
      </div>
    </ProductSection>
  )
}
