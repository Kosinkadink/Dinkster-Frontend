import { createSignal, For, onCleanup, Show } from 'solid-js'
import {
  createPageLoad, ProductButton, ProductConfirmation, ProductDialog, ProductDisclosure, ProductErrorBanner,
  ProductField, ProductList, ProductListRow, ProductNotice, ProductPageLoad, ProductPanel,
  ProductProjectSection, ProductSwitch, ProductTable, ProductTextButton, ProductTextInput, ProductToast,
} from '@dinkster/ui'
import { requestFailure, requestFetch } from '@dinkster/client'
import { useAppMessage } from '../locale.js'
import { failureMessage } from '../request-failure.js'

const fetchRequest = requestFetch((url, init) => fetch(url, init))

interface Address {
  readonly address: string
  readonly source: 'pack' | 'user'
}

interface Pack {
  readonly pack: string
  readonly graphicsCard: { readonly requested: boolean | null; readonly granted: boolean | null }
  readonly internetAddresses: readonly Address[] | null
}

interface Readiness {
  readonly sandboxPacks: boolean
  readonly available: boolean
  readonly detail: string
}

/** Mount separately for each selected root so an old read cannot update another installation. */
export function InstallationSandbox(props: { readonly root: string; readonly engine: string }) {
  const message = useAppMessage()
  const readiness = createPageLoad<Readiness>()
  const packs = createPageLoad<readonly Pack[]>()
  const [changing, setChanging] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [notification, setNotification] = createSignal<{ message: string }>()
  const [opened, setOpened] = createSignal<string>()
  const addressButtons = new Map<string, HTMLButtonElement>()
  let retired = false
  onCleanup(() => { retired = true })
  const query = () => new URLSearchParams({ root: props.root, engine: props.engine })

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchRequest(`/supervisor/installations/${path}`, { ...init, cache: 'no-store' })
    if (!response.ok) throw await requestFailure(response)
    return response.json()
  }
  const readReadiness = () => request<Readiness>(`sandbox/readiness?${new URLSearchParams({ root: props.root })}`)
    .catch((failure) => { throw new Error(failureMessage(failure)) })
  const readPacks = async () => {
    const result = await request<{ available: boolean; packs: readonly Pack[] | null; message?: string }>(`packs?${query()}`)
      .catch((failure) => { throw new Error(failureMessage(failure)) })
    if (!result.available || result.packs === null) throw new Error(result.message ?? message('installations.sandbox.packsUnavailable'))
    return result.packs
  }
  const refresh = async () => {
    await Promise.all([readiness.load(readReadiness), packs.load(readPacks)])
  }
  void refresh()

  async function dismissAddresses(pack: string) {
    setOpened(undefined)
    await packs.load(readPacks)
    // Refresh replaces the disabled trigger after native dialog focus restoration.
    // Do not steal focus if the person has already moved to another control.
    if (!retired && !opened() && document.activeElement === document.body) {
      addressButtons.get(pack)?.focus()
    }
  }

  async function change(enabled: boolean) {
    if (changing() || readiness.pending()) return
    setChanging(true)
    setError(undefined)
    try {
      await request('sandbox', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: props.root, sandboxPacks: enabled }),
      })
      setNotification({ message: message('installations.sandbox.saved') })
    } catch (failure) {
      setError(failureMessage(failure))
    } finally {
      // A lost write reply is ambiguous. Reread saved authority rather than retrying the write.
      await refresh()
      setChanging(false)
    }
  }

  return <ProductProjectSection title={message('installations.sandbox.title')}>
    <div class="dinkster-stack">
      <Show when={error()}>{(failure) => <ProductErrorBanner onDismiss={() => setError(undefined)}>{failure()}</ProductErrorBanner>}</Show>
      <ProductPanel fill="quiet">
        <ProductPageLoad page={readiness} read={readReadiness} loadingLabel={message('installations.sandbox.loading')}>
          {(status) => <div class="dinkster-stack">
            <div class="dinkster-actions">
              <ProductSwitch label={message('installations.sandbox.switch')} checked={status.sandboxPacks}
                disabled={changing() || readiness.pending() || Boolean(readiness.error()) || !status.available && !status.sandboxPacks}
                onChange={(next) => { void change(next) }} />
              <span>{message('installations.sandbox.switch')}</span>
              <Show when={status.available}><span class="dinkster-description">{message('installations.sandbox.available')}</span></Show>
            </div>
            <Show when={!status.available} fallback={<p class="dinkster-description">{message('installations.sandbox.explanation')}</p>}>
              <ProductNotice tone="warning">{message('installations.sandbox.unavailable')}</ProductNotice>
              <ProductDisclosure title={message('setup.details')}><p class="dinkster-description">{status.detail}</p></ProductDisclosure>
              <ProductButton disabled={changing() || readiness.pending()} onClick={() => { void refresh() }}>{message('setup.retry')}</ProductButton>
            </Show>
            <Show when={status.sandboxPacks}>
              <ProductNotice>{message('installations.sandbox.nextStart')}</ProductNotice>
              <ProductPageLoad page={packs} read={readPacks} loadingLabel={message('installations.sandbox.packsLoading')}>
                {(rows) => <Show when={rows.length} fallback={<p class="dinkster-description">{message('installations.sandbox.noPacks')}</p>}>
                  <ProductTable label={message('installations.sandbox.packs')} rows={rows} columns={[
                    { label: message('installations.sandbox.pack'), cell: (pack) => pack.pack },
                    { label: message('installations.sandbox.graphics'), cell: (pack) => message(pack.graphicsCard.requested === null
                      ? 'installations.sandbox.unknown' : pack.graphicsCard.requested ? 'installations.sandbox.usesGraphics' : 'installations.sandbox.noGraphics') },
                    { label: message('installations.sandbox.internet'), cell: (pack) => <Show when={pack.internetAddresses !== null}
                      fallback={message('installations.sandbox.unknown')}>
                      <ProductTextButton label={message('installations.sandbox.addresses', { count: pack.internetAddresses!.length })}
                        ref={(button) => { addressButtons.set(pack.pack, button) }}
                        disabled={changing() || packs.pending() || Boolean(packs.error())} onClick={() => setOpened(pack.pack)} />
                    </Show> },
                  ]} />
                </Show>}
              </ProductPageLoad>
            </Show>
          </div>}
        </ProductPageLoad>
      </ProductPanel>
    </div>
    <Show when={opened()} keyed>{(pack) => <InternetAddresses root={props.root} engine={props.engine} pack={pack}
      onDismiss={() => { void dismissAddresses(pack) }}
      onSaved={() => setNotification({ message: message('installations.sandbox.addressSaved') })} />}</Show>
    <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
  </ProductProjectSection>
}

