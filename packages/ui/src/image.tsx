import { createEffect, createSignal, Show, type JSX } from 'solid-js'
import { Image } from 'lucide-solid'
import { ProductIcon } from './controls.js'

export function ProductImageUnavailable() {
  return (
    <span
      class="dinkster-image-unavailable"
      role="img"
      aria-label="Image unavailable"
    >
      <ProductIcon icon={Image} />
    </span>
  )
}

export function ProductImage(props: {
  readonly src: string
  readonly alt: string
  readonly onLoad?: JSX.EventHandler<HTMLImageElement, Event>
}) {
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    props.src
    setFailed(false)
  })
  return (
    <span class="dinkster-result-picture">
      <Show when={!failed()} fallback={<ProductImageUnavailable />}>
        <img
          src={props.src}
          alt={props.alt}
          draggable={false}
          loading="lazy"
          decoding="async"
          onLoad={props.onLoad}
          onError={() => setFailed(true)}
        />
      </Show>
    </span>
  )
}
