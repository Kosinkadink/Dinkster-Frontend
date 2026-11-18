import darkWordmark from '../../../branding/svg/dinkster-wordmark-color-dark.svg?url'
import lightWordmark from '../../../branding/svg/dinkster-wordmark-color-light.svg?url'
import { useProductStrings } from './strings.js'

export function ProductAbout(props: {
  title: string
  version: string
  theme: 'dark' | 'light'
}) {
  const strings = useProductStrings()
  return (
    <section class="dinkster-about" aria-label={props.title}>
      <img
        class="dinkster-about-wordmark"
        src={props.theme === 'dark' ? darkWordmark : lightWordmark}
        alt="Dinkster"
      />
      <h1 class="dinkster-heading">{props.title}</h1>
      <p class="dinkster-description">
        {strings.version} {props.version}
      </p>
    </section>
  )
}
