// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { registerCatalog, setLocale } from '@dinkster/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { P2PSettings, P2PStatus, RuntimeSettingSection } from '@dinkster/client'
import { P2PPanel } from '../src/P2PPanel.js'

const digest = `blake3:${'a'.repeat(64)}`
const defaults: P2PSettings = {
  downloadsEnabled: false,
  seedingEnabled: false,
  scope: 'lan-only',
  internetUploadBytesPerSecond: 5 * 1024 ** 2,
  internetDownloadBytesPerSecond: 0,
  lanUploadBytesPerSecond: 0,
  lanDownloadBytesPerSecond: 0,
  pauseOnMetered: true,
  networkCostOverride: 'auto',
  seedMode: 'budgeted',
  internetSeedRatio: 1,
  internetSeedTimeSeconds: 86400,
  stagingBudgetBytes: 64 * 1024 ** 3,
}
const grantId = 'b'.repeat(64)
const seedGrant = {
  version: 1 as const,
  grantId,
  digest,
  sourceType: 'declarative-resolver' as const,
  sourceId: 'resolver.example/models',
  sourceRevision: `sha256:${'c'.repeat(64)}`,
  license: 'Apache-2.0',
  descriptor: {
    protocol: 'bittorrent-v2' as const,
    infoHash: 'd'.repeat(64),
    fileRoot: 'e'.repeat(64),
    pieceLength: 8388608 as const,
  },
  expiresAt: 4_000_000_000,
  evidenceType: 'public-acquisition-receipt' as const,
  evidenceId: 'f'.repeat(32),
}
const transfer = {
  digest,
  state: 'downloading' as const,
  sizeBytes: 8 * 1024 ** 2,
  peers: 3,
  downloadRateBytesPerSecond: 2 * 1024 ** 2,
  uploadRateBytesPerSecond: 1024,
  downloadedBytes: 4 * 1024 ** 2,
  uploadedBytes: 1024,
  partialBytes: 4 * 1024 ** 2,
  seedAuthorizations: [{ grantId, state: 'inactive' as const, grant: seedGrant }],
  remainingSeedRatio: 0.75,
  remainingSeedTimeSeconds: 3600,
}
const activeStatus: P2PStatus = {
  state: 'running',
  settings: { ...defaults, downloadsEnabled: true },
  restartCount: 0,
  lastError: null,
  network: { system: 'unmetered', override: 'auto', effective: 'unmetered', paused: false },
  lan: { networkAllowed: true, mappingPort: 6881, mappedDigests: [digest] },
  sidecar: {
    version: 3,
    state: 'running',
    pid: 1234,
    capabilities: { downloads: true, seeding: false },
    libtorrentVersion: '2.0.11',
    listenPort: 6881,
    listenInterfaces: ['192.168.1.10'],
    networkPaused: false,
    networkFeatures: { dht: false, trackers: false, pex: false, lsd: true, upnp: false, natMappings: false },
    leases: [],
    totals: { downloadedBytes: 12 * 1024 ** 2, uploadedBytes: 3 * 1024 ** 2 },
    transfers: [transfer],
    recovery: null,
  },
}
const section = (value: P2PSettings, writable = true): RuntimeSettingSection => ({
  value,
  source: 'default',
  mutability: 'live',
  writable,
  persistence: { available: true, persisted: true },
})
const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
const mount = (options: {
  readonly granted?: boolean
  readonly writable?: boolean
  readonly value?: P2PSettings
  readonly status?: P2PStatus
} = {}) => {
  let value = options.value ?? defaults
  let granted = options.granted !== false
  const connection = {
    fetchRuntimeSettings: vi.fn(async () => ({
      categories: { get granted() { return granted ? ['p2p'] : [] }, available: ['p2p'] },
      settings: { p2p: section(value, options.writable !== false) },
    })),
    updateRuntimeSetting: vi.fn(async (_category: string, next: unknown) => section(next as P2PSettings)),
    fetchP2PStatus: vi.fn(async () => options.status ?? activeStatus),
    performP2PTransferAction: vi.fn(async () => undefined),
  }
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <P2PPanel connection={connection} />, root)
  return { root, connection, dispose, revoke: () => { granted = false } }
}
afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('P2PPanel', () => {
  it('makes no activity request while explicitly off and presents the exact disclosure and saved choices', async () => {
    const { root, connection, dispose } = mount()
    await flush()

    expect(connection.fetchP2PStatus).not.toHaveBeenCalled()
    expect(root.textContent).toContain('Other peers can learn your IP address and that your device is requesting or sharing a particular model digest.')
    expect(root.textContent).toContain('While a download is active, peers may receive pieces from your device even when background seeding is off.')
    expect(root.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
    expect(root.querySelector<HTMLButtonElement>('[id$="-enabled"]')?.getAttribute('aria-checked')).toBe('false')
    expect(root.textContent).toContain('Current seeding state: Off.')
    expect(root.querySelector<HTMLButtonElement>('[id$="-scope"]')?.dataset['selectedId']).toBe('lan-only')
    expect(root.querySelector<HTMLInputElement>('[id$="-internetUploadBytesPerSecond"]')?.value).toBe('5')
    expect(root.querySelector<HTMLInputElement>('[id$="-internetSeedRatio"]')?.value).toBe('1')
    expect(root.querySelector<HTMLInputElement>('[id$="-internetSeedTimeSeconds"]')?.value).toBe('24')
    dispose()
  })

  it('enables downloads and seeding together and requests activity', async () => {
    const { root, connection, dispose } = mount()
    await flush()

    root.querySelector<HTMLButtonElement>('[id$="-enabled"]')!.click()
    expect(root.textContent).toContain('Current seeding state: Off.')
    root.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(connection.updateRuntimeSetting).toHaveBeenCalledWith('p2p', {
      ...defaults,
      downloadsEnabled: true,
      seedingEnabled: true,
    })
    expect(connection.fetchP2PStatus).toHaveBeenCalledTimes(1)
    expect(root.textContent).toContain('P2P settings saved.')
    expect(root.textContent).toContain('Current seeding state: On.')
    dispose()
  })

  it('represents a saved mixed state and normalizes both capabilities on', async () => {
    const { root, connection, dispose } = mount({ value: { ...defaults, downloadsEnabled: true } })
    await flush()

    const sharing = root.querySelector<HTMLButtonElement>('[id$="-enabled"]')!
    expect(sharing.getAttribute('aria-checked')).toBe('mixed')
    expect(root.textContent).toContain('Mixed')
    expect(root.textContent).toContain('Peer downloads are on while background seeding is off.')
    sharing.click()
    root.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(connection.updateRuntimeSetting).toHaveBeenCalledWith('p2p', {
      ...defaults,
      downloadsEnabled: true,
      seedingEnabled: true,
    })
    expect(sharing.getAttribute('aria-checked')).toBe('true')
    dispose()
  })

  it('summarizes a read-only mixed state consistently', async () => {
    const { root, dispose } = mount({ value: { ...defaults, downloadsEnabled: true }, writable: false })
    await flush()

    const rows = [...root.querySelectorAll('.p2p-readonly-summary > div')].map((row) => row.textContent)
    expect(rows).toContain('Peer-to-peer sharingMixed')
    expect(rows).toContain('Background seedingOff')
    dispose()
  })

  it('shows metered pause, durable counters, seed-off upload, authorization, and allowed actions', async () => {
    const metered: P2PStatus = {
      ...activeStatus,
      network: { system: 'metered', override: 'auto', effective: 'metered', paused: true },
      sidecar: {
        ...activeStatus.sidecar!,
        state: 'paused',
        networkPaused: true,
        transfers: [{ ...transfer, state: 'paused' }],
      },
    }
    const { root, connection, dispose } = mount({
      value: { ...defaults, downloadsEnabled: true, seedingEnabled: false },
      status: metered,
    })
    await flush()

    expect(root.textContent).toContain('All P2P networking is paused, including LAN.')
    expect(root.textContent).toContain('Downloaded: 12.0 MiB')
    expect(root.textContent).toContain('Uploaded: 3.0 MiB')
    expect(root.textContent).toContain('1.0 KiB/s up')
    expect(root.textContent).toContain('Authorized, inactive')
    expect(root.textContent).toContain('declarative-resolver resolver.example/models')
    expect(root.textContent).toContain('Public acquisition receipt')
    expect(root.querySelector('.p2p-authorization')?.textContent).toContain('Apache-2.0')
    expect(root.querySelector<HTMLElement>(`.p2p-authorization code[title="${grantId}"]`)?.getAttribute('aria-label')).toBe(grantId)
    expect(root.querySelector<HTMLElement>(`.p2p-authorization code[title="${seedGrant.evidenceId}"]`)?.getAttribute('aria-label')).toBe(seedGrant.evidenceId)
    expect(root.querySelector('[data-testid="p2p-transfer"] code')?.getAttribute('aria-label')).toBe(digest)
    expect(root.querySelector<HTMLButtonElement>('[id$="-enabled"]')?.getAttribute('aria-checked')).toBe('mixed')
    expect(root.textContent).not.toContain('Reset budget')
    expect(root.textContent).not.toContain('Seed continuously')

    const resume = [...root.querySelectorAll<HTMLButtonElement>('.p2p-transfer-actions button')]
      .find((button) => button.textContent === 'Resume')
    resume!.click()
    await flush()
    expect(connection.performP2PTransferAction).toHaveBeenCalledWith(digest, 'resume')
    dispose()
  })

  it('offers seed policy actions only with saved seeding enabled and active authorization, even with an empty license', async () => {
    const seededStatus: P2PStatus = {
      ...activeStatus,
      settings: { ...activeStatus.settings, seedingEnabled: true },
      sidecar: {
        ...activeStatus.sidecar!,
        capabilities: { downloads: true, seeding: true },
        transfers: [{
          ...transfer,
          seedAuthorizations: [{ grantId, state: 'active', grant: { ...seedGrant, license: '' } }],
        }],
      },
    }
    const { root, connection, dispose } = mount({
      value: { ...defaults, downloadsEnabled: true, seedingEnabled: true },
      status: seededStatus,
    })
    await flush()

    const actions = [...root.querySelectorAll<HTMLButtonElement>('.p2p-transfer-actions button')]
    expect(root.textContent).toContain('Not specified (metadata only)')
    expect(actions.map((button) => button.textContent)).toContain('Reset budget')
    const continuous = actions.find((button) => button.textContent === 'Seed continuously')
    continuous!.click()
    await flush()
    expect(connection.performP2PTransferAction).toHaveBeenCalledWith(digest, 'continuous-seed')
    dispose()
  })

  it('keeps canonical grant revocation visible after authority is removed', async () => {
    const revoked: P2PStatus = {
      ...activeStatus,
      sidecar: {
        ...activeStatus.sidecar!,
        transfers: [{
          ...transfer,
          state: 'stopped',
          seedAuthorizations: [{ grantId, state: 'revoked', grant: null }],
        }],
      },
    }
    const { root, dispose } = mount({
      value: { ...defaults, downloadsEnabled: true, seedingEnabled: true },
      status: revoked,
    })
    await flush()

    expect(root.textContent).toContain('Revoked')
    expect(root.querySelector<HTMLElement>('.p2p-authorization code')?.title).toBe(grantId)
    expect(root.textContent).not.toContain('Public acquisition receipt')
    dispose()
  })

  it('blocks invalid limits from being applied', async () => {
    const { root, connection, dispose } = mount()
    await flush()
    const input = root.querySelector<HTMLInputElement>('[id$="-internetUploadBytesPerSecond"]')!
    input.value = '-1'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    await flush()

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(root.textContent).toContain('Enter a valid value in the allowed range.')
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    expect(connection.updateRuntimeSetting).not.toHaveBeenCalled()

    input.value = '0.1'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    await flush()
    expect(input.getAttribute('aria-invalid')).toBe('true')

    input.value = '2048'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    await flush()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    dispose()
  })

  it('namespaces accessible IDs across backend panels', async () => {
    const first = mount({ value: { ...defaults, downloadsEnabled: true } })
    const second = mount({ value: { ...defaults, seedingEnabled: true } })
    await flush()

    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const panel of document.querySelectorAll<HTMLElement>('[data-testid="p2p-panel"]')) {
      for (const element of panel.querySelectorAll<HTMLElement>('[aria-labelledby], [aria-describedby]')) {
        for (const attribute of ['aria-labelledby', 'aria-describedby'] as const) {
          for (const targetId of element.getAttribute(attribute)?.split(/\s+/) ?? []) {
            expect(panel.contains(document.getElementById(targetId))).toBe(true)
          }
        }
      }
      for (const label of panel.querySelectorAll<HTMLLabelElement>('label[for]')) {
        expect(panel.contains(document.getElementById(label.htmlFor))).toBe(true)
      }
    }
    first.dispose()
    second.dispose()
  })

  it.each(['metered-network', 'unknown-network', 'budget-exhausted', 'scope-disabled'])('keeps LAN distinct from global-only closure: %s', async (closureReason) => {
    const { root, dispose } = mount({
      value: { ...defaults, downloadsEnabled: true, seedingEnabled: true, scope: 'lan-and-internet' },
      status: {
        ...activeStatus,
        network: { system: 'metered', override: 'auto', effective: 'metered', paused: false },
        sidecar: { ...activeStatus.sidecar!, global: {
          active: false, listenPort: null, closureReason,
          networkFeatures: { dht: false, pex: false, tcp: false, utp: false, trackers: false, upnp: false, natMappings: false, natPmp: false, pcp: false },
          transfers: [],
        } },
      },
    })
    await flush()
    expect(root.textContent).toContain('LAN networking is not paused.')
    expect(root.textContent).toContain(`Internet P2P is closed. Reason: ${closureReason}`)
    expect(root.textContent).not.toContain('All P2P networking is paused')
    dispose()
  })

  it('bounds staging reservations in GiB and saves zero as no new disk growth', async () => {
    const { root, connection, dispose } = mount()
    await flush()
    const input = root.querySelector<HTMLInputElement>('[id$="-stagingBudgetBytes"]')!
    expect(input.value).toBe('64')
    expect(root.textContent).toContain('Zero denies new P2P disk growth; it is not unlimited.')
    for (const raw of ['-1', '0.1', '8388608', 'Infinity', '']) {
      input.value = raw
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
      await flush()
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    }
    input.value = '0'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    root.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(connection.updateRuntimeSetting).toHaveBeenCalledWith('p2p', { ...defaults, stagingBudgetBytes: 0 })
    dispose()
  })

  it('rejects a stale form submission after P2P write permission is revoked', async () => {
    const { root, connection, dispose, revoke } = mount()
    await flush()

    root.querySelector<HTMLButtonElement>('[id$="-enabled"]')!.click()
    revoke()
    root.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(connection.updateRuntimeSetting).not.toHaveBeenCalled()
    expect(connection.fetchP2PStatus).not.toHaveBeenCalled()
    dispose()
  })

  it('hides mutations without permission and localizes the read-only surface', async () => {
    setLocale('zh-CN')
    const { root, connection, dispose } = mount({ granted: false })
    await flush()

    expect(root.textContent).toContain('P2P \u4f20\u8f93')
    expect(root.textContent).toContain('\u53ea\u8bfb')
    expect(root.textContent).toContain('\u4ec5\u9650\u5c40\u57df\u7f51')
    expect(root.querySelector('form')).toBeNull()
    expect(root.querySelector('button')).toBeNull()
    expect(connection.fetchP2PStatus).not.toHaveBeenCalled()
    dispose()
  })

  it('updates mounted chrome without replacing state, raw values, or backend requests', async () => {
    registerCatalog('de-DE', {
      'p2p.title': '[P2P-Ubertragungen]',
      'p2p.sharing': '[P2P-Freigabe]',
      'p2p.status': '[Laufzeitstatus]',
      'p2p.authorizationInactive': '[Autorisiert, inaktiv]',
      'p2p.resolver.example/models': '[Ubersetzte Quelle]',
      'p2p.Apache-2.0': '[Ubersetzte Lizenz]',
    })
    const { root, connection, dispose } = mount({ value: { ...defaults, downloadsEnabled: true, seedingEnabled: true } })
    await flush()
    const panel = root.querySelector<HTMLElement>('[data-testid="p2p-panel"]')!
    const downloads = root.querySelector<HTMLElement>('[id$="-enabled"]')!
    const transferRow = root.querySelector<HTMLElement>('[data-testid="p2p-transfer"]')!
    downloads.focus()
    const requestCounts = {
      settings: connection.fetchRuntimeSettings.mock.calls.length,
      status: connection.fetchP2PStatus.mock.calls.length,
    }

    setLocale('de-DE')

    expect(root.querySelector('[data-testid="p2p-panel"]')).toBe(panel)
    expect(root.querySelector('[id$="-enabled"]')).toBe(downloads)
    expect(root.querySelector('[data-testid="p2p-transfer"]')).toBe(transferRow)
    expect(document.activeElement).toBe(downloads)
    expect(downloads.getAttribute('aria-checked')).toBe('true')
    expect(root.textContent).toContain('[P2P-Ubertragungen]')
    expect(root.textContent).toContain('[P2P-Freigabe]')
    expect(root.textContent).toContain('[Laufzeitstatus]')
    expect(root.textContent).toContain('[Autorisiert, inaktiv]')
    expect(root.textContent).toContain('declarative-resolver resolver.example/models')
    expect(root.textContent).toContain('Apache-2.0')
    expect(transferRow.querySelector('code')?.getAttribute('aria-label')).toBe(digest)
    expect({
      settings: connection.fetchRuntimeSettings.mock.calls.length,
      status: connection.fetchP2PStatus.mock.calls.length,
    }).toEqual(requestCounts)
    dispose()
  })
})
