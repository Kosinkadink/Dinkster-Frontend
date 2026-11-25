// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale } from '@dinkster/core'
import { BackendsPanel } from '../src/BackendsPanel.js'
import { createConnectionProfile, listConnectionProfiles } from '../src/connection-profiles.js'
import { AppState } from '../src/app-state.js'
import type { DinksterDesktopBridge } from '../src/desktop-bridge.js'
import '../src/locale.js'
import { scopedStorageKey } from '../src/projects.js'

const disposers: (() => void)[] = []
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
const profileRow = (root: Element) => root.querySelector('[data-connection="https://host:8443"]')!
const startRemoval = (root: Element) => {
  const row = profileRow(root)
  row.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click()
  row.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
}

function fakeBridge(overrides: Partial<DinksterDesktopBridge> = {}): DinksterDesktopBridge {
  return {
    locale: vi.fn(async () => 'en-US'),
    status: vi.fn(),
    retry: vi.fn(),
    chooseDirectory: vi.fn(),
    fileCapabilities: vi.fn(async () => ({ nativeFolderChoice: false, reveal: false })),
    windowContext: vi.fn(async () => ({ id: 'primary' as const, kind: 'primary' as const })),
    windowLayout: vi.fn(async () => ({ windows: [] })),
    openWorkflowWindow: vi.fn(async () => undefined),
    openPanelWindow: vi.fn(async () => undefined),
    redockWindow: vi.fn(async () => undefined),
    switchProject: vi.fn(async () => undefined),
    openProjectWindow: vi.fn(async () => undefined),
    setConnectionCredential: vi.fn(async () => undefined),
    retireConnectionProfile: vi.fn(async () => undefined),
    connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [] })),
    takeDeepLinks: vi.fn(async () => []),
    onStatus: vi.fn(() => () => undefined),
    onLog: vi.fn(() => () => undefined),
    onWindowLayout: vi.fn(() => () => undefined),
    onDeepLinkPending: vi.fn(() => () => undefined),
    ...overrides,
  } as DinksterDesktopBridge
}

function mount(bridge: DinksterDesktopBridge) {
  window.dinksterDesktop = bridge
  const app = new AppState()
  vi.spyOn(app, 'addBackendByUrl').mockResolvedValue(undefined)
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <BackendsPanel app={app} />, root)
  disposers.push(() => { unmount(); app.dispose() })
  return { root, unmount, app }
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.restoreAllMocks()
  delete window.dinksterDesktop
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
})

