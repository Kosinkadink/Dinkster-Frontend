// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale, type AssetRef } from '@dinkster/core'
import { CollectionPanel } from '../src/CollectionPanel.js'
import '../src/locale.js'
import {
  logicalModelAssetRefOf,
  logicalModelCollectionSource,
  logicalModelEntries,
  logicalModelEntrySelectable,
  logicalModelEntryVisible,
  logicalModelPickDetailOf,
} from '../src/asset-browser/logical-model-collection-source.js'
import { LogicalModelVariantFacts } from '../src/asset-browser/rail.js'
import type { LogicalModel, LogicalModelVariant } from '../src/asset-browser/logical-model.js'

const A = `blake3:${'a'.repeat(64)}`
const B = `blake3:${'b'.repeat(64)}`

const variant = (overrides: Partial<LogicalModelVariant> = {}): LogicalModelVariant => ({
  variantId: A,
  logicalId: 'fixture:model',
  size: 2048,
  digest: A,
  providers: [{ sourceId: 'fixture', sourceKind: 'provider', label: 'Fixture' }],
  availability: 'installed',
  compatibility: { status: 'unknown' },
  localRef: { digest: A, name: 'model.safetensors', size: 2048, mediaType: 'application/x-safetensors', virtualPath: 'models/model.safetensors' },
  conflicts: [],
  ...overrides,
})

const withoutLocalRef = (value: LogicalModelVariant): LogicalModelVariant => {
  const { localRef: _localRef, ...rest } = value
  return rest
}

const model = (variants: readonly LogicalModelVariant[], overrides: Partial<LogicalModel> = {}): LogicalModel => ({
  logicalId: 'fixture:model',
  displayName: 'Model',
  kind: 'model/checkpoint',
  aliases: ['model.safetensors', 'renamed.safetensors'],
  variants,
  ...overrides,
})

afterEach(() => {
  document.body.replaceChildren()
  setLocale('en')
  vi.restoreAllMocks()
})

async function mount(models: readonly LogicalModel[], multi = false) {
  const root = document.createElement('div')
  document.body.append(root)
  const source = logicalModelCollectionSource(() => models)
  const pick = vi.fn()
  const [selected, setSelected] = createSignal<readonly AssetRef[]>([])
  render(() => <CollectionPanel
    sources={[source]}
    variant="select"
    defaultMode="list"
    searchPriority="primary"
    searchLabel="Search models"
    searchPlaceholder="Search models"
    pick={{
      pickable: logicalModelEntrySelectable,
      visible: logicalModelEntryVisible,
      multi,
      selected: (entry) => {
        const ref = logicalModelAssetRefOf(entry)
        return ref !== undefined && selected().some((item) => item.digest === ref.digest)
      },
      onPick: (entry) => {
        const ref = logicalModelAssetRefOf(entry)
        const detail = logicalModelPickDetailOf(entry)
        pick(ref, detail)
        if (ref !== undefined) setSelected([ref])
      },
    }}
  />, root)
  await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-items"]')).not.toBeNull())
  return { root, pick }
}

