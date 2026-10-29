export function BrandMark(props: { readonly symbol?: boolean; readonly class?: string }) {
  return props.symbol ? (
    <img class={`brand-symbol ${props.class ?? ''}`} src="/branding/svg/dinkster-symbol-color.svg" alt="Dinkster" />
  ) : (
    <span class={`brand-wordmark ${props.class ?? ''}`}>
      <img class="brand-on-dark" src="/branding/svg/dinkster-wordmark-color-dark.svg" alt="Dinkster" />
      <img class="brand-on-light" src="/branding/svg/dinkster-wordmark-color-light.svg" alt="Dinkster" />
    </span>
  )
}