describe('Backend saved connections', () => {
  it('updates an open token editor and visible failure when the locale changes', async () => {
    registerCatalog('de-DE', {
      'connectionProfiles.action.clearToken': '[Token loschen]',
      'connectionProfiles.action.removeAriaLabel': '[Profil entfernen: {name}]',
      'connectionProfiles.action.saveToken': '[Token speichern]',
      'connectionProfiles.badge.tokenInKeychain': '[Token im Schlusselbund]',
      'connectionProfiles.error.clearToken': '[Token nicht geloscht: {error}]',
      'connectionProfiles.label.accessTokenFor': '[Zugriffstoken fur {name}]',
      'backendsPanel.title': '[Backend connections]',
      'backendsPanel.aria.actions': '[Actions for {backend}]',
    })
    const profile = createConnectionProfile('Studio source', 'https://host:8443')!
    const bridge = fakeBridge({
      connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [profile.id] })),
      setConnectionCredential: vi.fn(async () => { throw new Error('keychain locked') }),
    })
    const { root } = mount(bridge)
    await flush()
    ;(root.querySelector('[data-testid="profile-token-edit"]') as HTMLButtonElement).click()
    ;(root.querySelector('[data-testid="profile-token-clear"]') as HTMLButtonElement).click()
    await flush()
    expect(root.querySelector('[data-testid="backends-panel"]')?.getAttribute('aria-label')).toBe('Backend connections')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('The token was not cleared: keychain locked')

    setLocale('de-DE')

    expect(root.querySelector('[data-testid="backends-panel"]')?.getAttribute('aria-label')).toBe('[Backend connections]')
    expect(root.querySelector('[data-testid="profile-credential-badge"]')?.textContent).toBe('[Token im Schlusselbund]')
    expect(root.querySelector('[data-testid="profile-token-clear"]')?.textContent?.trim()).toBe('[Token loschen]')
    expect(root.querySelector('[data-testid="profile-token-save"]')?.textContent?.trim()).toBe('[Token speichern]')
    expect(root.querySelector('.connection-profile-token-editor label')?.textContent).toContain('[Zugriffstoken fur Studio source]')
    expect(profileRow(root).querySelector('[aria-haspopup="menu"]')?.getAttribute('aria-label')).toBe('[Actions for Studio source]')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('[Token nicht geloscht: keychain locked]')
    expect(root.querySelector('[data-connection="https://host:8443"]')?.textContent).toContain('Studio source')
    expect(root.querySelector('[data-connection="https://host:8443"] code')?.textContent).toBe('https://host:8443')
  })

  it('unifies an added server and duplicate saved profiles, retiring every credential on removal', async () => {
    const profile = createConnectionProfile('Studio', 'https://host:8443')!
    const duplicate = createConnectionProfile('Other saved name', 'https://host:8443/')!
    const calls: string[] = []
    const bridge = fakeBridge({
      retireConnectionProfile: vi.fn(async (profileId: string) => { calls.push(profileId) }),
    })
    const { root, app } = mount(bridge)
    const backend = app.addBackend('https://host:8443', 'Studio', false, 'dinkster')!
    await flush()
    expect(root.querySelectorAll('[data-testid="backend-row"]')).toHaveLength(2)
    expect(listConnectionProfiles()).toEqual([profile, duplicate])
    startRemoval(root)
    expect(listConnectionProfiles()).toEqual([profile, duplicate])
    ;(root.querySelector('[data-fill="solid"]') as HTMLButtonElement).click()
    await flush()
    expect(calls).toEqual([profile.id, duplicate.id])
    expect(listConnectionProfiles()).toEqual([])
    expect(app.backendFor(backend.id)).toBeUndefined()
    expect(root.querySelector('[data-connection="https://host:8443"]')).toBeNull()
  })

  it('keeps the profile and reports the failure when the credential cannot be cleared', async () => {
    const profile = createConnectionProfile('Studio', 'https://host:8443')!
    const bridge = fakeBridge({
      retireConnectionProfile: vi.fn(async () => { throw new Error('keychain locked') }),
    })
    const { root } = mount(bridge)
    await flush()
    startRemoval(root)
    expect(listConnectionProfiles()).toEqual([profile])
    ;(root.querySelector('[data-fill="solid"]') as HTMLButtonElement).click()
    await flush()
    expect(listConnectionProfiles()).toEqual([profile])
    expect(root.querySelector('[data-connection="https://host:8443"]')).not.toBeNull()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('keychain locked')
  })

  it('blocks other credential mutations while a removal is pending', async () => {
    const profile = createConnectionProfile('Studio', 'https://host:8443')!
    const other = createConnectionProfile('Other', 'https://other.test')!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const retireConnectionProfile = vi.fn(() => gate)
    const setConnectionCredential = vi.fn(async () => undefined)
    const bridge = fakeBridge({
      connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [profile.id, other.id] })),
      retireConnectionProfile,
      setConnectionCredential,
    })
    const { root } = mount(bridge)
    await flush()
    startRemoval(root)
    expect(listConnectionProfiles()).toEqual([profile, other])
    ;(root.querySelector('[data-fill="solid"]') as HTMLButtonElement).click()
    await flush()
    const clear = root.querySelector<HTMLButtonElement>('[data-connection="https://other.test"] [data-testid="profile-token-clear"]')!
    expect(clear.disabled).toBe(true)
    clear.click()
    expect(retireConnectionProfile).toHaveBeenCalledTimes(1)
    expect(setConnectionCredential).not.toHaveBeenCalled()
    release()
    await flush()
    expect(listConnectionProfiles()).toEqual([other])
    expect(root.querySelector('[data-connection="https://host:8443"]')).toBeNull()
  })

  it('clears the failure alert once a retried token clear succeeds', async () => {
    const profile = createConnectionProfile('Studio', 'https://host:8443')!
    const setConnectionCredential = vi.fn()
      .mockRejectedValueOnce(new Error('keychain locked'))
      .mockResolvedValue(undefined)
    const bridge = fakeBridge({
      connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [profile.id] })),
      setConnectionCredential,
    })
    const { root } = mount(bridge)
    await flush()
    ;(root.querySelector('[data-testid="profile-token-clear"]') as HTMLButtonElement).click()
    await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('keychain locked')
    ;(root.querySelector('[data-testid="profile-token-clear"]') as HTMLButtonElement).click()
    await flush()
    expect(root.querySelector('[role="alert"]')).toBeNull()
  })

  it('reports a storage write failure instead of pretending the profile saved', async () => {
    const bridge = fakeBridge()
    const { root } = mount(bridge)
    await flush()
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    try {
      ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Add backend')!.click()
      const address = root.querySelector<HTMLInputElement>('[data-testid="backend-url-input"]')!
      address.value = 'https://host:8443'
      address.dispatchEvent(new Event('input', { bubbles: true }))
      const token = root.querySelector<HTMLInputElement>('[data-testid="profile-token-input"]')!
      token.value = 'secret'
      token.dispatchEvent(new Event('input', { bubbles: true }))
      ;(root.querySelector('[data-testid="backend-add"]') as HTMLButtonElement).click()
      await flush()
      expect(root.querySelector('[role="alert"]')?.textContent).toContain('storage')
      expect(bridge.setConnectionCredential).not.toHaveBeenCalled()
    } finally {
      setItem.mockRestore()
    }
  })

  it('uses one Connect form and retains a credential-backed line after failed discovery', async () => {
    const ids: string[] = []
    const { root } = mount(fakeBridge({
      connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [...ids] })),
      setConnectionCredential: vi.fn(async (id: string) => { ids.push(id) }),
    }))
    await flush()
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Add backend')!.click()
    expect(root.querySelectorAll('form')).toHaveLength(1)
    const enter = (selector: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(selector)!
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    enter('[data-testid="backend-url-input"]', 'https://host:8443')
    enter('[data-testid="profile-name-input"]', 'Studio')
    enter('[data-testid="profile-token-input"]', 'private-token')
    ;(root.querySelector('[data-testid="backend-add"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(root.querySelector('#backend-add-error')?.textContent).toContain('could not be added'))
    expect(listConnectionProfiles().map(({ name, url }) => ({ name, url }))).toEqual([{ name: 'Studio', url: 'https://host:8443' }])
    expect(root.querySelectorAll('[data-testid="backend-row"]')).toHaveLength(2)
    expect(profileRow(root).getAttribute('data-status')).toBe('disconnected')
    expect(profileRow(root).querySelector('[data-testid="profile-credential-badge"]')?.textContent).toBe('Token in OS keychain')
    const saved = localStorage.getItem(scopedStorageKey('dinkster.connectionProfiles'))!
    expect(saved).toContain('Studio')
    expect(saved).not.toContain('private-token')
    expect(profileRow(root).querySelector('[data-testid="profile-connect"]')).not.toBeNull()
  })

  it('refuses a token save that lost the cross-window lock race to a removal', async () => {
    // Two mounted sections model two windows on the same project: they share
    // localStorage and the Web Lock but have independent busy flags.
    let chain: Promise<unknown> = Promise.resolve()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, task: () => Promise<unknown>) => {
          const run = chain.then(() => task())
          chain = run.then(() => undefined, () => undefined)
          return run
        },
      },
    })
    try {
      const profile = createConnectionProfile('Studio', 'https://host:8443')!
      let releaseRetire!: () => void
      const retireGate = new Promise<void>((resolve) => { releaseRetire = resolve })
      const secretCalls: unknown[][] = []
      const bridge = fakeBridge({
        connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [profile.id] })),
        retireConnectionProfile: vi.fn(async () => { await retireGate }),
        setConnectionCredential: vi.fn(async (profileId: string, url: string | undefined, secret: string | null) => {
          secretCalls.push([profileId, url, secret])
        }),
      })
      const windowA = mount(bridge)
      const windowB = mount(bridge)
      await flush()

      // Window A starts removing the profile; its credential clear stalls
      // while holding the lock.
      startRemoval(windowA.root)
      ;(windowA.root.querySelector('[data-fill="solid"]') as HTMLButtonElement).click()
      await flush()

      // Window B saves a replacement token for the same profile meanwhile.
      ;(windowB.root.querySelector('[data-testid="profile-token-edit"]') as HTMLButtonElement).click()
      const editor = windowB.root.querySelector('[data-testid="profile-token-editor-input"]') as HTMLInputElement
      editor.value = 'replacement-secret'
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      ;(windowB.root.querySelector('[data-testid="profile-token-save"]') as HTMLButtonElement).click()
      await flush()

      releaseRetire()
      for (let i = 0; i < 10; i += 1) await Promise.resolve()

      // The removal won; the queued save must not re-store a credential for
      // the deleted profile.
      expect(listConnectionProfiles()).toEqual([])
      expect(secretCalls).toEqual([])
      expect(windowB.root.querySelector('[role="alert"]')?.textContent).toContain('removed in another window')
    } finally {
      Reflect.deleteProperty(navigator, 'locks')
    }
  })

})
