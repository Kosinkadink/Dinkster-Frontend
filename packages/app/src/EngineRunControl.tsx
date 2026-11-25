import { Match, Show, Switch, createEffect, createSignal, createUniqueId, onCleanup, onMount } from 'solid-js'
import { fetchSupervisorEngineLog, type SupervisorStatus } from '@dinkster/client'
import { ProductButton, ProductCodeBlock, ProductDialog, ProductIcon, ProductLoading, ProductSpinner } from '@dinkster/ui'
import CircleAlert from 'lucide-solid/icons/circle-alert'
import Power from 'lucide-solid/icons/power'
import RotateCw from 'lucide-solid/icons/rotate-cw'
import { useAppMessage } from './locale.js'

export function EngineRunControl(props: {
  readonly status: SupervisorStatus
  readonly baseUrl: string
  readonly onRestart: () => Promise<void>
}) {
  const message = useAppMessage()
  const [reasonOpen, setReasonOpen] = createSignal(false)
  const [restarting, setRestarting] = createSignal(false)
  const [logOpen, setLogOpen] = createSignal(false)
  const [log, setLog] = createSignal<Awaited<ReturnType<typeof fetchSupervisorEngineLog>>>()
  const reasonId = `engine-reason-${createUniqueId()}`
  let root!: HTMLDivElement
  let trigger: HTMLButtonElement | undefined
  let reason: HTMLElement | undefined
  let logRequest = 0
  onCleanup(() => { logRequest++ })

  createEffect(() => {
    props.baseUrl
    logRequest++
    setLogOpen(false)
    setLog(undefined)
    setReasonOpen(false)
  })
  createEffect(() => {
    if (props.status.state !== 'failed') setReasonOpen(false)
  })
  createEffect(() => {
    if (reasonOpen()) queueMicrotask(() => reason?.querySelector<HTMLButtonElement>('button')?.focus())
  })

  const closeReason = (restoreFocus = false): void => {
    setReasonOpen(false)
    if (restoreFocus) trigger?.focus()
  }
  onMount(() => {
    const outside = (event: PointerEvent): void => {
      if (reasonOpen() && event.target instanceof Node && !root.contains(event.target)) closeReason()
    }
    window.addEventListener('pointerdown', outside, true)
    onCleanup(() => window.removeEventListener('pointerdown', outside, true))
  })
  const restart = async (): Promise<void> => {
    if (restarting()) return
    closeReason()
    setRestarting(true)
    try {
      await props.onRestart()
    } finally {
      setRestarting(false)
    }
  }
  const showLog = async (): Promise<void> => {
    closeReason()
    setLog(undefined)
    setLogOpen(true)
    const request = ++logRequest
    const result = await fetchSupervisorEngineLog(props.baseUrl)
    if (request === logRequest) setLog(result)
  }
  const percent = (): number | undefined => {
    const progress = props.status.progress
    return progress && progress.total > 0
      ? Math.round(Math.min(1, Math.max(0, progress.done / progress.total)) * 100)
      : undefined
  }

  return (
    <div ref={root} class="engine-run-control" data-testid="engine-run-control" data-state={props.status.state}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && reasonOpen()) {
          event.preventDefault()
          closeReason(true)
        }
      }}
    >
      <Switch>
        <Match when={props.status.state === 'starting'}>
          <span class="engine-run-starting" role="status" aria-live="polite">
            <ProductSpinner label={message('shell.engine.startingControl')} />
            <span>{message('shell.engine.startingControl')}</span>
            <Show when={percent() !== undefined}><span class="engine-run-percent">{percent()}%</span></Show>
          </span>
        </Match>
        <Match when={props.status.state === 'stopped'}>
          <ProductButton data-testid="engine-start" pending={restarting()} onClick={() => void restart()}>
            <ProductIcon icon={Power} />{message('shell.engine.start')}
          </ProductButton>
        </Match>
        <Match when={props.status.state === 'failed'}>
          <ProductButton ref={trigger} intent="remove" data-testid="engine-failed"
            aria-expanded={reasonOpen()} aria-controls={reasonId} aria-haspopup="dialog"
            onClick={() => setReasonOpen((open) => !open)}>
            <ProductIcon icon={CircleAlert} />{message('shell.engine.failed')}
          </ProductButton>
          <ProductButton data-testid="engine-restart" pending={restarting()} onClick={() => void restart()}>
            <ProductIcon icon={RotateCw} />{message('shell.engine.restartShort')}
          </ProductButton>
        </Match>
      </Switch>
      <Show when={reasonOpen()}>
        <section ref={reason} id={reasonId} class="engine-run-reason" role="dialog" aria-label={message('shell.engine.failed')}>
          <strong>{message('shell.engine.failed')}</strong>
          <p>{props.status.detail || message('shell.engine.notAnswering')}</p>
          <div class="engine-run-reason-actions">
            <ProductButton pending={restarting()} onClick={() => void restart()}>{message('shell.engine.restart')}</ProductButton>
            <ProductButton onClick={() => void showLog()}>{message('shell.engine.showLog')}</ProductButton>
          </div>
        </section>
      </Show>
      <Show when={logOpen()}>
        <ProductDialog title={message('shell.engine.log')} onDismiss={() => { logRequest++; setLogOpen(false) }}>
          <Show when={log()} fallback={<ProductLoading label={message('shell.engine.loadingLog')} />}>
            {(result) => <Switch>
              <Match when={!result().ok}><p role="alert">{message('shell.engine.logUnavailable')}</p></Match>
              <Match when={result().ok}>
                {(() => {
                  const tail = result()
                  if (!tail.ok) return null
                  return <>
                    <Show when={tail.truncated}><p class="dinkster-description">{message('shell.engine.logTruncated')}</p></Show>
                    <Show when={tail.available} fallback={<p>{message('shell.engine.noLog')}</p>}>
                      <ProductCodeBlock label={message('shell.engine.log')} value={tail.text || message('shell.engine.emptyLog')} />
                    </Show>
                  </>
                })()}
              </Match>
            </Switch>}
          </Show>
        </ProductDialog>
      </Show>
    </div>
  )
}
