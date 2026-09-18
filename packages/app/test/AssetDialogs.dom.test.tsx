// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetGuessCandidate, MissingAsset } from '@dinkster/client'
import { registerCatalog, setLocale } from '@dinkster/core'
import { AppState } from '../src/app-state.js'
import { AssetConsentDialog } from '../src/AssetConsentDialog.js'
import { ImportAssetResolutionDialog } from '../src/ImportAssetResolutionDialog.js'
import '../src/locale.js'

const digest = (character: string) => `blake3:${character.repeat(64)}`
const asset: MissingAsset = {
  digest: digest('a'),
  name: 'Fixture model',
  status: 'missing',
  sources: ['https://models.example/fixture'],
  fetchable: true,
}

const candidate = (overrides: Partial<AssetGuessCandidate> = {}): AssetGuessCandidate => ({
  digest: digest('b'),
  name: 'Fixture model.safetensors',
  confidence: 'path',
  held: true,
  virtualPath: 'models/checkpoints/Fixture model.safetensors',
  mountId: 'checkpoints',
  size: 42,
  mediaType: 'application/x-safetensors',
  kind: 'model/checkpoint',
  ...overrides,
})

const mountConsent = (request: Parameters<AppState['assetConsent']['set']>[0]) => {
  const app = new AppState()
  app.assetConsent.set(request)
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <AssetConsentDialog app={app} />, root)
  return { app, root, dispose }
}

const mountResolution = (request: Parameters<AppState['importAssetResolution']['set']>[0]) => {
  const app = new AppState()
  app.importAssetResolution.set(request)
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <ImportAssetResolutionDialog app={app} />, root)
  return { app, root, dispose }
}

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
})

