// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale } from '@dinkster/core'
import { ConnectionProfilesSection } from '../src/ConnectionProfiles.js'
import { createConnectionProfile, listConnectionProfiles } from '../src/connection-profiles.js'
import type { AppState } from '../src/app-state.js'
import type { DinksterDesktopBridge } from '../src/desktop-bridge.js'
import '../src/locale.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function fakeBridge(overrides: Partial<DinksterDesktopBridge> = {}): DinksterDesktopBridge {
  return {
    locale: vi.fn(async () => 'en-US'),
    status: vi.fn(),
    retry: vi.fn(),
    info: vi.fn(),
    selectEngine: vi.fn(),
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    chooseDirectory: vi.fn(),
    exportSnapshot: vi.fn(),
    importSnapshot: vi.fn(),
    systemCheck: vi.fn(),
    clearCache: vi.fn(),
    exportSupportReport: vi.fn(),
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
    remoteWorkers: vi.fn(async () => []),
    saveRemoteWorker: vi.fn(async () => undefined),
    removeRemoteWorker: vi.fn(async () => undefined),
    chooseRemoteWorkerFile: vi.fn(async () => undefined),
    takeDeepLinks: vi.fn(async () => []),
    onStatus: vi.fn(() => () => undefined),
    onLog: vi.fn(() => () => undefined),
    onInfo: vi.fn(() => () => undefined),
    onWindowLayout: vi.fn(() => () => undefined),
    onDeepLinkPending: vi.fn(() => () => undefined),
    ...overrides,
  } as DinksterDesktopBridge
}

function mount(bridge: DinksterDesktopBridge) {
  window.dinksterDesktop = bridge
  const app = { addBackendByUrl: vi.fn(async () => true) } as unknown as AppState
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <ConnectionProfilesSection app={app} />, root)
  return { root, unmount }
}

afterEach(() => {
  delete window.dinksterDesktop
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
})

describe('ConnectionProfilesSection removal', () => {
  it('updates an open token editor and visible failure when the locale changes', async () => {
    registerCatalog('de-DE', {
      'connectionProfiles.action.clearToken': '[Token loschen]',
      'connectionProfiles.action.removeAriaLabel': '[Profil entfernen: {name}]',
      'connectionProfiles.action.saveToken': '[Token speichern]',
      'connectionProfiles.badge.tokenInKeychain': '[Token im Schlusselbund]',
      'connectionProfiles.error.clearToken': '[Token nicht geloscht: {error}]',
      'connectionProfiles.label.accessTokenFor': '[Zugriffstoken fur {name}]',
      'connectionProfiles.title': '[Gespeicherte Verbindungen]',
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
    expect(root.querySelector('h2')?.textContent).toBe('Saved connections')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('The token was not cleared: keychain locked')

    setLocale('de-DE')

    expect(root.querySelector('h2')?.textContent).toBe('[Gespeicherte Verbindungen]')
    expect(root.querySelector('[data-testid="connection-profiles"]')?.getAttribute('aria-label')).toBe('[Gespeicherte Verbindungen]')
    expect(root.querySelector('[data-testid="profile-credential-badge"]')?.textContent).toBe('[Token im Schlusselbund]')
    expect(root.querySelector('[data-testid="profile-token-clear"]')?.textContent?.trim()).toBe('[Token loschen]')
    expect(root.querySelector('[data-testid="profile-token-save"]')?.textContent?.trim()).toBe('[Token speichern]')
    expect(root.querySelector('.connection-profile-token-editor label')?.textContent).toContain('[Zugriffstoken fur Studio source]')
    expect(root.querySelector('[data-testid="profile-remove"]')?.getAttribute('aria-label')).toBe('[Profil entfernen: Studio source]')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('[Token nicht geloscht: keychain locked]')
    expect(root.querySelector('[data-testid="profile-row"]')?.textContent).toContain('Studio source')
    expect(root.querySelector('.backend-address')?.textContent).toBe('https://host:8443')
  })

  it('retires the stored credential before removing the profile', async () => {
    const profile = createConnectionProfile('Studio', 'https://host:8443')!
    const calls: string[] = []
    const bridge = fakeBridge({
      retireConnectionProfile: vi.fn(async (profileId: string) => { calls.push(profileId) }),
    })
    const { root } = mount(bridge)
    await flush()
    ;(root.querySelector('[data-testid="profile-remove"]') as HTMLButtonElement).click()
    await flush()
    expect(calls).toEqual([profile.id])
    expect(listConnectionProfiles()).toEqual([])
    expect(root.querySelector('[data-testid="profile-row"]')).toBeNull()
  })

  it('keeps the profile and reports the failure when the credential cannot be cleared', async () => {
    const profile = createConnectionProfile('Studio', 'https://host:8443')!
    const bridge = fakeBridge({
      retireConnectionProfile: vi.fn(async () => { throw new Error('keychain locked') }),
    })
    const { root } = mount(bridge)
    await flush()
    ;(root.querySelector('[data-testid="profile-remove"]') as HTMLButtonElement).click()
    await flush()
    expect(listConnectionProfiles()).toEqual([profile])
    expect(root.querySelector('[data-testid="profile-row"]')).not.toBeNull()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('keychain locked')
  })

  it('blocks other credential mutations while a removal is pending', async () => {
    const profile = createConnectionProfile('Studio', 'https://host:8443')!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const retireConnectionProfile = vi.fn(() => gate)
    const setConnectionCredential = vi.fn(async () => undefined)
    const bridge = fakeBridge({
      connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [profile.id] })),
      retireConnectionProfile,
      setConnectionCredential,
    })
    const { root } = mount(bridge)
    await flush()
    ;(root.querySelector('[data-testid="profile-remove"]') as HTMLButtonElement).click()
    await flush()
    const clear = root.querySelector('[data-testid="profile-token-clear"]') as HTMLButtonElement
    expect(clear.disabled).toBe(true)
    clear.click() // must be refused even if the disabled state were bypassed
    expect(retireConnectionProfile).toHaveBeenCalledTimes(1)
    expect(setConnectionCredential).not.toHaveBeenCalled()
    release()
    await flush()
    expect(listConnectionProfiles()).toEqual([])
    expect(root.querySelector('[data-testid="profile-row"]')).toBeNull()
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
      ;(root.querySelector('[data-testid="profile-url-input"]') as HTMLInputElement).value = 'https://host:8443'
      root.querySelector('[data-testid="profile-url-input"]')!.dispatchEvent(new Event('input', { bubbles: true }))
      ;(root.querySelector('[data-testid="profile-add"]') as HTMLButtonElement).click()
      await flush()
      expect(root.querySelector('[role="alert"]')?.textContent).toContain('storage')
      expect(bridge.setConnectionCredential).not.toHaveBeenCalled()
    } finally {
      setItem.mockRestore()
    }
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
      ;(windowA.root.querySelector('[data-testid="profile-remove"]') as HTMLButtonElement).click()
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

  it('reports a clear-token failure without dropping the badge silently', async () => {
    const profile = createConnectionProfile('Studio', 'https://host:8443')!
    const bridge = fakeBridge({
      connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [profile.id] })),
      setConnectionCredential: vi.fn(async () => { throw new Error('keychain locked') }),
    })
    const { root } = mount(bridge)
    await flush()
    ;(root.querySelector('[data-testid="profile-token-clear"]') as HTMLButtonElement).click()
    await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('keychain locked')
    expect(root.querySelector('[data-testid="profile-credential-badge"]')).not.toBeNull()
  })
})
