import { For, Show, createSignal, type JSX } from 'solid-js'
import { ChevronRight } from 'lucide-solid'
import { ProductButton, ProductIcon } from './controls.js'
import { ProductErrorBanner } from './messages.js'
import { useProductStrings } from './strings.js'

export function ProductFacts(props: {
  label: string
  items: readonly { label: string; value: JSX.Element }[]
}) {
  return (
    <dl class="dinkster-facts" aria-label={props.label}>
      <For each={props.items}>
        {(item) => (
          <div class="dinkster-fact">
            <dt class="dinkster-description">{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        )}
      </For>
    </dl>
  )
}

export function ProductCodeBlock(props: {
  label: string
  value: string
  action?: JSX.Element
}) {
  return (
    <section class="dinkster-stack" aria-label={props.label}>
      <span class="dinkster-description">{props.label}</span>
      <pre class="dinkster-code">
        <code>{props.value}</code>
      </pre>
      {props.action}
    </section>
  )
}

/** The caller owns show-once lifetime and success feedback. Copying never
 * persists the value, and a refused clipboard write leaves it selectable. */
export function ProductCopyValue(props: {
  label: string
  value: string
  onCopied: () => void
}) {
  const strings = useProductStrings()
  const [pending, setPending] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  return (
    <div class="dinkster-stack">
      <Show when={failed()}>
        <ProductErrorBanner onDismiss={() => setFailed(false)}>
          {strings.copyFailed}
        </ProductErrorBanner>
      </Show>
      <ProductCodeBlock
        label={props.label}
        value={props.value}
        action={
          <ProductButton
            pending={pending()}
            onClick={async () => {
              if (pending()) return
              setPending(true)
              try {
                await navigator.clipboard.writeText(props.value)
                setFailed(false)
                props.onCopied()
              } catch {
                setFailed(true)
              } finally {
                setPending(false)
              }
            }}
          >
            {strings.copy}
          </ProductButton>
        }
      />
    </div>
  )
}

export function ProductDisclosure(props: {
  title: string
  open?: boolean
  children: JSX.Element
}) {
  return (
    <details class="dinkster-disclosure" open={props.open}>
      <summary>
        <ProductIcon icon={ChevronRight} />
        {props.title}
      </summary>
      <div class="dinkster-stack">{props.children}</div>
    </details>
  )
}

export function ProductStatusPill(props: {
  tone: 'good' | 'warning' | 'problem' | 'neutral'
  children: JSX.Element
}) {
  return (
    <span class="dinkster-status-pill" data-tone={props.tone}>
      <span>{props.children}</span>
    </span>
  )
}

export function ProductQrCode(props: { src: string; alt: string }) {
  return <img class="dinkster-qr" src={props.src} alt={props.alt} />
}
