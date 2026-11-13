// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, registerCatalog, setLocale } from '@dinkster/core'
import { DinksterConnection, type Delegation, type PrincipalSummary } from '@dinkster/client'
import { AgentPermissionsPanel } from '../src/AgentPermissionsPanel.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const agent = (overrides: Partial<PrincipalSummary> = {}): PrincipalSummary => ({
  principalId: 'agent-one',
  kind: 'agent',
  categories: { edit: true, execute: false, future: true },
  ...overrides,
})

function mount(fetchPrincipals: () => Promise<readonly PrincipalSummary[]>, updatePrincipalPermissions = vi.fn()) {
  const connection = {
    fetchPrincipals: vi.fn(fetchPrincipals), updatePrincipalPermissions,
    mintDelegation: vi.fn(async () => ({ token: 'test-delegation', id: 'd1', expiresAt: 123 })),
    fetchDelegations: vi.fn(async (): Promise<readonly Delegation[]> => []),
    revokeDelegation: vi.fn(async () => {}),
  }
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <AgentPermissionsPanel connection={connection} backendLabel="Local" />, root)
  return { connection, root, unmount }
}

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('AgentPermissionsPanel', () => {
  it('updates mounted labels without translating principal data or changing the mint request', async () => {
    registerCatalog('de-DE', {
      'agentPermissions.aria.panel': '[Rechte: {backend}]',
      'agentPermissions.category.edit': '[Dokumente bearbeiten]',
      'agentPermissions.aria.category': '[{principal}: {category}]',
      'agentPermissions.mint': '[Delegation erstellen]',
      'agentPermissions.name': '[Agentenname]',
      'agentPermissions.title': '[Agentenrechte]',
    })
    const { root, connection } = mount(async () => [agent({ principalId: 'user-one', kind: 'human', self: true, scopes: ['shared'] })])
    await flush()
    expect(root.querySelector('h3')?.textContent).toBe('Agent permissions')
    setLocale('de-DE')
    expect(root.querySelector('h3')?.textContent).toBe('[Agentenrechte]')
    expect(root.querySelector('section')?.getAttribute('aria-label')).toBe('[Rechte: Local]')
    expect(root.querySelector('[data-category="edit"]')?.getAttribute('aria-label')).toBe('[user-one: [Dokumente bearbeiten]]')
    expect(root.querySelector('label[for="delegate-name"]')?.textContent).toBe('[Agentenname]')
    expect(root.querySelector<HTMLInputElement>('#delegate-name')?.value).toBe('My agent')
    expect(root.textContent).toContain('Run jobs')
    expect(root.textContent).toContain('future')
    const mint = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '[Delegation erstellen]')!
    mint.click()
    await flush()
    expect(connection.mintDelegation).toHaveBeenCalledWith({ scope: 'shared', displayName: 'My agent' })
  })

  it('keeps auth-off toggles visible through the real principal decoder without requesting a delegation', async () => {
    const fetchFn = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/api/principals')
        ? [{ principalId: 'local', kind: 'human', local: true, self: true, scopes: ['local'], categories: { edit: true } }]
        : { error: 'authenticated-human-session-required' },
    ), { status: url.endsWith('/api/principals') ? 200 : 403 }))
    const connection = new DinksterConnection({ id: asConnectionId('native'), baseUrl: '', clientId: 'human', fetchFn })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <AgentPermissionsPanel connection={connection} backendLabel="Local" />, root)
    try {
      await vi.waitFor(() => expect(root.querySelector('[data-testid="agent-permission-toggle"]')).not.toBeNull())
      expect(root.querySelector('[data-testid="connect-agent"]')).toBeNull()
      expect(fetchFn.mock.calls.map(([url]) => url)).toEqual(['/api/principals'])
    } finally { unmount(); connection.disconnect() }
  })

  it.each([undefined, 123])('lets a JWT user mint and revoke a delegation with optional expiry (%s)', async (expiresAt) => {
    const { root, connection } = mount(async () => [agent({ principalId: 'user-one', kind: 'human', self: true, scopes: ['shared'] })])
    await flush()
    expect(root.querySelector('[data-testid="connect-agent"]')).not.toBeNull()
    const delegation: Delegation = { id: 'd1', displayName: 'My agent', kind: 'agent', scope: 'shared', sessionId: null, ...(expiresAt !== undefined && { expiresAt }) }
    connection.fetchDelegations.mockResolvedValue([delegation])
    const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
    button('Create delegation').click()
    await flush()
    expect(connection.mintDelegation).toHaveBeenCalledWith({ scope: 'shared', displayName: 'My agent' })
    expect(root.textContent).not.toContain('test-delegation')
    expect(root.querySelectorAll('[data-testid="delegation"]')).toHaveLength(1)
    const row = root.querySelector('[data-testid="delegation"]')!
    expect(row.textContent).toContain('Active while you are signed in')
    expect(row.textContent?.includes('expires')).toBe(expiresAt !== undefined)
    expect(row.textContent).not.toContain('Invalid Date')
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    button('Copy delegation token').click()
    await flush()
    expect(copy).toHaveBeenCalledWith('test-delegation')
    connection.fetchDelegations.mockResolvedValue([])
    button('Revoke').click()
    await flush()
    expect(connection.revokeDelegation).toHaveBeenCalledWith('d1')
    expect(root.querySelectorAll('[data-testid="delegation"]')).toHaveLength(0)
    root.querySelector<HTMLButtonElement>('[data-category="execute"]')!.click()
    expect(connection.updatePrincipalPermissions).toHaveBeenCalledWith('user-one', { execute: true })
  })

  it('renders agent rows in category order and excludes humans', async () => {
    const { root } = mount(async () => [
      agent({ categories: { future: true, queue: false, edit: true, read: false } }),
      agent({ principalId: 'human-one', kind: 'human', categories: { edit: true } }),
    ])
    await flush()

    expect(root.querySelector('[data-testid="agent-permissions"]')).not.toBeNull()
    expect(root.querySelectorAll('[data-testid="agent-permissions-row"]')).toHaveLength(1)
    expect(root.textContent).toContain('agent-one')
    expect(root.textContent).not.toContain('human-one')
    expect([...root.querySelectorAll('[data-testid="agent-permission-toggle"]')].map((item) => item.getAttribute('data-category'))).toEqual(['edit', 'read', 'queue', 'future'])
    expect(root.textContent).toContain('Edit documents')
    expect(root.textContent).toContain('future')
  })

  it('PUTs only the changed category and replaces categories from the response', async () => {
    let finish!: (categories: Readonly<Record<string, boolean>>) => void
    const update = vi.fn(() => new Promise<Readonly<Record<string, boolean>>>((resolve) => { finish = resolve }))
    const { root } = mount(async () => [agent(), agent({ principalId: 'agent-two' })], update)
    await flush()
    const rows = root.querySelectorAll('[data-testid="agent-permissions-row"]')
    const execute = rows[0]!.querySelector<HTMLButtonElement>('[data-category="execute"]')!
    execute.click()
    expect(update).toHaveBeenCalledWith('agent-one', { execute: true })
    expect([...rows[0]!.querySelectorAll<HTMLButtonElement>('[data-testid="agent-permission-toggle"]')].every((control) => control.disabled)).toBe(true)
    expect([...rows[1]!.querySelectorAll<HTMLButtonElement>('[data-testid="agent-permission-toggle"]')].every((control) => !control.disabled)).toBe(true)
    finish({ execute: true, queue: false })
    await flush()

    const updatedRows = root.querySelectorAll('[data-testid="agent-permissions-row"]')
    expect(updatedRows[0]!.querySelector('[data-category="edit"]')).toBeNull()
    expect(updatedRows[0]!.querySelector('[data-category="execute"]')?.getAttribute('aria-checked')).toBe('true')
    expect(updatedRows[0]!.querySelector('[data-category="queue"]')?.getAttribute('aria-checked')).toBe('false')
    expect(updatedRows[1]!.querySelector('[data-category="edit"]')).not.toBeNull()
  })

  it('keeps old values and shows a row error when the PUT fails', async () => {
    const { root } = mount(async () => [agent()], vi.fn(async () => { throw new Error('permission update failed') }))
    await flush()
    root.querySelector<HTMLButtonElement>('[data-category="execute"]')!.click()
    await flush()

    expect(root.querySelector('[data-category="execute"]')?.getAttribute('aria-checked')).toBe('false')
    expect(root.querySelector<HTMLButtonElement>('[data-category="execute"]')?.disabled).toBe(false)
    expect(root.querySelector('[data-testid="agent-permissions-error"]')?.textContent).toBe('permission update failed')
  })
})