function InternetAddresses(props: {
  readonly root: string; readonly engine: string; readonly pack: string
  readonly onDismiss: () => void; readonly onSaved: () => void
}) {
  const message = useAppMessage()
  const page = createPageLoad<readonly Address[]>()
  const [address, setAddress] = createSignal('')
  const [changing, setChanging] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [fieldError, setFieldError] = createSignal<string>()
  const [removing, setRemoving] = createSignal<string>()
  const path = `/supervisor/installations/packs/internet?${new URLSearchParams({ root: props.root, engine: props.engine, pack: props.pack })}`
  const read = async () => {
    const response = await fetchRequest(path, { cache: 'no-store' })
    if (!response.ok) throw new Error(failureMessage(await requestFailure(response)))
    return (await response.json() as { internetAddresses: readonly Address[] }).internetAddresses
  }
  void page.load(read)

  async function change(method: 'POST' | 'DELETE', value: string) {
    if (changing()) return
    setChanging(true)
    setError(undefined)
    setFieldError(undefined)
    try {
      const response = await fetchRequest('/supervisor/installations/packs/internet', {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: props.root, engine: props.engine, pack: props.pack, address: value }),
      })
      if (!response.ok) {
        const failure = await requestFailure(response)
        if (method === 'POST' && response.status === 400) { setFieldError(failureMessage(failure)); return }
        throw failure
      }
      if (method === 'POST') setAddress('')
      setRemoving(undefined)
      props.onSaved()
    } catch (failure) {
      setError(failureMessage(failure))
    } finally {
      await page.load(read)
      setChanging(false)
    }
  }

  return <ProductDialog title={message('installations.sandbox.addressTitle', { pack: props.pack })} pending={changing()} onDismiss={props.onDismiss}>
    <Show when={error()}>{(failure) => <ProductErrorBanner onDismiss={() => setError(undefined)}>{failure()}</ProductErrorBanner>}</Show>
    <Show when={!removing()} fallback={<ProductConfirmation consequence={message('installations.sandbox.removeConsequence', { address: removing()! })}
      actionLabel={message('installations.sandbox.remove')} intent="remove" pending={changing()}
      onCancel={() => setRemoving(undefined)} onConfirm={() => { void change('DELETE', removing()!) }} />}>
    <ProductPageLoad page={page} read={read} loadingLabel={message('installations.sandbox.addressLoading')}>
      {(rows) => <ProductList label={message('installations.sandbox.internet')}>
        <For each={rows}>{(row) => <ProductListRow title={row.address}
          description={message(row.source === 'pack' ? 'installations.sandbox.asked' : 'installations.sandbox.added')}
          action={<ProductTextButton intent="remove" label={message('installations.sandbox.remove')} disabled={changing() || page.pending() || Boolean(page.error())}
            onClick={() => setRemoving(row.address)} />} />}</For>
      </ProductList>}
    </ProductPageLoad>
    <form class="dinkster-stack" onSubmit={(event) => { event.preventDefault(); void change('POST', address()) }}>
      <ProductField label={message('installations.sandbox.newAddress')} {...(fieldError() ? { error: fieldError()! } : {})}>
        {(attributes) => <ProductTextInput {...attributes} value={address()} disabled={changing()}
          onInput={(event) => { setAddress(event.currentTarget.value); setFieldError(undefined) }} />}
      </ProductField>
      <div class="dinkster-actions"><ProductButton type="submit" intent="add" fill="solid"
        disabled={!address().trim() || changing() || page.pending() || Boolean(page.error())}>{message('installations.sandbox.allow')}</ProductButton></div>
    </form>
    </Show>
  </ProductDialog>
}
