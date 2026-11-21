import { For, Show, batch, createMemo, createSignal, type JSX } from 'solid-js'
import { render } from 'solid-js/web'
import { createStore, reconcile } from 'solid-js/store'
import { CreditCard, KeyRound, Package, Shield, User } from 'lucide-solid'
import {
  ProductAccountMenu,
  ProductAuthCard,
  ProductButton,
  ProductCodeBlock,
  ProductDisclosure,
  ProductErrorBanner,
  ProductFacts,
  ProductField,
  ProductLink,
  ProductList,
  ProductListRow,
  ProductLoading,
  ProductNotice,
  ProductPage,
  ProductPanel,
  ProductProviderButton,
  ProductSection,
  ProductStatusPill,
  ProductQrCode,
  ProductSelect,
  ProductShell,
  ProductTextInput,
  ProductToast,
  reportProductEvent,
  type ProductRole,
} from '@dinkster/ui'
import '@dinkster/ui/styles.css'

export interface AccountControl {
  text: string
  role?: ProductRole
  press?: 'commits' | 'opens' | 'aside'
  go?: string
  href?: string
  external?: string
  disabled?: boolean | string
  changed_fields?: string[]
  provider?: string
  [key: string]: unknown
}
interface Conditional {
  when?: string
  unless?: string
}
interface AccountRow extends Conditional {
  label: string
  detail: string
  actions: AccountControl[]
  inactive?: boolean
}
interface Fact {
  label: string
  value: string
  chip?: string
  tone?: 'good' | 'warning' | 'problem' | 'neutral'
  link?: AccountControl
}
export interface AccountBlock extends Conditional, Partial<AccountControl> {
  t:
    | 'h1'
    | 'h2'
    | 'section'
    | 'panel'
    | 'steps'
    | 'or'
    | 'p'
    | 'link'
    | 'button'
    | 'buttons'
    | 'provider'
    | 'field'
    | 'select'
    | 'facts'
    | 'rows'
    | 'codes'
    | 'qr'
    | 'key'
  blocks?: AccountBlock[]
  text?: string
  id?: string
  label?: string
  kind?: string
  value?: string
  hint?: string
  error?: string
  muted?: boolean
  link?: AccountControl
  aside?: AccountControl
  items?: AccountControl[] | AccountRow[] | Fact[] | string[]
  options?: string[]
  values?: string[]
  history_label?: string
  src?: string
  alt?: string
  copy?: string
  role?: ProductRole
  provider?: string
}
interface Message {
  tone: 'success' | 'error' | 'info'
  text: string
  link?: AccountControl
}
export interface AccountModel {
  screen: {
    id: string
    layout: string
    nav?: string
    blocks: AccountBlock[]
    banner?: Message
    back?: AccountControl
    footer?: { text: string; action: AccountControl }
  }
  state: {
    flags: Record<string, boolean>
    loading?: boolean
    loadFailed?: boolean
    flash: Message | null
    dismissedBanner?: string | null
  }
  navigation: { id: string; text: string; go: string; href: string }[]
  username: string
  email?: string
  pictureSrc?: string | null
  signOut: AccountControl
}
export interface AccountViewOptions {
  root: HTMLElement
  config: { providers: string[] }
  onAction: (control: AccountControl) => Promise<void>
  onNavigate: (id: string) => void
  onChange: (id: string, value: string) => void
}

const navigationIcons = {
  profile: User,
  security: Shield,
  'api-keys': KeyRound,
  billing: CreditCard,
  publishing: Package,
}
const sentenceLabel = (label: string) =>
  label === 'API Keys' ? 'API keys' : label

function flattenBlocks(
  blocks: AccountBlock[],
  include: (block: AccountBlock) => boolean = () => true,
): AccountBlock[] {
  return blocks
    .filter(include)
    .flatMap((block) => [block, ...flattenBlocks(block.blocks ?? [], include)])
}

/** The account service owns API calls and secret lifetime; this view owns DOM
 * and interaction behavior. Fields expose data-account-field to that controller. */
