import { createSignal, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import { ProductAbout, reportProductEvent } from '@dinkster/ui'
import '@dinkster/ui/styles.css'

const parameters = new URLSearchParams(location.search)
const title = parameters.get('title') ?? 'Dinkster Desktop'
const version = parameters.get('version') ?? ''
document.title = title
reportProductEvent({ type: 'page-viewed', route: 'desktop-about' })
render(() => {
  const preference = matchMedia('(prefers-color-scheme: dark)')
  const [theme, setTheme] = createSignal<'dark' | 'light'>(
    preference.matches ? 'dark' : 'light',
  )
  const update = () => setTheme(preference.matches ? 'dark' : 'light')
  preference.addEventListener('change', update)
  onCleanup(() => preference.removeEventListener('change', update))
  return (
    <main class="dinkster-root dinkster-about-window" data-theme={theme()}>
      <ProductAbout title={title} version={version} theme={theme()} />
    </main>
  )
}, document.getElementById('about-root')!)
