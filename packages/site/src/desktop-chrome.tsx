import { render } from 'solid-js/web'
import { ProductWindowChrome, ProductWindowIdentity } from '@dinkster/ui'

export interface DesktopChromeOptions {
  readonly title: string
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly theme: 'dark' | 'light'
  readonly qa?: boolean
  readonly development?: boolean
}

let dispose: (() => void) | undefined

/** DOM-only chrome adaptation; the host retains navigation and native controls. */
export function install(options: DesktopChromeOptions): void {
  dispose?.()
  const existing = document.querySelector<HTMLElement>(
    '.topbar, .dinkster-topbar, body > header',
  )
  const mount = document.createElement('div')
  let bar: HTMLElement
  if (existing) {
    bar = existing
    mount.className = 'dinkster-window-identity-host'
    bar.append(mount)
    const unmount = render(
      () => (
        <ProductWindowIdentity
          qa={options.qa ?? false}
          development={options.development ?? false}
        />
      ),
      mount,
    )
    dispose = () => {
      unmount()
      mount.remove()
    }
  } else {
    document.body.prepend(mount)
    const unmount = render(() => <ProductWindowChrome {...options} />, mount)
    bar = mount.querySelector('header')!
    mount.className = 'dinkster-window-fallback'
    dispose = () => {
      unmount()
      mount.remove()
    }
  }
  bar.dataset.desktopChrome = ''
  bar.dataset.platform = options.platform
  bar.dataset.theme = options.theme
}
