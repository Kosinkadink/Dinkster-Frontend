// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus } from '@dinkster/client'
import { TopBarAccount } from '../src/TopBarAccount.js'

const signedOut: AccountStatus = {
  available: true, canStartSignIn: true, signInUnavailableReason: null,
  signedIn: false, profile: null, signIn: 'idle',
}

function mount(initial: AccountStatus) {
  let current = initial
  const connection = {
    accountStatus: vi.fn(async () => current),
    startAccountSignIn: vi.fn(async () => {
      current = { ...current, signIn: 'pending' as const }
      return { ...current, authorizationUrl: 'https://identity.example.test/authorize?state=1' }
    }),
    cancelAccountSignIn: vi.fn(async () => (current = { ...current, signIn: 'idle' })),
    signOutAccount: vi.fn(async () => (current = signedOut)),
  }
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <TopBarAccount connection={connection} />, root)
  return {
    root, connection, dispose,
    become(next: AccountStatus) { current = next },
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('top bar account control', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('is hidden when the engine has no account services', async () => {
    vi.useFakeTimers()
    const view = mount({ ...signedOut, available: false, canStartSignIn: false, signInUnavailableReason: 'account-unavailable' })
    await settle()
    expect(view.root.querySelector('button')).toBeNull()
    view.dispose()
  })

  it('starts sign-in, opens the sign-in page, and shows the account once the session exists', async () => {
    vi.useFakeTimers()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const view = mount(signedOut)
    await settle()
    const circle = view.root.querySelector<HTMLButtonElement>('button[aria-label="Sign in"]')!
    circle.click()
    await settle()
    expect(open).toHaveBeenCalledWith('https://identity.example.test/authorize?state=1', '_blank', 'noopener')
    expect(view.root.querySelector('button[aria-label="Signing in"]')).not.toBeNull()

    view.become({ ...signedOut, signedIn: true, profile: { displayName: 'Alex Rivers', email: 'alex@example.test' } })
    await vi.advanceTimersByTimeAsync(2000)
    const account = view.root.querySelector<HTMLButtonElement>('button[aria-label="Account menu: Alex Rivers"]')
    expect(account).not.toBeNull()

    account!.click()
    await settle()
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
    await settle()
    expect(view.connection.signOutAccount).toHaveBeenCalledOnce()
    expect(view.root.querySelector('button[aria-label="Sign in"]')).not.toBeNull()
    view.dispose()
  })

  it('explains that sign-in starts on the engine machine instead of starting it', async () => {
    vi.useFakeTimers()
    const view = mount({ ...signedOut, canStartSignIn: false, signInUnavailableReason: 'account-sign-in-requires-engine-machine' })
    await settle()
    view.root.querySelector<HTMLButtonElement>('button[aria-label="Sign in"]')!.click()
    await settle()
    expect(view.connection.startAccountSignIn).not.toHaveBeenCalled()
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Sign in from the computer that runs Dinkster.')
    view.dispose()
  })
})
