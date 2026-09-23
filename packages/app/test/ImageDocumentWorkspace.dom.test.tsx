// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb'
import {
  IMAGE_DOCUMENT_MEDIA_TYPE,
  type DinksterConnection,
  type LibraryRecord,
} from '@dinkster/client'
import {
  COLLAB_PROTOCOL_VERSION,
  IMAGE_OPACITY_MAX,
  registerCatalog,
  setLocale,
  type CollabClientOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
  type CollabSessionDescriptor,
  type FetchOpsOutcome,
  type PostOpOutcome,
  type PutSnapshotOutcome,
} from '@dinkster/core'
import type { AppState } from '../src/app-state.js'
import type { CollabTransport } from '../src/collab.js'
import {
  ImageDocumentWorkspace,
  type ImageWorkspaceTab,
} from '../src/ImageDocumentWorkspace.js'
import {
  ImageDocumentLocalStore,
  imageDocumentDigest,
  importSingleRaster,
} from '../src/image-document-local.js'
import { activeProjectId } from '../src/projects.js'

const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 128, 255, 255])

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setLocale('en')
})

describe('ImageDocumentWorkspace', () => {
  it('updates open workspace chrome without reopening data or translating document values', async () => {
    registerCatalog('de-DE', {
      'imageDocument.workspace.action.close': '[Bibliothek schliessen]',
      'imageDocument.workspace.action.openLibrary': '[Bildbibliothek offnen]',
      'imageDocument.workspace.action.sharedImages':
        '[Geteilte Bilder anzeigen]',
      'imageDocument.workspace.dialog.library.ariaLabel':
        '[Bilddokument offnen]',
      'imageDocument.workspace.dialog.library.revision':
        '[Revision {revision}]',
      'imageDocument.workspace.dialog.library.title': '[Bildbibliothek]',
      'imageDocument.workspace.error.sharingRequiresBackend':
        '[Freigabe braucht ein verbundenes Dinkster-Backend.]',
    })
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'RAW source.png', { type: 'image/png' }),
      seedStore,
      {
        lineage: 'RAW-lineage',
        normalize: async () => ({ width: 2, height: 1, rgba }),
      },
    )
    await seedStore.close()
    const listLibrary = vi.fn(async () => ({
      records: [
        {
          id: 'RAW-record-id',
          scope: 'local',
          name: 'RAW library document',
          digest: 'blake3:' + '1'.repeat(64),
          mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
          labels: ['image-document'],
          created: 1,
          modified: 1,
          revision: 7,
        },
      ],
      cursor: undefined,
    }))
    const app = {
      libraryBackend: () => ({
        id: 'RAW-backend',
        connection: { listLibrary },
      }),
      collabBackend: () => undefined,
      backends: { get: () => [] },
      showTransientStatus: vi.fn(),
    } as unknown as AppState
    let tabs: readonly ImageWorkspaceTab[] = []
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(
      () => (
        <ImageDocumentWorkspace
          active
          app={app}
          onBusyChange={() => undefined}
          onClose={() => undefined}
          onTabsChange={(next) => {
            tabs = next
          }}
        />
      ),
      root,
    )

    await vi.waitFor(() => expect(root.textContent).toContain('RAW source'))
    const openLibrary = [
      ...root.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Open library')!
    openLibrary.click()
    await vi.waitFor(() =>
      expect(
        root.querySelector('[role="dialog"][aria-label="Open image document"]'),
      ).not.toBeNull(),
    )
    root
      .querySelector<HTMLButtonElement>('[data-testid="image-collab-browse"]')!
      .click()
    expect(
      root.querySelector('.image-document-error[role="alert"]')?.textContent,
    ).toBe('Sharing requires a connected native Dinkster backend.')
    const requestsBeforeLocale = listLibrary.mock.calls.length

    setLocale('de-DE')

    expect(openLibrary.textContent).toBe('[Bildbibliothek offnen]')
    expect(
      root.querySelector('[data-testid="image-collab-browse"]')?.textContent,
    ).toBe('[Geteilte Bilder anzeigen]')
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('[Bilddokument offnen]')
    expect(dialog.querySelector('strong')?.textContent).toBe('[Bildbibliothek]')
    expect(
      [...dialog.querySelectorAll('button')].some(
        (button) => button.textContent === '[Bibliothek schliessen]',
      ),
    ).toBe(true)
    expect(dialog.textContent).toContain('RAW library document')
    expect(dialog.textContent).toContain('[Revision 7]')
    expect(tabs.map((tab) => tab.title)).toEqual(['RAW source'])
    expect(
      root.querySelector('.image-document-error[role="alert"]')?.textContent,
    ).toBe('[Freigabe braucht ein verbundenes Dinkster-Backend.]')
    expect(listLibrary).toHaveBeenCalledTimes(requestsBeforeLocale)
    expect(root.querySelector('[role="dialog"]')).not.toBeNull()
    dispose()
  })

  it.each([10, undefined])(
    'refuses invalid numeric commits without saving or adding history (z=%s)',
    async (z) => {
      vi.stubGlobal('indexedDB', new FakeIDBFactory())
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      const store = new ImageDocumentLocalStore(activeProjectId())
      const seed = await importSingleRaster(
        new File([new Uint8Array([1])], 'Numeric source.png', {
          type: 'image/png',
        }),
        store,
        {
          lineage: 'image-workspace-numeric-test',
          normalize: async () => ({ width: 2, height: 1, rgba }),
        },
      )
      const seeded = await store.saveDraft(
        {
          ...seed.document,
          layers: {
            ...seed.document.layers,
            l1: {
              ...seed.document.layers['l1']!,
              ...(z === undefined ? {} : { z_index: z }),
            },
          },
        },
        'Numeric source',
      )
      const app = {
        libraryBackend: () => undefined,
        showTransientStatus: vi.fn(),
      } as unknown as AppState
      const root = document.createElement('div')
      document.body.append(root)
      const dispose = render(
        () => (
          <ImageDocumentWorkspace
            active
            app={app}
            onBusyChange={() => undefined}
            onClose={() => undefined}
          />
        ),
        root,
      )
      try {
        await vi.waitFor(() =>
          expect(
            root.querySelector('[aria-label="Layer z order"]'),
          ).not.toBeNull(),
        )
        const alert = () =>
          root.querySelector('.image-document-error[role="alert"]')
        for (const [label, original] of [
          ['Layer z order', String(z ?? 0)],
          ['Canvas width', '2'],
          ['Canvas height', '1'],
        ] as const) {
          const field = root.querySelector<HTMLInputElement>(
            `[aria-label="${label}"]`,
          )!
          const fill = (value: string): void => {
            field.value = value
            field.dispatchEvent(new Event('input', { bubbles: true }))
          }
          const key = (value: string): void => {
            field.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: value,
                bubbles: true,
                cancelable: true,
              }),
            )
          }
          expect(field.value).toBe(original)
          for (const invalid of [
            '',
            '   ',
            'bad',
            '1.5',
            'Infinity',
            '9007199254740992',
          ]) {
            fill(invalid)
            field.dispatchEvent(new Event('blur', { bubbles: true }))
            expect(field.value).toBe(invalid)
            expect(alert()?.textContent).toContain('Enter a whole number')
            expect(
              (await store.recoverDraft(seed.document.lineage))!.document,
            ).toEqual(seeded.document)
          }
          fill(original)
          key('Enter')
          expect(alert()).toBeNull()
          fill('')
          key('Enter')
          expect(alert()).not.toBeNull()
          key('Escape')
          expect(field.value).toBe(original)
          expect(alert()).toBeNull()
          if (label !== 'Layer z order') {
            fill('0')
            key('Enter')
            expect(alert()).not.toBeNull()
            fill(original)
            key('Enter')
            expect(alert()).toBeNull()
          }
        }
        const recovered = (await store.recoverDraft(seed.document.lineage))!
        expect(recovered.document).toEqual(seeded.document)
        expect(recovered.updatedAt).toBe(seeded.updatedAt)
        expect(
          [...root.querySelectorAll('button')].find(
            (button) => button.textContent === 'Undo',
          )!.disabled,
        ).toBe(true)
      } finally {
        dispose()
        await store.close()
      }
    },
  )

  it('recovers a draft and persists command edits with undo', async () => {
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'Workspace source.png', {
        type: 'image/png',
      }),
      seedStore,
      {
        lineage: 'image-workspace-component-test',
        normalize: async () => ({ width: 2, height: 1, rgba }),
      },
    )
    await seedStore.close()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const app = {
      libraryBackend: () => undefined,
      showTransientStatus: vi.fn(),
    } as unknown as AppState
    let tabs: readonly ImageWorkspaceTab[] = []
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(
      () => (
        <ImageDocumentWorkspace
          active
          app={app}
          onBusyChange={() => undefined}
          onClose={() => undefined}
          onTabsChange={(next) => {
            tabs = next
          }}
        />
      ),
      root,
    )

    await vi.waitFor(() =>
      expect(root.textContent).toContain('Workspace source'),
    )
    expect(
      root.querySelector('[data-testid="image-document-editor"]'),
    ).not.toBeNull()
    expect(root.textContent).toContain('Layers')
    expect(root.textContent).toContain('Transform')
    expect(root.textContent).toContain('Masks')
    const outputQuality = root.querySelector<HTMLInputElement>(
      '[aria-label="Output quality"]',
    )!
    expect(outputQuality.disabled).toBe(true)
    root
      .querySelector<HTMLButtonElement>('[aria-label="Output format"]')!
      .click()
    document
      .querySelector<HTMLElement>('[role="option"][data-option-id="webp"]')!
      .click()
    expect(outputQuality.disabled).toBe(false)
    const name = root.querySelector<HTMLInputElement>(
      'input[aria-label="Image document name"]',
    )!
    name.value = 'Renamed document'
    name.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(tabs[0]?.title).toBe('Renamed document'))
    const opacity = root.querySelector<HTMLElement>(
      '[role="slider"][aria-label="Layer opacity"]',
    )!
    opacity.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    )

    const verify = new ImageDocumentLocalStore(activeProjectId())
    await vi.waitFor(async () => {
      const draft = await verify.recoverDraft(seed.document.lineage)
      expect(draft!.document.layers['l1']!.opacity).toBe(0)
    })
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    await vi.waitFor(async () => {
      const draft = await verify.recoverDraft(seed.document.lineage)
      expect(draft!.document.layers['l1']!.opacity).toBe(IMAGE_OPACITY_MAX)
    })
    const remove = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Remove',
    )!
    remove.click()
    await vi.waitFor(() =>
      expect(root.textContent).toContain(
        'Select a layer to edit its properties.',
      ),
    )
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    await vi.waitFor(() =>
      expect(root.textContent).toContain('Workspace source'),
    )
    expect(consoleError).not.toHaveBeenCalled()

    dispose()
    await verify.close()
  })

  it('serializes edits made during publication behind the confirmed library link', async () => {
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'Publish source.png', {
        type: 'image/png',
      }),
      seedStore,
      {
        lineage: 'image-workspace-publish-test',
        normalize: async () => ({ width: 2, height: 1, rgba }),
      },
    )
    const resource = Object.values(seed.document.resources)[0]!
    const staged = (await seedStore.getResource(resource.digest))!
    await seedStore.close()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    let releaseAdoption!: () => void
    const adoptionGate = new Promise<void>((resolve) => {
      releaseAdoption = resolve
    })
    const dependencies = [
      {
        resourceId: resource.id,
        digest: resource.digest,
        byteSize: resource.byteSize,
        mediaType: resource.mediaType,
        width: resource.width,
        height: resource.height,
        colorSpace: resource.colorSpace,
        channelDepth: resource.channelDepth,
        alphaMode: resource.alphaMode,
      },
    ]
    const createLibraryRecord = vi.fn(
      async (request: {
        readonly digest: string
        readonly name: string
        readonly scope: string
      }): Promise<LibraryRecord> => ({
        id: 'published-image',
        scope: request.scope,
        name: request.name,
        digest: request.digest,
        mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
        labels: ['image-document'],
        created: 1,
        modified: 1,
        revision: 1,
      }),
    )
    const connection = {
      uploadMediaAsset: vi.fn(async () => ({
        digest: resource.digest,
        name: staged.name,
        size: staged.bytes.byteLength,
        mediaType: staged.mediaType,
        virtualPath: `input/${staged.name}`,
      })),
      adoptImageDocument: vi.fn(async (bytes: Uint8Array) => {
        await adoptionGate
        return {
          digest: imageDocumentDigest(bytes),
          mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
          byteSize: bytes.byteLength,
          dependencies,
        }
      }),
      createLibraryRecord,
    } as unknown as DinksterConnection
    const app = {
      libraryBackend: () => ({ id: 'backend-a', connection }),
      showTransientStatus: vi.fn(),
    } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const busy = vi.fn()
    const dispose = render(
      () => (
        <ImageDocumentWorkspace
          active
          app={app}
          onBusyChange={busy}
          onClose={() => undefined}
        />
      ),
      root,
    )

    await vi.waitFor(() => expect(root.textContent).toContain('Publish source'))
    const publish = [
      ...root.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Publish')!
    publish.click()
    await vi.waitFor(() =>
      expect(connection.adoptImageDocument).toHaveBeenCalledOnce(),
    )
    expect(busy).toHaveBeenLastCalledWith(true)
    root
      .querySelector<HTMLElement>(
        '[role="slider"][aria-label="Layer opacity"]',
      )!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      )
    releaseAdoption()

    const verify = new ImageDocumentLocalStore(activeProjectId())
    await vi.waitFor(async () => {
      const draft = await verify.recoverDraft(seed.document.lineage)
      expect(draft?.library?.recordId).toBe('published-image')
      expect(draft?.document.layers['l1']?.opacity).toBe(0)
    })
    expect(createLibraryRecord).toHaveBeenCalledOnce()
    expect(root.textContent).not.toContain('Draft recovery save failed')
    expect(busy).toHaveBeenLastCalledWith(false)
    dispose()
    await verify.close()
  })

  it('keeps editor state and raw render values while mounted chrome changes locale', async () => {
    registerCatalog('de-DE', {
      'imageDocument.editor.action.downloadPng': '[PNG herunterladen]',
      'imageDocument.editor.action.render': '[Referenz rendern]',
      'imageDocument.editor.action.saveDraft': '[Entwurf speichern]',
      'imageDocument.editor.aria.canvas.height': '[Leinwand HOHE]',
      'imageDocument.editor.aria.canvas.width': '[Leinwand BREITE]',
      'imageDocument.editor.aria.crop.height': '[Zuschnitt HOHE]',
      'imageDocument.editor.aria.crop.width': '[Zuschnitt BREITE]',
      'imageDocument.editor.aria.crop.x': '[Zuschnitt X]',
      'imageDocument.editor.aria.crop.y': '[Zuschnitt Y]',
      'imageDocument.editor.aria.layerOpacity': '[Ebenendeckkraft]',
      'imageDocument.editor.aria.renderTarget': '[Referenz-Renderziel]',
      'imageDocument.editor.aria.resize.height': '[Grosse HOHE]',
      'imageDocument.editor.aria.resize.width': '[Grosse BREITE]',
      'imageDocument.editor.field.opacity': '[Deckkraft]',
      'imageDocument.editor.provenance.outputDigest': '[Ausgabeprufsumme]',
      'imageDocument.editor.provenance.profile': '[Profil]',
      'imageDocument.editor.status.freshRender': '[Frische Ausgabe]',
      'imageDocument.editor.target.layer': '[Ebene: {name}]',
      'imageDocument.editor.title.authoritative': '[Verbindliche CPU-Ausgabe]',
      'imageDocument.editor.title.layers': '[Ebenen]',
    })
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'Render source.png', {
        type: 'image/png',
      }),
      seedStore,
      {
        lineage: 'image-workspace-render-test',
        normalize: async () => ({ width: 2, height: 1, rgba }),
      },
    )
    const resource = Object.values(seed.document.resources)[0]!
    const staged = (await seedStore.getResource(resource.digest))!
    await seedStore.close()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const dependencies = [
      {
        resourceId: resource.id,
        digest: resource.digest,
        byteSize: resource.byteSize,
        mediaType: resource.mediaType,
        width: resource.width,
        height: resource.height,
        colorSpace: resource.colorSpace,
        channelDepth: resource.channelDepth,
        alphaMode: resource.alphaMode,
      },
    ]
    const outputDigest = imageDocumentDigest(staged.bytes)
    const createLibraryRecord = vi.fn()
    let renderCount = 0
    const renderImageDocument = vi.fn(
      async (digest: string, options: { selector?: string }) => {
        renderCount += 1
        return {
          cacheKey: 'blake3:' + 'e'.repeat(64),
          cached: renderCount > 1,
          asset: {
            digest: outputDigest,
            name: 'image-document-render.png',
            size: staged.bytes.byteLength,
            mediaType: 'image/png' as const,
            virtualPath: '',
          },
          provenance: {
            documentDigest: digest,
            selector: options.selector ?? 'composite',
            profile: 'dinkster-image-document-v2-cpu-reference' as const,
            rendererContract: '2;pillow=12.1.1;jpeg=9.0;webp=1.6.0',
            encoding: 'image/png;dinkster-canonical=1' as const,
            source: {
              digest,
              mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
              dependencies,
            },
            output: {
              digest: outputDigest,
              byteSize: staged.bytes.byteLength,
              mediaType: 'image/png' as const,
              width: 2,
              height: 1,
              encoding: 'image/png;dinkster-canonical=1' as const,
            },
          },
        }
      },
    )
    const uploadMediaAsset = vi.fn(async () => ({
      digest: resource.digest,
      name: staged.name,
      size: staged.bytes.byteLength,
      mediaType: staged.mediaType,
      virtualPath: `input/${staged.name}`,
    }))
    const adoptImageDocument = vi.fn(async (bytes: Uint8Array) => ({
      digest: imageDocumentDigest(bytes),
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      byteSize: bytes.byteLength,
      dependencies,
    }))
    const fetchAssetBytes = vi.fn(
      async () => Uint8Array.from(staged.bytes).buffer,
    )
    const connection = {
      uploadMediaAsset,
      adoptImageDocument,
      renderImageDocument,
      fetchAssetBytes,
      assetUrl: vi.fn((digest: string) => `http://assets.test/${digest}`),
      createLibraryRecord,
    } as unknown as DinksterConnection
    const app = {
      libraryBackend: () => ({ id: 'backend-render', connection }),
      showTransientStatus: vi.fn(),
    } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(
      () => (
        <ImageDocumentWorkspace
          active
          app={app}
          onBusyChange={() => undefined}
          onClose={() => undefined}
        />
      ),
      root,
    )

    await vi.waitFor(() => expect(root.textContent).toContain('Render source'))
    root
      .querySelector<HTMLButtonElement>(
        '[role="combobox"][aria-label="Authoritative render target"]',
      )!
      .click()
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[role="option"]')].some(
          (option) => option.textContent === 'Layer: Render source',
        ),
      ).toBe(true),
    )
    const layerOption = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === 'Layer: Render source')!
    layerOption.click()
    const renderButton = [
      ...root.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Render')!
    renderButton.click()
    await vi.waitFor(() =>
      expect(
        root.querySelector(
          '[data-testid="authoritative-image-document-render"]',
        ),
      ).not.toBeNull(),
    )
    expect(connection.uploadMediaAsset).toHaveBeenCalledOnce()
    expect(connection.adoptImageDocument).toHaveBeenCalledOnce()
    expect(renderImageDocument).toHaveBeenCalledWith(
      expect.stringMatching(/^blake3:/),
      {
        scope: 'local',
        selector: 'layer:l1',
      },
    )
    expect(createLibraryRecord).not.toHaveBeenCalled()
    expect(root.textContent).toContain('Fresh render')
    expect(root.textContent).toContain(
      'dinkster-image-document-v2-cpu-reference',
    )
    expect(
      root.querySelector<HTMLImageElement>(
        'img[alt="Authoritative ImageDocument output"]',
      )?.src,
    ).toBe(`http://assets.test/${outputDigest}`)

    const editor = root.querySelector('[data-testid="image-document-editor"]')
    const selectedRow = root.querySelector(
      '.image-document-layer-row[aria-pressed="true"]',
    )
    const callsBeforeLocale = {
      adopt: adoptImageDocument.mock.calls.length,
      fetch: fetchAssetBytes.mock.calls.length,
      render: renderImageDocument.mock.calls.length,
      upload: uploadMediaAsset.mock.calls.length,
    }
    setLocale('de-DE')

    await vi.waitFor(() => expect(root.textContent).toContain('[Ebenen]'))
    expect(root.querySelector('[data-testid="image-document-editor"]')).toBe(
      editor,
    )
    expect(
      root.querySelector('.image-document-layer-row[aria-pressed="true"]'),
    ).toBe(selectedRow)
    expect(root.textContent).toContain('[Verbindliche CPU-Ausgabe]')
    expect(root.textContent).toContain('[Frische Ausgabe]')
    expect(root.textContent).toContain('[Ausgabeprufsumme]')
    expect(root.textContent).toContain('Render source')
    expect(root.textContent).toContain(outputDigest)
    expect(root.textContent).toContain(
      'dinkster-image-document-v2-cpu-reference',
    )
    expect(root.querySelector('[role="combobox"]')?.textContent).toContain(
      '[Ebene: Render source]',
    )
    for (const ariaLabel of [
      '[Leinwand HOHE]',
      '[Leinwand BREITE]',
      '[Zuschnitt HOHE]',
      '[Zuschnitt BREITE]',
      '[Zuschnitt X]',
      '[Zuschnitt Y]',
      '[Grosse HOHE]',
      '[Grosse BREITE]',
    ]) {
      expect(root.querySelector(`[aria-label="${ariaLabel}"]`)).not.toBeNull()
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(adoptImageDocument).toHaveBeenCalledTimes(callsBeforeLocale.adopt)
    expect(fetchAssetBytes).toHaveBeenCalledTimes(callsBeforeLocale.fetch)
    expect(renderImageDocument).toHaveBeenCalledTimes(callsBeforeLocale.render)
    expect(uploadMediaAsset).toHaveBeenCalledTimes(callsBeforeLocale.upload)

    root
      .querySelector<HTMLElement>(
        '[role="slider"][aria-label="[Ebenendeckkraft]"]',
      )!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      )
    await vi.waitFor(() =>
      expect(root.textContent).toContain('Stale - render again'),
    )
    const localizedRender = [
      ...root.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === '[Referenz rendern]')!
    localizedRender.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Cache hit'))
    dispose()
  })

  it('uploads resources before sharing and persists membership until leave', async () => {
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'Shared source.png', {
        type: 'image/png',
      }),
      seedStore,
      {
        lineage: 'image-workspace-shared-test',
        normalize: async () => ({ width: 2, height: 1, rgba }),
      },
    )
    const resource = Object.values(seed.document.resources)[0]!
    await seedStore.close()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const descriptor: CollabSessionDescriptor = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: 'shared-image-session',
      scope: 'shared',
      documentId: seed.document.lineage,
      documentKind: 'image',
      revision: 0,
      snapshotRevision: 0,
    }
    const order: string[] = []
    let revision = 0
    let listener: ((event: CollabConnectionEvent) => void) | undefined
    const connection: CollabConnection = {
      sessionId: descriptor.sessionId,
      postOp: async (operation: CollabClientOp): Promise<PostOpOutcome> => {
        revision += 1
        const accepted: CollabServerOp = {
          opId: operation.opId,
          actorId: operation.actorId,
          baseRevision: operation.baseRevision,
          revision,
          patch: operation.patch,
          timestamp: revision,
        }
        listener?.({ kind: 'op', op: accepted })
        return { kind: 'accepted', op: accepted }
      },
      fetchOps: async (): Promise<FetchOpsOutcome> => ({
        kind: 'ops',
        ops: [],
      }),
      fetchSnapshot: async () => ({ revision: 0, document: seed.document }),
      putSnapshot: async (): Promise<PutSnapshotOutcome> => ({ kind: 'ok' }),
      sendPresence: () => undefined,
      onEvent: (next) => {
        listener = next
        next({ kind: 'connected', descriptor })
        return () => {
          listener = undefined
        }
      },
      close: () => undefined,
    }
    const end = vi.fn(async () => undefined)
    const transport: CollabTransport = {
      create: async (_baseUrl, request) => {
        order.push(`create:${request.documentKind}`)
        return descriptor
      },
      list: async () => [descriptor],
      get: async () => descriptor,
      end,
      connect: () => connection,
    }
    const backendConnection = {
      uploadMediaAsset: vi.fn(async () => {
        order.push('upload')
        return {
          digest: resource.digest,
          name: 'source.png',
          size: resource.byteSize,
          mediaType: resource.mediaType,
          virtualPath: 'input/source.png',
        }
      }),
      fetchAssetBytes: vi.fn(),
    } as unknown as DinksterConnection
    const backend = {
      id: 'backend-shared',
      protocol: 'dinkster',
      baseUrl: 'http://127.0.0.1:8765',
      connection: backendConnection,
    }
    const app = {
      libraryBackend: () => undefined,
      collabBackend: () => backend,
      backends: { get: () => [backend] },
      collabTransport: transport,
      collabActorId: 'alice',
      showTransientStatus: vi.fn(),
    } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(
      () => (
        <ImageDocumentWorkspace
          active
          app={app}
          onBusyChange={() => undefined}
          onClose={() => undefined}
        />
      ),
      root,
    )

    await vi.waitFor(() => expect(root.textContent).toContain('Shared source'))
    root
      .querySelector<HTMLButtonElement>('[data-testid="image-collab-share"]')!
      .click()
    await vi.waitFor(() =>
      expect(
        root.querySelector('.image-document-shared-status')?.textContent,
      ).toBe('Shared'),
    )
    expect(order).toEqual(['upload', 'create:image'])
    const verify = new ImageDocumentLocalStore(activeProjectId())
    await vi.waitFor(async () => {
      expect(
        (await verify.recoverDraft(seed.document.lineage))?.collaboration
          ?.sessionId,
      ).toBe(descriptor.sessionId)
    })

    root
      .querySelector<HTMLElement>(
        '[role="slider"][aria-label="Layer opacity"]',
      )!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      )
    await vi.waitFor(() => expect(revision).toBe(1))
    root
      .querySelector<HTMLButtonElement>('[data-testid="image-collab-end"]')!
      .click()
    expect(
      root.querySelector('[data-testid="image-collab-end-confirm"]'),
    ).not.toBeNull()
    expect(end).not.toHaveBeenCalled()
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="image-collab-end-cancel"]',
      )!
      .click()
    expect(
      root.querySelector('[data-testid="image-collab-end-confirm"]'),
    ).toBeNull()
    root
      .querySelector<HTMLButtonElement>('[data-testid="image-collab-leave"]')!
      .click()
    await vi.waitFor(() =>
      expect(
        root.querySelector('[data-testid="image-collab-share"]'),
      ).not.toBeNull(),
    )
    await vi.waitFor(async () => {
      expect(
        (await verify.recoverDraft(seed.document.lineage))?.collaboration,
      ).toBeUndefined()
    })

    dispose()
    await verify.close()
  })
})
