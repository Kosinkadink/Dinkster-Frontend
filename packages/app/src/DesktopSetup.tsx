import { desktopEngineAcceleratorLabel, type DesktopLifecycleStatus } from './desktop-bridge.js'
import { useAppMessage } from './locale.js'

export interface DesktopSetupProps {
  readonly status: DesktopLifecycleStatus
  readonly onRetry: () => void
}

export function DesktopSetup(props: DesktopSetupProps) {
  const message = useAppMessage()
  const failed = () => props.status.phase === 'failed'
  return (
    <main class="desktop-setup" aria-live="polite" aria-busy={!failed()}>
      <section class="desktop-setup-card" aria-labelledby="desktop-setup-title">
        <div class="desktop-setup-mark" aria-hidden="true">D</div>
        <p class="desktop-setup-eyebrow">{message('desktopSetup.eyebrow')}</p>
        <h1 id="desktop-setup-title">{failed() ? message('desktopSetup.titleFailed') : message('desktopSetup.titlePreparing')}</h1>
        <p class="desktop-setup-detail">{props.status.detail}</p>
        {props.status.variant && <p class="desktop-setup-variant">{message('desktopSetup.environment', { accelerator: desktopEngineAcceleratorLabel(props.status.variant) })}</p>}
        {props.status.error && <pre class="desktop-setup-error">{props.status.error}</pre>}
        {failed()
          ? <button class="desktop-setup-retry" type="button" onClick={props.onRetry}>{message('desktopSetup.retry')}</button>
          : <div class="desktop-setup-progress" role="progressbar" aria-label={message('desktopSetup.progress')}><span /></div>}
        <p class="desktop-setup-note">{message('desktopSetup.note')}</p>
      </section>
    </main>
  )
}