export function accountView(options: AccountViewOptions) {
  const [model, setModel] = createSignal<AccountModel>()
  const [blocks, setBlocks] = createStore<AccountBlock[]>([])
  const controls = createMemo(() => flattenBlocks(blocks))
  const [pending, setPending] = createSignal<AccountControl>()
  const [edits, setEdits] = createSignal<Record<string, string>>({})
  const baselines: Record<string, string> = {}
  let sourceState: AccountModel['state'] | undefined
  const disabled = (control: AccountControl) =>
    control.changed_fields?.every((id) => id in baselines)
      ? !control.changed_fields.some(
          (id) =>
            (edits()[id] ??
              controls().find((block) => block.id === id)?.value ??
              '') !== baselines[id],
        )
      : !!control.disabled
  const change = (id: string, value: string) => {
    setEdits((current) => ({ ...current, [id]: value }))
    options.onChange(id, value)
  }
  const [dismissed, setDismissed] = createSignal<Message>()
  const [notification, setNotification] = createSignal<{ message: string }>()
  let lastFlash: Message | null = null
  const visible = (item: Conditional) =>
    (!item.when || !!model()?.state.flags[item.when]) &&
    (!item.unless || !model()?.state.flags[item.unless])
  const route = () =>
    model()?.screen.id.startsWith('account.publishing')
      ? ('registry' as const)
      : ('account' as const)
  const activate = async (control: AccountControl) => {
    if (pending() || disabled(control)) return
    setPending(control)
    const start = performance.now()
    try {
      await options.onAction(control)
    } finally {
      reportProductEvent({
        type: 'interaction-timing',
        route: route(),
        durationMs: performance.now() - start,
      })
      setPending(undefined)
    }
  }
  const action = (control: AccountControl, link = false): JSX.Element =>
    link ? (
      <ProductLink
        href={control.href || '#'}
        onClick={(event) => {
          event.preventDefault()
          void activate(control)
        }}
      >
        {sentenceLabel(control.text)}
      </ProductLink>
    ) : (
      <ProductButton
        intent={control.role ?? 'neutral'}
        fill={control.press === 'commits' ? 'solid' : 'outline'}
        type={control.press === 'commits' ? 'submit' : 'button'}
        disabled={disabled(control) || (!!pending() && pending() !== control)}
        pending={pending() === control}
        data-changed-fields={
          control.changed_fields
            ? JSON.stringify(control.changed_fields)
            : undefined
        }
        data-go={control.go || control.external}
        onClick={(event) => {
          event.preventDefault()
          void activate(control)
        }}
      >
        {sentenceLabel(control.text)}
      </ProductButton>
    )
  const message = (item: Message): JSX.Element => (
    <Show when={dismissed() !== item}>
      <Show
        when={item.tone === 'error'}
        fallback={
          <ProductNotice>
            {item.text} {item.link && action(item.link, true)}
          </ProductNotice>
        }
      >
        <ProductErrorBanner
          onDismiss={() => {
            if (sourceState?.flash === item) sourceState.flash = null
            else if (sourceState)
              sourceState.dismissedBanner = model()?.screen.id ?? null
            setDismissed(item)
          }}
        >
          {item.text} {item.link && action(item.link, true)}
        </ProductErrorBanner>
      </Show>
    </Show>
  )
  const rows = (items: () => AccountRow[], label: () => string) => (
    <ProductList label={label()}>
      <For each={items()}>
        {(row) => (
          <ProductListRow
            title={row.label}
            description={row.detail}
            action={
              <div class="dinkster-actions">
                <For each={row.actions}>
                  {(control) => (
                    <div class="dinkster-stack">
                      {action(control)}
                      <Show when={typeof control.disabled === 'string'}>
                        <span class="dinkster-description">
                          {control.disabled}
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            }
          />
        )}
      </For>
    </ProductList>
  )
  const block = (item: AccountBlock): JSX.Element => {
    const label = () => item.label ?? ''
    switch (item.t) {
      case 'h1':
        return null
      case 'h2':
        return <h2 class="dinkster-heading">{item.text}</h2>
      case 'section':
        return (
          <ProductSection title={item.text ?? ''}>
            {renderBlocks(() => item.blocks ?? [])}
          </ProductSection>
        )
      case 'panel':
        return (
          <ProductPanel>{renderBlocks(() => item.blocks ?? [])}</ProductPanel>
        )
      case 'steps':
      case 'p':
        return (
          <p
            class={
              item.muted || item.t === 'steps'
                ? 'dinkster-description'
                : 'dinkster-stack'
            }
          >
            {item.text} {item.link && action(item.link, true)}
          </p>
        )
      case 'or':
        return options.config.providers.length ? (
          <p class="dinkster-auth-separator">{item.text}</p>
        ) : null
      case 'link':
        return action(item as AccountControl, true)
      case 'button':
        return (
          <div class="dinkster-actions">{action(item as AccountControl)}</div>
        )
      case 'provider':
        return options.config.providers.includes(item.provider ?? '') &&
          (item.provider === 'github' || item.provider === 'google') ? (
          <ProductProviderButton
            provider={item.provider}
            type="button"
            disabled={
              disabled(item as AccountControl) ||
              (!!pending() && pending() !== item)
            }
            pending={pending() === item}
            onClick={() => {
              void activate(item as AccountControl)
            }}
          >
            {item.text}
          </ProductProviderButton>
        ) : null
      case 'buttons':
        return (
          <div class="dinkster-actions">
            <For each={item.items as AccountControl[]}>
              {(control) => action(control)}
            </For>
          </div>
        )
      case 'field':
        return (
          <>
            <ProductField
              label={label()}
              description={item.hint ?? ''}
              error={item.error ?? ''}
            >
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  data-account-field={item.id}
                  type={item.kind === 'password' ? 'password' : 'text'}
                  value={item.value ?? ''}
                  disabled={!!pending()}
                  autocomplete="off"
                  inputmode={item.kind === 'code' ? 'numeric' : undefined}
                  maxlength={item.kind === 'code' ? 6 : undefined}
                  onInput={(event) =>
                    change(item.id!, event.currentTarget.value)
                  }
                />
              )}
            </ProductField>
            {item.aside && action(item.aside, true)}
          </>
        )
      case 'select':
        return (
          <ProductField label={label()}>
            {(attributes) => (
              <ProductSelect
                {...attributes}
                data-account-field={item.id}
                disabled={!!pending()}
                value={
                  item.value ?? item.values?.[0] ?? item.options?.[0] ?? ''
                }
                onChange={(event) =>
                  change(item.id!, event.currentTarget.value)
                }
              >
                <For each={item.options}>
                  {(option, index) => (
                    <option value={item.values?.[index()] ?? option}>
                      {option}
                    </option>
                  )}
                </For>
              </ProductSelect>
            )}
          </ProductField>
        )
      case 'facts':
        return (
          <ProductFacts
            label="Account details"
            items={(item.items as Fact[]).map((fact) => ({
              label: fact.label,
              value: (
                <>
                  {fact.value}{' '}
                  <Show when={fact.chip}>
                    <ProductStatusPill tone={fact.tone ?? 'neutral'}>
                      {fact.chip}
                    </ProductStatusPill>
                  </Show>{' '}
                  {fact.link && action(fact.link, true)}
                </>
              ),
            }))}
          />
        )
      case 'rows': {
        const items = () => (item.items as AccountRow[]).filter(visible)
        if (!item.history_label) return rows(items, () => 'Account items')
        const active = () => items().filter((row) => !row.inactive)
        const inactive = () => items().filter((row) => row.inactive)
        return (
          <div class="dinkster-stack">
            <Show
              when={active().length}
              fallback={<p class="dinkster-description">No active tokens.</p>}
            >
              {rows(active, () => 'Active tokens')}
            </Show>
            <Show when={inactive().length}>
              <ProductDisclosure
                title={`${item.history_label} (${inactive().length})`}
              >
                {rows(inactive, () => item.history_label ?? 'Inactive tokens')}
              </ProductDisclosure>
            </Show>
          </div>
        )
      }
      case 'codes':
        return (
          <ProductCodeBlock
            label="Recovery codes"
            value={(item.items as string[]).join('\n')}
          />
        )
      case 'qr':
        return (
          <ProductQrCode
            src={item.src ?? ''}
            alt={item.alt ?? 'QR code for the authenticator app'}
          />
        )
      case 'key':
        return (
          <ProductCodeBlock
            label={label() || 'Secret value'}
            value={item.value ?? ''}
            action={action({
              text: item.copy ?? 'Copy',
              role: item.role ?? 'neutral',
              press: item.press ?? 'aside',
            })}
          />
        )
    }
  }
  const renderBlocks = (items: () => AccountBlock[]): JSX.Element => (
    <For each={items()}>
      {(item) => (
        <Show when={visible(item)}>
          <Show when={item.t} keyed>
            {(_type) => block(item)}
          </Show>
        </Show>
      )}
    </For>
  )
  const dispose = render(() => {
    const title = createMemo(
      () => controls().find((item) => item.t === 'h1')?.text ?? 'Account',
    )
    const navigation = createMemo(() =>
      model()?.screen.layout === 'account'
        ? model()!.navigation.map((item) => ({
            label: sentenceLabel(item.text),
            href: item.href,
            icon:
              navigationIcons[item.id as keyof typeof navigationIcons] ?? User,
          }))
        : [],
    )
    const content = () => (
      <>
        <Show when={model()!.screen.back}>
          {(back) => action(back(), true)}
        </Show>
        <Show
          when={
            model()!.state.flash?.tone !== 'success' && model()!.state.flash
          }
        >
          {(flash) => message(flash() as Message)}
        </Show>
        <Show
          when={!model()!.state.loading}
          fallback={<ProductLoading label="Loading..." />}
        >
          <Show when={!model()!.state.loadFailed}>
            <Show
              when={
                model()!.state.dismissedBanner !== model()!.screen.id &&
                model()!.screen.banner
              }
            >
              {(banner) => message(banner() as Message)}
            </Show>
            {renderBlocks(() => model()!.screen.blocks)}
          </Show>
        </Show>
      </>
    )
    return (
      <div class="dinkster-root" data-density="site" data-theme="dark">
        <Show when={model()}>
          <form
            data-screen={model()!.screen.id}
            aria-busy={!!model()!.state.loading}
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              if (model()!.state.loading || model()!.state.loadFailed) return
              const control = flattenBlocks(blocks, visible).find(
                (item) => item.t === 'button' && item.press === 'commits',
              )
              if (control) void activate(control as AccountControl)
            }}
          >
            <Show
              when={model()!.screen.layout === 'card'}
              fallback={
                <ProductShell
                  title="Account"
                  navigation={navigation()}
                  currentHref={
                    model()!.navigation.find(
                      (item) => item.id === model()!.screen.nav,
                    )?.href ?? ''
                  }
                  onNavigate={(href) => {
                    const item = model()!.navigation.find(
                      (entry) => entry.href === href,
                    )
                    if (item) options.onNavigate(item.go)
                  }}
                  account={
                    <ProductAccountMenu
                      name={model()!.username}
                      email={model()!.email ?? ''}
                      pictureSrc={model()!.pictureSrc ?? null}
                      onSignOut={() => {
                        void activate(model()!.signOut)
                      }}
                    />
                  }
                >
                  <ProductPage title={title()}>{content()}</ProductPage>
                </ProductShell>
              }
            >
              <ProductAuthCard
                title={title()}
                footer={
                  <Show when={model()!.screen.footer}>
                    {(footer) => (
                      <div class="dinkster-auth-footer">
                        <p class="dinkster-description">{footer().text}</p>
                        {action(footer().action)}
                      </div>
                    )}
                  </Show>
                }
              >
                {content()}
              </ProductAuthCard>
            </Show>
          </form>
          <ProductToast
            notification={notification()}
            onDismiss={() => {
              if (sourceState) sourceState.flash = null
              setNotification(undefined)
            }}
          />
        </Show>
      </div>
    )
  }, options.root)
  return {
    render(next: AccountModel) {
      const previous = model()?.screen.id
      sourceState = next.state
      const nextControls = flattenBlocks(next.screen.blocks)
      for (const control of nextControls) {
        if (control.changed_fields && control.disabled === true) {
          for (const id of control.changed_fields) {
            baselines[id] =
              nextControls.find((field) => field.id === id)?.value ?? ''
          }
        }
      }
      batch(() => {
        setEdits({})
        const nextBlocks = structuredClone(next.screen.blocks)
        if (previous !== next.screen.id) setBlocks(nextBlocks)
        else setBlocks(reconcile(nextBlocks, { key: null, merge: true }))
        setModel({
          ...next,
          screen: { ...next.screen, blocks },
          state: { ...next.state },
        })
      })
      document.title = `${nextControls.find((item) => item.t === 'h1')?.text ?? 'Account'} | Dinkster`
      if (next.state.flash !== lastFlash) {
        lastFlash = next.state.flash
        setNotification(
          next.state.flash?.tone === 'success'
            ? { message: next.state.flash.text }
            : undefined,
        )
      }
      if (previous !== next.screen.id)
        reportProductEvent({ type: 'page-viewed', route: route() })
    },
    clear() {
      sourceState = undefined
      lastFlash = null
      for (const id of Object.keys(baselines)) delete baselines[id]
      batch(() => {
        setModel(undefined)
        setBlocks([])
        setNotification(undefined)
        setDismissed(undefined)
        setEdits({})
      })
    },
    dispose,
  }
}
