import { createSignal, For, onMount, Show } from 'solid-js'
import type { Delegation, DinksterConnection, PrincipalSummary } from '@dinkster/client'
import { ProductCheckbox } from './ProductControls.js'
import { ProductField, ProductNotice } from './ProductForm.js'
import { useAppMessage } from './locale.js'

type PermissionsConnection = Pick<DinksterConnection, 'fetchPrincipals' | 'updatePrincipalPermissions' | 'mintDelegation' | 'fetchDelegations' | 'revokeDelegation'>

const KNOWN_CATEGORIES = ['edit', 'execute', 'read', 'assets', 'settings', 'queue'] as const
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  edit: 'agentPermissions.category.edit',
  execute: 'agentPermissions.category.execute',
  read: 'agentPermissions.category.read',
  assets: 'agentPermissions.category.assets',
  settings: 'agentPermissions.category.settings',
  queue: 'agentPermissions.category.queue',
}

const orderedCategories = (categories: Readonly<Record<string, boolean>>): readonly string[] => {
  const keys = Object.keys(categories)
  return [...KNOWN_CATEGORIES.filter((category) => keys.includes(category)), ...keys.filter((category) => !KNOWN_CATEGORIES.includes(category as typeof KNOWN_CATEGORIES[number]))]
}

export function AgentPermissionsPanel(props: { readonly connection: PermissionsConnection; readonly backendLabel: string }) {
  const message = useAppMessage()
  const [principals, setPrincipals] = createSignal<readonly PrincipalSummary[]>()
  const [saving, setSaving] = createSignal<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = createSignal<Readonly<Record<string, string>>>({})
  const [delegations, setDelegations] = createSignal<readonly Delegation[]>([])
  const [name, setName] = createSignal(message('agentPermissions.defaultName'))
  const [scope, setScope] = createSignal('')
  const [sessionId, setSessionId] = createSignal('')
  const [token, setToken] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal('')
  const self = () => principals()?.find((principal) => principal.self && !principal.local)
  const refreshDelegations = async (): Promise<void> => { setDelegations(await props.connection.fetchDelegations()) }
  const categoryLabel = (category: string): string => {
    const key = CATEGORY_LABELS[category]
    return key === undefined ? category : message(key)
  }

  onMount(() => {
    void props.connection.fetchPrincipals()
      .then(async (result) => {
        setPrincipals(result.filter((principal) => principal.kind !== 'human' || principal.self))
        if (self()) {
          setScope(self()?.scopes?.[0] ?? '')
          await refreshDelegations()
        }
      })
      .catch(() => setPrincipals(undefined))
  })

  const connectAgent = async (): Promise<void> => {
    setBusy(true)
    setNotice('')
    setToken('')
    try {
      const result = await props.connection.mintDelegation({
        scope: scope(), displayName: name(), expiresInSeconds: 600,
        ...(sessionId().trim() ? { sessionId: sessionId().trim() } : {}),
      })
      setToken(result.token)
      await refreshDelegations()
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const revoke = async (id: string): Promise<void> => {
    setBusy(true)
    setToken('')
    try { await props.connection.revokeDelegation(id); await refreshDelegations() }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const toggle = async (principal: PrincipalSummary, category: string, value: boolean): Promise<void> => {
    if (saving().has(principal.principalId)) return
    setSaving((current) => new Set([...current, principal.principalId]))
    setErrors((current) => ({ ...current, [principal.principalId]: '' }))
    try {
      const categories = await props.connection.updatePrincipalPermissions(principal.principalId, { [category]: value })
      setPrincipals((current) => current?.map((item) => item.principalId === principal.principalId ? { ...item, categories } : item))
    } catch (cause) {
      setErrors((current) => ({ ...current, [principal.principalId]: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setSaving((current) => new Set([...current].filter((id) => id !== principal.principalId)))
    }
  }

  return (
    <Show when={(principals()?.length ?? 0) > 0}>
      <section class="agent-permissions" data-testid="agent-permissions" aria-label={message('agentPermissions.aria.panel', { backend: props.backendLabel })}>
        <h3>{message('agentPermissions.title')}</h3>
        <p>{message('agentPermissions.description')}</p>
        <Show when={self()}>
          <div class="agent-permissions-row" data-testid="connect-agent">
            <h4>{message('agentPermissions.connect')}</h4>
            <ProductField controlId="delegate-name" label={message('agentPermissions.name')}>
              <input id="delegate-name" value={name()} maxLength={64} onInput={(event) => setName(event.currentTarget.value)} />
            </ProductField>
            <ProductField controlId="delegate-scope" label={message('agentPermissions.scope')}>
              <select id="delegate-scope" value={scope()} onChange={(event) => setScope(event.currentTarget.value)}>
                <For each={self()?.scopes}>{(value) => <option value={value}>{value}</option>}</For>
              </select>
            </ProductField>
            <ProductField controlId="delegate-session" label={message('agentPermissions.session')}>
              <input id="delegate-session" value={sessionId()} onInput={(event) => setSessionId(event.currentTarget.value)} />
            </ProductField>
            <button type="button" disabled={busy() || !scope() || !name().trim()} onClick={() => void connectAgent()}>{message('agentPermissions.mint')}</button>
            <Show when={token()}>
              <ProductNotice tone="status">{message('agentPermissions.created')}</ProductNotice>
              <button type="button" onClick={() => void navigator.clipboard.writeText(token()).then(() => setToken('')).catch(() => setNotice(message('agentPermissions.clipboardUnavailable')))}>{message('agentPermissions.copy')}</button>
            </Show>
            <For each={delegations()}>{(delegation) => (
              <div class="agent-permissions-identity" data-testid="delegation">
                <strong>{delegation.displayName}</strong>
                <span>{message('agentPermissions.expires', { scope: delegation.scope, time: new Date(delegation.expiresAt * 1000).toLocaleTimeString() })}</span>
                <button type="button" disabled={busy()} onClick={() => void revoke(delegation.id)}>{message('agentPermissions.revoke')}</button>
              </div>
            )}</For>
            <Show when={notice()}><ProductNotice tone="error">{notice()}</ProductNotice></Show>
          </div>
        </Show>
        <div class="agent-permissions-list">
          <For each={principals()}>{(principal) => (
            <div class="agent-permissions-row" data-testid="agent-permissions-row">
              <div class="agent-permissions-identity">
                <strong>{principal.principalId}</strong>
                <span class="backend-badge">{principal.kind}</span>
              </div>
              <div class="agent-permissions-controls">
                <For each={orderedCategories(principal.categories)}>{(category) => (
                  <label>
                    <ProductCheckbox
                      checked={principal.categories[category] === true}
                      disabled={saving().has(principal.principalId)}
                      testId="agent-permission-toggle"
                      dataAttributes={{ 'data-category': category }}
                      ariaLabel={message('agentPermissions.aria.category', { category: categoryLabel(category), principal: principal.principalId })}
                      onChange={(checked) => void toggle(principal, category, checked)}
                    />
                    <span>{categoryLabel(category)}</span>
                  </label>
                )}</For>
              </div>
              <Show when={errors()[principal.principalId]}>{(message) => (
                <ProductNotice tone="error" testId="agent-permissions-error">{message()}</ProductNotice>
              )}</Show>
            </div>
          )}</For>
        </div>
      </section>
    </Show>
  )
}