describe('asset modal surfaces', () => {
  it('updates an open import resolution dialog while preserving candidate data', () => {
    registerCatalog('de-DE', {
      'importAssetResolution.action.accept': '[Auswahl annehmen]',
      'importAssetResolution.action.skip': '[Uberspringen]',
      'importAssetResolution.ariaLabel': '[Importierte Workflow-Assets auflosen]',
      'importAssetResolution.availability.notHeld': '[Nicht lokal]',
      'importAssetResolution.confidence.path': '[Pfad stimmt]',
      'importAssetResolution.declaredBy': '[Von Pack {packs} deklariert.]',
      'importAssetResolution.fact.digest': '[Prufsumme]',
      'importAssetResolution.fact.mediaType': '[Medientyp]',
      'importAssetResolution.fact.path': '[Pfad]',
      'importAssetResolution.leaveUnresolved.detail': '[Originalen Importwert unverandert lassen.]',
      'importAssetResolution.leaveUnresolved.title': '[Nicht auflosen]',
      'importAssetResolution.listAriaLabel': '[Zu entscheidende Assetnamen]',
      'importAssetResolution.mount': '[Mount {id}]',
      'importAssetResolution.originalValue': '[Originaler Importwert]',
      'importAssetResolution.reason.weakMatch.detail': '[Nur eine schwache Dateinamenubereinstimmung ist verfugbar.]',
      'importAssetResolution.reason.weakMatch.heading': '[Schwache Ubereinstimmung prufen]',
      'importAssetResolution.selectionStatus': '[{selected, plural, one {# Ersatz} other {# Ersetzungen}} ausgewahlt; {unresolved, plural, one {# Name bleibt} other {# Namen bleiben}} unaufgelost.]',
      'importAssetResolution.summary': '[Auflosungszusammenfassung]',
      'importAssetResolution.summary.selected': '[Ausgewahlt]',
      'importAssetResolution.title': '[Importierte Assets auflosen]',
    })
    const rawCandidate = candidate({
      name: 'RAW Candidate Name',
      held: false,
      declaredBy: ['RAW Pack One', 'RAW Pack Two'],
      mountId: 'RAW Mount ID',
      kind: 'RAW/model-kind',
      mediaType: 'application/x-raw-media',
      virtualPath: 'RAW/path/Candidate.safetensors',
    })
    const mounted = mountResolution({
      matches: [{ query: 'RAW/query/Legacy.ckpt', candidates: [rawCandidate] }],
      reasons: { 'RAW/query/Legacy.ckpt': 'weak-match' },
      accept: vi.fn(),
      cancel: vi.fn(),
    })
    const dialog = mounted.root.querySelector<HTMLDialogElement>('[data-testid="import-asset-resolution-dialog"]')!
    expect(dialog.textContent).toContain('Resolve imported assets')
    expect(mounted.root.querySelector('[data-testid="import-assets-selection-status"]')?.textContent).toBe('1 replacement selected; 0 names remain unresolved.')

    setLocale('de-DE')

    expect(dialog.getAttribute('aria-label')).toBe('[Importierte Workflow-Assets auflosen]')
    expect(dialog.textContent).toContain('[Importierte Assets auflosen]')
    expect(dialog.textContent).toContain('[Schwache Ubereinstimmung prufen]')
    expect(dialog.textContent).toContain('[Nur eine schwache Dateinamenubereinstimmung ist verfugbar.]')
    expect(dialog.textContent).toContain('[Pfad stimmt]')
    expect(dialog.textContent).toContain('[Nicht lokal]')
    expect(dialog.textContent).toContain('[Originaler Importwert]')
    expect(dialog.textContent).toContain('[Prufsumme]')
    expect(dialog.textContent).toContain('[Medientyp]')
    expect(dialog.textContent).toContain('[Von Pack RAW Pack One, RAW Pack Two deklariert.]')
    expect(dialog.textContent).toContain('[Mount RAW Mount ID]')
    expect(dialog.textContent).toContain('[Nicht auflosen]')
    expect(mounted.root.querySelector('[data-testid="import-assets-cancel"]')?.textContent).toBe('[Uberspringen]')
    expect(mounted.root.querySelector('[data-testid="import-assets-accept"]')?.textContent).toBe('[Auswahl annehmen]')
    expect(mounted.root.querySelector('[data-testid="import-assets-selection-status"]')?.textContent).toBe('[1 Ersatz ausgewahlt; 0 Namen bleiben unaufgelost.]')
    expect(dialog.textContent).toContain('RAW/query/Legacy.ckpt')
    expect(dialog.textContent).toContain('RAW Candidate Name')
    expect(dialog.textContent).toContain(digest('b'))
    expect(dialog.textContent).toContain('RAW/path/Candidate.safetensors')
    expect(dialog.textContent).toContain('application/x-raw-media')
    expect(dialog.textContent).toContain('RAW/model-kind')
    mounted.dispose()
  })

  it('presents exact consent facts, availability, staged counts, and exact selected digests', () => {
    const retry = vi.fn()
    const blocked = { ...asset, digest: digest('c'), name: 'Private model', sources: [], fetchable: false, detail: 'No provider source.' }
    const mounted = mountConsent({ assets: [{ ...asset, size: 1_572_864, kind: 'model/checkpoint' }, blocked], busy: false, retry })
    const rows = mounted.root.querySelectorAll<HTMLElement>('[data-testid="asset-consent-row"]')
    const choices = mounted.root.querySelectorAll<HTMLButtonElement>('[data-testid="asset-consent-checkbox"]')

    expect(mounted.root.querySelector('[data-testid="asset-consent-dialog"]')?.getAttribute('aria-describedby')).toBe('asset-consent-intro')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain(digest('a'))
    expect(rows[0]!.textContent).toContain('Download from models.example')
    expect(rows[1]!.dataset['state']).toBe('unresolvable')
    expect(rows[1]!.textContent).toContain(digest('c'))
    expect(choices[0]!.getAttribute('aria-checked')).toBe('true')
    expect(choices[1]!.disabled).toBe(true)
    expect(mounted.root.querySelector('[data-testid="asset-consent-selection-status"]')?.textContent).toBe('1 of 1 available asset selected.')

    choices[0]!.click()
    expect(mounted.root.querySelector('[data-testid="asset-consent-selected-count"]')?.textContent).toBe('0')
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-acquire"]')!.disabled).toBe(true)
    choices[0]!.click()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-acquire"]')!.click()
    expect(retry).toHaveBeenCalledWith([digest('a')])
    mounted.dispose()
  })

  it('uses shared modal chrome and blocks incidental dismissal while acquisition is busy', () => {
    const mounted = mountConsent({ assets: [asset], busy: true, retry: vi.fn() })
    const dialog = mounted.root.querySelector<HTMLDialogElement>('[data-testid="asset-consent-dialog"]')!
    const close = mounted.root.querySelector<HTMLButtonElement>('[data-testid="modal-close"]')!

    expect(dialog.open).toBe(true)
    expect(dialog.dataset['modal']).toBe('asset-consent')
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(close.disabled).toBe(true)
    const cancel = new Event('cancel', { cancelable: true })
    expect(dialog.dispatchEvent(cancel)).toBe(false)
    expect(mounted.app.assetConsent.get()).toBeDefined()
    expect(mounted.root.querySelector('[data-testid="asset-consent-progress"]')?.textContent).toContain('does not cancel the retry')
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-cancel"]')!.click()
    expect(mounted.app.assetConsent.get()).toBeUndefined()
    mounted.dispose()
  })

  it('preserves a submitted subset when the consent request becomes busy', () => {
    const second = { ...asset, digest: digest('b'), name: 'Second model' }
    const mounted = mountConsent({ assets: [asset, second], busy: false, retry: vi.fn() })
    const choices = mounted.root.querySelectorAll<HTMLButtonElement>('[data-testid="asset-consent-checkbox"]')

    choices[1]!.click()
    expect(mounted.root.querySelector('[data-testid="asset-consent-selection-status"]')?.textContent).toBe('1 of 2 available assets selected.')
    const current = mounted.app.assetConsent.get()!
    mounted.app.assetConsent.set({ ...current, busy: true })

    expect(choices[0]!.getAttribute('aria-checked')).toBe('true')
    expect(choices[1]!.getAttribute('aria-checked')).toBe('false')
    expect(choices[0]!.disabled).toBe(true)
    expect(choices[1]!.disabled).toBe(true)
    expect(mounted.root.querySelector('[data-testid="asset-consent-selected-count"]')?.textContent).toBe('1')
    expect(mounted.root.querySelector('[data-testid="asset-consent-selection-status"]')?.textContent).toBe('Acquiring 1 selected asset and retrying the queued request.')
    mounted.dispose()
  })

  it('updates mounted consent chrome while preserving raw facts, selection, focus, and retry identity', () => {
    const retry = vi.fn()
    const assets = [
      { ...asset, name: 'RAW Asset Name', status: 'failed' as const, kind: 'RAW/model-kind', detail: 'RAW backend detail', sources: ['https://raw-host.example/model'] },
      { ...asset, digest: digest('b'), name: 'RAW Packaged Asset', packagedFrom: ['RAW Pack ID'] },
    ]
    const request = { assets, busy: false, retry }
    const mounted = mountConsent(request)
    const dialog = mounted.root.querySelector<HTMLDialogElement>('[data-testid="asset-consent-dialog"]')!
    const rows = [...mounted.root.querySelectorAll<HTMLElement>('[data-testid="asset-consent-row"]')]
    const choices = mounted.root.querySelectorAll<HTMLButtonElement>('[data-testid="asset-consent-checkbox"]')
    choices[1]!.click()
    choices[0]!.focus()

    setLocale('zh')

    expect(dialog.getAttribute('aria-label')).toBe('\u67e5\u770b\u5e76\u83b7\u53d6\u7f3a\u5931\u8d44\u4ea7')
    expect(dialog.textContent).toContain('\u83b7\u53d6\u7f3a\u5931\u8d44\u4ea7')
    expect(dialog.textContent).toContain('\u4ece raw-host.example \u4e0b\u8f7d')
    expect(dialog.textContent).toContain('\u968f\u5305 RAW Pack ID \u63d0\u4f9b')
    expect(mounted.root.querySelector('[data-testid="asset-consent-selection-status"]')?.textContent).toBe('\u5728 2 \u4e2a\u53ef\u7528\u8d44\u4ea7\u4e2d\u5df2\u9009\u62e9 1 \u4e2a\u3002')
    expect([...mounted.root.querySelectorAll('[data-testid="asset-consent-row"]')]).toEqual(rows)
    expect(document.activeElement).toBe(choices[0])
    expect(choices[0]!.getAttribute('aria-checked')).toBe('true')
    expect(choices[1]!.getAttribute('aria-checked')).toBe('false')
    expect(mounted.app.assetConsent.get()).toBe(request)
    for (const raw of ['RAW Asset Name', 'failed', 'RAW/model-kind', 'RAW backend detail', 'RAW Packaged Asset', 'RAW Pack ID', digest('a'), digest('b')]) {
      expect(dialog.textContent).toContain(raw)
    }

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-acquire"]')!.click()
    expect(retry).toHaveBeenCalledWith([digest('a')])
    mounted.dispose()
  })

  it('presents import reasons and exact candidate facts while staging choices', () => {
    const accept = vi.fn()
    const complete = candidate()
    const { virtualPath: _virtualPath, ...incomplete } = candidate({ digest: digest('d'), name: 'Incomplete model.ckpt', confidence: 'stem' })
    const mounted = mountResolution({
      matches: [{ query: 'legacy/Fixture model.ckpt', candidates: [complete, incomplete] }],
      reasons: { 'legacy/Fixture model.ckpt': 'weak-match' },
      accept,
      cancel: vi.fn(),
    })
    const row = mounted.root.querySelector<HTMLElement>('[data-testid="import-asset-row"]')!
    const radios = row.querySelectorAll<HTMLButtonElement>('[role="radio"]')

    expect(row.getAttribute('aria-describedby')).toBe('import-asset-reason-0')
    expect(row.textContent).toContain('Review weak match')
    expect(row.textContent).toContain(digest('b'))
    expect(row.textContent).toContain('models/checkpoints/Fixture model.safetensors')
    expect(row.textContent).toContain('application/x-safetensors')
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true')
    expect(radios[2]!.disabled).toBe(true)
    expect(mounted.root.querySelector('[data-testid="import-assets-selection-status"]')?.textContent).toBe('1 replacement selected; 0 names remain unresolved.')

    radios[0]!.click()
    expect(mounted.root.querySelector('[data-testid="import-assets-selection-status"]')?.textContent).toBe('0 replacements selected; 1 name remains unresolved.')
    radios[1]!.click()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="import-assets-accept"]')!.click()
    expect(accept).toHaveBeenCalledOnce()
    expect([...accept.mock.calls[0]![0].entries()]).toEqual([['legacy/Fixture model.ckpt', complete]])
    mounted.dispose()
  })

  it('routes import cancellation through shared close and footer actions', () => {
    const cancel = vi.fn()
    const mounted = mountResolution({ matches: [], reasons: {}, accept: vi.fn(), cancel })
    const dialog = mounted.root.querySelector<HTMLDialogElement>('[data-testid="import-asset-resolution-dialog"]')!

    expect(dialog.open).toBe(true)
    expect(dialog.dataset['modal']).toBe('import-asset-resolution')
    expect(dialog.getAttribute('aria-describedby')).toBe('import-asset-resolution-intro')
    expect(mounted.root.querySelector('.product-action-footer')).not.toBeNull()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="modal-close"]')!.click()
    expect(cancel).toHaveBeenCalledOnce()
    mounted.dispose()
  })
})
