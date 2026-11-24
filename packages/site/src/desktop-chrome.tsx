import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { ProductWindowChrome, ProductWindowIdentity } from '@dinkster/ui'

export interface DesktopChromeOptions {
  readonly title: string
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly theme: 'dark' | 'light'
  readonly qa?: boolean
  readonly development?: boolean
  /** macOS hides the traffic lights in full screen, so the bar drops their inset. */
  readonly fullScreen?: boolean
}

let dispose: (() => void) | undefined

/** DOM-only chrome adaptation; the host retains navigation and native controls. */
export function install(options: DesktopChromeOptions): void {
  dispose?.()
  let bar: HTMLElement | undefined
  let mounted: HTMLDivElement | undefined
  let clear: (() => void) | undefined
  const [service, setService] = createSignal<'qa' | 'custom'>()
  function reconcile(): void {
    const existing = document.querySelector<HTMLElement>(
      '.dinkster-window-toolbar-host, .topbar, .dinkster-topbar, body > header',
    )
    const kind = existing?.dataset.serviceKind
    setService(kind === 'qa' || kind === 'custom' ? kind : undefined)
    if (
      bar?.isConnected &&
      mounted?.isConnected &&
      (existing === bar || !existing)
    )
      return
    clear?.()
    const mount = document.createElement('div')
    mounted = mount
    let unmount: () => void
    if (existing) {
      bar = existing
      mount.className = 'dinkster-window-identity-host'
      ;(bar.querySelector('.dinkster-window-toolbar') ?? bar).append(mount)
      unmount = render(
        () => (
          <ProductWindowIdentity
            qa={options.qa ?? false}
            development={options.development ?? false}
            service={service()}
          />
        ),
        mount,
      )
    } else {
      document.body.prepend(mount)
      unmount = render(() => <ProductWindowChrome {...options} />, mount)
      bar = mount.querySelector('header')!
      mount.className = 'dinkster-window-fallback'
    }
    const current = bar
    const previous = {
      desktopChrome: current.getAttribute('data-desktop-chrome'),
      platform: current.getAttribute('data-platform'),
      theme: current.getAttribute('data-theme'),
      fullScreen: current.getAttribute('data-full-screen'),
    }
    current.dataset.desktopChrome = ''
    current.dataset.platform = options.platform
    current.dataset.theme = options.theme
    if (options.fullScreen) current.dataset.fullScreen = ''
    else delete current.dataset.fullScreen
    clear = () => {
      unmount()
      mount.remove()
      for (const [name, value] of Object.entries(previous)) {
        if (value === null) delete current.dataset[name]
        else current.dataset[name] = value
      }
    }
  }
  reconcile()
  const observer = new MutationObserver(reconcile)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-service-kind'],
  })
  dispose = () => {
    observer.disconnect()
    clear?.()
  }
}
