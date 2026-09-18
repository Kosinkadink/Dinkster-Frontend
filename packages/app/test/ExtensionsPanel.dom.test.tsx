// @vitest-environment happy-dom

import { createMenuRegistry, ExtensionHost, registerCatalog, setLocale, type DeploymentPolicy } from '@dinkster/core'
import { createWidgetRegistry } from '@dinkster/widgets'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionsPanel } from '../src/ExtensionsPanel.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function host(policy?: DeploymentPolicy) {
  return new ExtensionHost({
    menus: createMenuRegistry(),
    widgets: createWidgetRegistry(),
    registerSetting: () => () => {},
    ...(policy === undefined ? {} : { policy }),
  })
}

function mount(extensionHost = host()) {
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <ExtensionsPanel host={extensionHost} />, root)
  return { extensionHost, root, unmount }
}

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('ExtensionsPanel', () => {
  it('shows an explicit empty state that relabels after mounting', async () => {
    registerCatalog('de-DE', {
      'extensions.empty': '[KEINE ERWEITERUNGSPAKETE]',
      'extensions.title': '[ERWEITERUNGSVERWALTUNG]',
    })
    const { root } = mount()
    const empty = root.querySelector('[data-testid="extensions-empty"]')
    expect(empty?.textContent).toContain('No extension packs')
    setLocale('de-DE')
    await flush()
    expect(root.querySelector('[data-testid="extensions-empty"]')).toBe(empty)
    expect(empty?.textContent).toBe('[KEINE ERWEITERUNGSPAKETE]')
  })

  it('localizes the mounted no-contributions state while preserving pack identity', async () => {
    registerCatalog('de-DE', {
      'extensions.emptyContributions': '[DIESES PAKET HAT KEINE BEITRAGE]',
    })
    const extensionHost = host()
    extensionHost.register({ id: 'raw.empty-pack', displayName: 'Raw empty pack', contributions: [] }, () => {})
    const { root } = mount(extensionHost)
    const pack = root.querySelector('[data-testid="extension-pack"]')
    expect(pack?.textContent).toContain('This pack declares no contributions.')

    setLocale('de-DE')
    await flush()
    expect(root.querySelector('[data-testid="extension-pack"]')).toBe(pack)
    expect(pack?.textContent).toContain('[DIESES PAKET HAT KEINE BEITRAGE]')
    expect(pack?.textContent).toContain('Raw empty pack')
    expect(pack?.textContent).toContain('raw.empty-pack')
  })

  it('presents complete pack, category, and contribution identity with truthful states', async () => {
    const { extensionHost, root } = mount()
    extensionHost.register({
      id: 'fixture.pack-with-a-deliberately-long-identity',
      displayName: 'Fixture management pack',
      contributions: [
        { id: 'fixture.pack-with-a-deliberately-long-identity.menu.open-diagnostics', category: 'menu', label: 'Open diagnostics' },
        { id: 'fixture.pack-with-a-deliberately-long-identity.setting.enabled', category: 'setting', label: 'Feature enabled' },
        { id: 'fixture.pack-with-a-deliberately-long-identity.setting.unavailable', category: 'setting', label: 'Unavailable setting' },
      ],
    }, (api) => {
      api.setting('fixture.pack-with-a-deliberately-long-identity.setting.enabled', {
        id: 'fixture.pack-with-a-deliberately-long-identity.setting.enabled', name: 'Feature enabled', type: 'boolean', defaultValue: true,
      })
    })
    await flush()

    expect(root.querySelector('[data-testid="extension-pack"]')?.textContent).toContain('fixture.pack-with-a-deliberately-long-identity')
    expect(root.querySelectorAll('[data-testid="extension-category"]')).toHaveLength(2)
    expect(root.querySelector('[data-contribution$="menu.open-diagnostics"]')?.textContent).toContain('Declared, not registered')
    expect(root.querySelector('[data-contribution$="setting.enabled"]')?.textContent).toContain('Active and registered')
    expect(root.querySelector('[data-contribution$="setting.unavailable"]')?.textContent).toContain('Declared, not registered')

    const categoryToggle = root.querySelector<HTMLButtonElement>('[data-category="setting"] [data-testid="extension-category-toggle"]')!
    categoryToggle.focus()
    categoryToggle.click()
    await flush()
    expect(document.activeElement).toBe(categoryToggle)
    expect(categoryToggle.getAttribute('aria-checked')).toBe('false')
    expect(root.querySelector('[data-contribution$="setting.enabled"]')?.textContent).toContain('Enabled, inactive: category disabled')
  })

  it('explains policy-disabled controls and activation rollback diagnostics', async () => {
    registerCatalog('de-DE', {
      'extensions.aria.diagnostics': '[DIAGNOSEN FUR {id}]',
      'extensions.control.unregistered': '[PAKET NICHT REGISTRIERT]',
      'extensions.diagnostics': '[DIAGNOSEN]',
      'extensions.state.activationFailed': '[AKTIVIERUNG FEHLGESCHLAGEN]',
      'extensions.state.blockedByPolicy': '[DURCH RICHTLINIE BLOCKIERT]',
    })
    const blocked = host({ deny: ['policy-pack/setting'] })
    const blockedMount = mount(blocked)
    blocked.register({
      id: 'policy-pack',
      contributions: [{ id: 'policy-pack.setting.enabled', category: 'setting' }],
    }, (api) => api.setting('policy-pack.setting.enabled', {
      id: 'policy-pack.setting.enabled', name: 'Policy setting', type: 'boolean', defaultValue: true,
    }))
    await flush()

    const blockedToggle = blockedMount.root.querySelector<HTMLButtonElement>('[data-testid="extension-contribution-toggle"]')!
    expect(blockedToggle.disabled).toBe(true)
    const reasonId = blockedToggle.getAttribute('aria-describedby')!
    expect(blockedMount.root.querySelector(`#${reasonId}`)?.textContent).toBe("Blocked by deployment deny rule 'policy-pack/setting'.")
    expect(blockedMount.root.textContent).toContain('Blocked by policy')

    const failed = host()
    const failedMount = mount(failed)
    failed.register({
      id: 'failed-pack',
      contributions: [{ id: 'failed-pack.setting.crash', category: 'setting' }],
    }, (api) => {
      api.setting('failed-pack.setting.crash', {
        id: 'failed-pack.setting.crash', name: 'Crash', type: 'boolean', defaultValue: true,
      })
      throw new Error('fixture activation failure')
    })
    await flush()

    expect(failedMount.root.textContent).toContain('Activation failed')
    expect(failedMount.root.textContent).toContain('extension.activate-failed')
    expect(failedMount.root.textContent).toContain('fixture activation failure')
    expect(failedMount.root.querySelector<HTMLButtonElement>('[data-testid="extension-pack-toggle"]')?.disabled).toBe(true)

    setLocale('de-DE')
    await flush()
    expect(blockedMount.root.textContent).toContain('[DURCH RICHTLINIE BLOCKIERT]')
    expect(blockedMount.root.textContent).toContain("Blocked by deployment deny rule 'policy-pack/setting'.")
    expect(failedMount.root.textContent).toContain('[AKTIVIERUNG FEHLGESCHLAGEN]')
    expect(failedMount.root.textContent).toContain('[PAKET NICHT REGISTRIERT]')
    expect(failedMount.root.querySelector('.extension-diagnostics')?.getAttribute('aria-label')).toBe('[DIAGNOSEN FUR failed-pack]')
    expect(failedMount.root.textContent).toContain('[DIAGNOSEN]')
    expect(failedMount.root.textContent).toContain('extension.activate-failed')
    expect(failedMount.root.textContent).toContain('fixture activation failure')
    blockedMount.unmount()
    blockedMount.root.remove()
    failed.unregister('failed-pack')
    await flush()
    expect(failedMount.root.querySelector('[data-testid="extensions-empty"]')).not.toBeNull()
  })

  it('keeps an admitted contribution and its ancestor gates operable', async () => {
    const allowed = host({ allow: ['allowed-pack.setting.enabled'] })
    const { root } = mount(allowed)
    allowed.register({
      id: 'allowed-pack',
      contributions: [{ id: 'allowed-pack.setting.enabled', category: 'setting' }],
    }, (api) => api.setting('allowed-pack.setting.enabled', {
      id: 'allowed-pack.setting.enabled', name: 'Allowed setting', type: 'boolean', defaultValue: true,
    }))
    await flush()

    expect(root.querySelector<HTMLButtonElement>('[data-testid="extension-pack-toggle"]')?.disabled).toBe(false)
    expect(root.querySelector<HTMLButtonElement>('[data-testid="extension-category-toggle"]')?.disabled).toBe(false)
    expect(root.querySelector<HTMLButtonElement>('[data-testid="extension-contribution-toggle"]')?.disabled).toBe(false)
    expect(root.querySelector('[data-testid="extension-contribution"]')?.textContent).toContain('Active and registered')
  })

  it('relabels mounted management chrome without changing extension data, identity, focus, or gates', async () => {
    registerCatalog('de-DE', {
      'extensions.action.enableCategory': '[{id} {category} KATEGORIE AKTIVIEREN]',
      'extensions.action.enableContribution': '[BEITRAG {id} AKTIVIEREN]',
      'extensions.action.enablePack': '[PAKET {id} AKTIVIEREN]',
      'extensions.aria.category': '[KATEGORIE {category}]',
      'extensions.aria.pack': '[ERWEITERUNGSPAKET {id}]',
      'extensions.description': '[HOST-RICHTLINIE SETZT DIE AUSSERE GRENZE]',
      'extensions.state.active': '[AKTIV]',
      'extensions.state.activeRegistered': '[AKTIV UND REGISTRIERT]',
      'extensions.state.disabledByUser': '[VOM BENUTZER DEAKTIVIERT]',
      'extensions.title': '[ERWEITERUNGSVERWALTUNG]',
      'Raw contribution label': '[NICHT UBERSETZEN]',
      'Raw extension pack': '[NICHT UBERSETZEN]',
      'setting': '[NICHT UBERSETZEN]',
    })
    const extensionHost = host()
    extensionHost.register({
      id: 'raw.pack',
      displayName: 'Raw extension pack',
      contributions: [{ id: 'raw.pack.setting.enabled', category: 'setting', label: 'Raw contribution label' }],
    }, (api) => api.setting('raw.pack.setting.enabled', {
      id: 'raw.pack.setting.enabled', name: 'Raw setting', type: 'boolean', defaultValue: true,
    }))
    const setPackEnabled = vi.spyOn(extensionHost, 'setPackEnabled')
    const setCategoryEnabled = vi.spyOn(extensionHost, 'setCategoryEnabled')
    const setContributionEnabled = vi.spyOn(extensionHost, 'setContributionEnabled')
    const { root } = mount(extensionHost)
    const panel = root.querySelector<HTMLElement>('[data-testid="extensions-panel"]')!
    const pack = root.querySelector<HTMLElement>('[data-testid="extension-pack"]')!
    const category = root.querySelector<HTMLElement>('[data-testid="extension-category"]')!
    const contribution = root.querySelector<HTMLElement>('[data-testid="extension-contribution"]')!
    const categoryToggle = category.querySelector<HTMLButtonElement>('[data-testid="extension-category-toggle"]')!
    const changedBeforeLocale = extensionHost.changed.get()
    categoryToggle.focus()

    setLocale('de-DE')
    await flush()

    expect(root.querySelector('h2')?.textContent).toBe('[ERWEITERUNGSVERWALTUNG]')
    expect(root.textContent).toContain('[HOST-RICHTLINIE SETZT DIE AUSSERE GRENZE]')
    expect(pack.getAttribute('aria-label')).toBe('[ERWEITERUNGSPAKET raw.pack]')
    expect(category.getAttribute('aria-label')).toBe('[KATEGORIE setting]')
    expect(root.querySelector('[data-testid="extension-pack-toggle"]')?.getAttribute('aria-label')).toBe('[PAKET raw.pack AKTIVIEREN]')
    expect(categoryToggle.getAttribute('aria-label')).toBe('[raw.pack setting KATEGORIE AKTIVIEREN]')
    expect(contribution.querySelector('[data-testid="extension-contribution-toggle"]')?.getAttribute('aria-label')).toBe('[BEITRAG raw.pack.setting.enabled AKTIVIEREN]')
    expect(root.textContent).toContain('Raw extension pack')
    expect(root.textContent).toContain('Raw contribution label')
    expect(category.querySelector('h4')?.textContent).toBe('setting')
    expect(pack.dataset['state']).toBe('Registered and active')
    expect(category.querySelector<HTMLElement>('.extension-category-header > .extension-state')?.dataset['state']).toBe('Active')
    expect(contribution.dataset['state']).toBe('Active and registered')
    expect(contribution.querySelector('.extension-state')?.textContent).toBe('[AKTIV UND REGISTRIERT]')
    expect(root.querySelector('[data-testid="extensions-panel"]')).toBe(panel)
    expect(root.querySelector('[data-testid="extension-pack"]')).toBe(pack)
    expect(root.querySelector('[data-testid="extension-category"]')).toBe(category)
    expect(root.querySelector('[data-testid="extension-contribution"]')).toBe(contribution)
    expect(document.activeElement).toBe(categoryToggle)
    expect(extensionHost.changed.get()).toBe(changedBeforeLocale)
    expect(setPackEnabled).not.toHaveBeenCalled()
    expect(setCategoryEnabled).not.toHaveBeenCalled()
    expect(setContributionEnabled).not.toHaveBeenCalled()

    categoryToggle.click()
    await flush()
    expect(categoryToggle.getAttribute('aria-checked')).toBe('false')
    expect(category.querySelector<HTMLElement>('.extension-category-header > .extension-state')?.dataset['state']).toBe('Disabled by user')
    expect(category.querySelector('.extension-state')?.textContent).toBe('[VOM BENUTZER DEAKTIVIERT]')
    expect(setCategoryEnabled).toHaveBeenCalledWith('raw.pack', 'setting', false)
    expect(document.activeElement).toBe(categoryToggle)
  })
})