describe('logical model CollectionPanel adapter', () => {
  it('uses a plain row for one variant and a group header only for multiple variants', () => {
    const entries = logicalModelEntries([
      model([variant()]),
      model([
        variant({ variantId: A }),
        variant({ variantId: B, digest: B, localRef: { digest: B, name: 'other.safetensors', size: 4096, mediaType: 'application/x-safetensors', virtualPath: 'models/other.safetensors' } }),
      ], { logicalId: 'fixture:other', displayName: 'Other model' }),
    ])

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ title: 'Model' })
    expect(entries[0]!.children).toBeUndefined()
    expect(entries[1]).toMatchObject({ title: 'Other model' })
    expect(entries[1]!.children).toHaveLength(2)
  })

  it('keeps same-id variants with different digests as distinct collection rows', () => {
    const entries = logicalModelEntries([model([
      variant({ variantId: 'fp16', digest: A }),
      variant({ variantId: 'fp16', digest: B, localRef: { digest: B, name: 'other.safetensors', size: 4096, mediaType: 'application/x-safetensors', virtualPath: 'models/other.safetensors' } }),
    ])])
    const children = entries[0]!.children!

    expect(children).toHaveLength(2)
    expect(new Set(children.map((entry) => entry.id)).size).toBe(2)
  })

  it('renders model variants through the shared list with compact row facts and multi-select semantics', async () => {
    const mounted = await mount([
      model([variant()]),
      model([
        variant({ variantId: A, localRef: { digest: A, name: 'left.safetensors', size: 2048, mediaType: 'application/x-safetensors', virtualPath: 'left.safetensors' } }),
        variant({ variantId: B, digest: B, localRef: { digest: B, name: 'right.safetensors', size: 4096, mediaType: 'application/x-safetensors', virtualPath: 'right.safetensors' } }),
      ], { logicalId: 'fixture:other', displayName: 'Other model', aliases: ['hidden-alias'] }),
    ], true)

    expect(mounted.root.querySelector('[data-testid="collection-panel"]')).not.toBeNull()
    expect(mounted.root.querySelector('[data-testid="collection-items"]')?.getAttribute('data-mode')).toBe('list')
    expect(mounted.root.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable')).toBe('true')
    expect(mounted.root.querySelectorAll('[data-testid="collection-group"]')).toHaveLength(1)
    expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(3)
    expect(mounted.root.textContent).toContain('Model')
    expect(mounted.root.textContent).toContain('Other model')
    expect(mounted.root.textContent).toContain('left.safetensors')
    expect(mounted.root.textContent).toContain('right.safetensors')
    expect(mounted.root.textContent).toContain('2.0 KiB')
    expect(mounted.root.textContent).toContain('installed')
    expect(mounted.root.textContent).not.toContain('hidden-alias')
    expect(mounted.root.textContent).not.toContain(A.slice(0, 15))
    expect(mounted.root.textContent).not.toContain('Fixture')
    expect(mounted.root.textContent).not.toContain('Choose variant')
  })

  it('filters shared rows by model name, alias, or variant file name', async () => {
    const mounted = await mount([
      model([variant()]),
      model([variant({ variantId: B, digest: B, localRef: { digest: B, name: 'other.safetensors', size: 2048, mediaType: 'application/x-safetensors', virtualPath: 'other.safetensors' } })], {
        logicalId: 'fixture:other', displayName: 'Other', aliases: [],
      }),
    ])
    const search = mounted.root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')!
    expect(search.placeholder).toBe('Search models')
    expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2)

    search.value = 'renamed'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(1))
    expect(mounted.root.textContent).toContain('Model')
    expect(mounted.root.textContent).not.toContain('Other')

    search.value = 'other.safetensors'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(mounted.root.textContent).toContain('Other'))
    expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(1)
  })

  it('stages installed rows with the shared selected ring and keeps informational rows selectable', async () => {
    const downloadable = withoutLocalRef(variant({ availability: 'downloadable' }))
    const mounted = await mount([model([variant()]), model([downloadable], { logicalId: 'fixture:remote', displayName: 'Remote' })], true)
    const installed = [...mounted.root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')]
      .find((entry) => entry.textContent?.includes('Model'))!
    const remote = [...mounted.root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')]
      .find((entry) => entry.textContent?.includes('Remote'))!

    remote.click()
    expect(remote.hasAttribute('aria-disabled')).toBe(false)
    expect(mounted.pick).toHaveBeenCalledWith(undefined, expect.objectContaining({ modelName: 'Remote' }))
    expect(remote.classList.contains('selected')).toBe(false)
    installed.click()
    expect(mounted.pick).toHaveBeenCalledWith(variant().localRef, expect.objectContaining({ modelName: 'Model' }))
    expect(installed.classList.contains('selected')).toBe(true)
    expect(installed.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps aliases, variant facts, providers, warnings, and download actions in the selection details', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const detailVariant = withoutLocalRef(variant({
      precision: 'fp16',
      format: 'safetensors',
      compatibility: { status: 'incompatible', reason: 'Requires a newer runtime' },
      conflicts: [{ code: 'basename-digest-conflict', basename: 'model.safetensors', otherVariantId: B }],
      availability: 'downloadable',
    }))
    render(() => <LogicalModelVariantFacts
      detail={{ modelName: 'Model', aliases: ['renamed.safetensors'], variant: detailVariant }}
      acquisitionSupported={false}
    />, root)

    const text = root.textContent!
    expect(text).toContain('renamed.safetensors')
    expect(text).toContain(`${A.slice(0, 12)}...${A.slice(-8)}`)
    expect(root.querySelector('.logical-model-digest code')?.getAttribute('title')).toBe(A)
    expect(root.querySelector('.logical-model-digest [aria-label="Copy digest"]')).not.toBeNull()
    expect(text).toContain('fp16')
    expect(text).toContain('safetensors')
    expect(text).toContain('Fixture')
    expect(text).toContain('incompatible')
    expect(text).toContain('Name conflict')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="logical-model-download"]')!.disabled).toBe(true)
  })

  it('updates an open variant disclosure while model and provider data stay raw', () => {
    registerCatalog('de-DE', {
      'assets.details.forVariant': '[Details fur {model} Variante {variant}]',
      'assets.details.title': '[Details DE]',
      'assets.digest.copy': '[Kopieren]',
      'assets.digest.copyLabel': '[Digest kopieren]',
      'assets.fact.digest': '[Digest DE]',
      'assets.logicalModel.aliases': '[Aliase]',
      'assets.logicalModel.availability': '[Verfugbarkeit]',
      'assets.logicalModel.download': '[Herunterladen]',
      'assets.logicalModel.downloadUnavailable': '[Download nicht verfugbar]',
      'assets.logicalModel.downloadUnsupported': '[Kein Downloadvertrag.]',
      'assets.logicalModel.format': '[Format DE]',
      'assets.logicalModel.incompatible': '[inkompatibel]',
      'assets.logicalModel.model': '[Modell]',
      'assets.logicalModel.nameConflict': '[Namenskonflikt.]',
      'assets.logicalModel.precision': '[Prazision]',
      'assets.logicalModel.providers': '[Anbieter]',
      'assets.logicalModel.variant': '[Variante]',
    })
    const root = document.createElement('div')
    document.body.append(root)
    const detailVariant = withoutLocalRef(variant({
      variantId: 'RAW-variant',
      precision: 'RAW-fp16',
      format: 'RAW-format',
      compatibility: { status: 'incompatible', reason: 'RAW runtime reason' },
      conflicts: [{ code: 'basename-digest-conflict', basename: 'RAW.safetensors', otherVariantId: B }],
      availability: 'downloadable',
    }))
    render(() => <LogicalModelVariantFacts
      detail={{ modelName: 'RAW Model', aliases: ['RAW alias'], variant: detailVariant }}
      acquisitionSupported={false}
    />, root)
    const details = root.querySelector<HTMLDetailsElement>('[data-testid="logical-model-variant-details"]')!
    details.querySelector('summary')!.click()

    setLocale('de-DE')

    expect(details.open).toBe(true)
    expect(details.querySelector('summary')?.textContent).toBe('[Details DE]')
    expect(details.querySelector('summary')?.getAttribute('aria-label')).toBe('[Details fur RAW Model Variante RAW-variant]')
    expect(details.querySelector('.logical-model-providers')?.getAttribute('aria-label')).toBe('[Anbieter]')
    expect(details.textContent).toContain('[Modell]RAW Model')
    expect(details.textContent).toContain('[Variante]RAW-variant')
    expect(details.textContent).toContain('[Prazision]RAW-fp16')
    expect(details.textContent).toContain('[Format DE]RAW-format')
    expect(details.textContent).toContain('Fixture')
    expect(details.textContent).toContain('RAW alias')
    expect(details.textContent).toContain('[inkompatibel]: RAW runtime reason')
    expect(details.textContent).toContain('[Namenskonflikt.]')
    expect(details.textContent).toContain('[Download nicht verfugbar]')
    expect(details.querySelector<HTMLButtonElement>('[data-testid="logical-model-download"]')?.textContent).toBe('[Herunterladen]')
  })
})
