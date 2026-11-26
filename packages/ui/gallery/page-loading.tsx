import { createSignal } from 'solid-js'
import {
  createPageLoad,
  ProductButton,
  ProductPageAnswer,
  ProductPageLoad,
  ProductSection,
  ProductSegmented,
} from '../src/index.js'

export function PageLoadingGallery(props: { activity: string }) {
  const page = createPageLoad<[string, string]>()
  const [arrival, setArrival] = createSignal<'fade' | 'rise'>('fade')
  let request: () => Promise<[string, string]>
  const read = (delay: number, fail = false, email = 'alex@example.test') => {
    let failNext = fail
    request = () => {
      const failed = failNext
      failNext = false
      return Promise.all([
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('Alex Morgan'), 20),
        ),
        new Promise<string>((resolve, reject) =>
          setTimeout(
            () =>
              failed
                ? reject(new Error('The account could not be read.'))
                : resolve(email),
            delay,
          ),
        ),
      ])
    }
    return page.load(request)
  }
  return (
    <>
      <ProductSection title="Page loading">
        <p class="dinkster-description">
          The account and its settings arrive together. A quick read has no
          loading sign. Re-reading keeps the last answer visible.
        </p>
        <ProductSegmented
          label="Answer arrival"
          value={arrival()}
          options={[
            { value: 'fade', label: 'Fade' },
            { value: 'rise', label: 'Fade and rise' },
          ]}
          onChange={(value) => setArrival(value as 'fade' | 'rise')}
        />
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
        <div class="dinkster-page-load-example">
          <ProductPageLoad
            page={page}
            read={() => request()}
            loadingLabel="Loading account"
            arrival={arrival()}
          >
            {(account) => (
              <div class="dinkster-stack">
                <strong>{account[0]}</strong>
                <span>{account[1]}</span>
              </div>
            )}
          </ProductPageLoad>
        </div>
      </ProductSection>
      <p class="dinkster-metadata" role="status">
        {props.activity}
      </p>
      <ProductSection title="Account summary">
        <ProductPageAnswer page={page}>
          {(account) => (
            <p class="dinkster-description">
              {account[0]} uses {account[1]}.
            </p>
          )}
        </ProductPageAnswer>
      </ProductSection>
    </>
  )
}
