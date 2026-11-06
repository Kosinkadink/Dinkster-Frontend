// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb'
import { DinksterValuesClient, IMAGE_DOCUMENT_MEDIA_TYPE, type DinksterConnection, type LibraryRecord, type RetainedAssetOwner, type RetainedAssetDeclaration } from '@dinkster/client'
import {
  COLLAB_PROTOCOL_VERSION,
  IMAGE_OPACITY_MAX,
  registerCatalog,
  setLocale,
  serializeImageDocument,
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
import { ImageDocumentWorkspace } from '../src/ImageDocumentWorkspace.js'
import { ImageDocumentLocalStore, imageDocumentDigest, importSingleRaster } from '../src/image-document-local.js'
import { activeProjectId, initializeProjectScope } from '../src/projects.js'
import { RetainedAssetReader } from '../src/workflow-asset-retention.js'
import type { GraphImageDocumentRequest } from '../src/image-document-graph.js'

const rgba = new Uint8ClampedArray([
  255, 0, 0, 255,
  0, 128, 255, 255,
])

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setLocale('en')
  initializeProjectScope('default')
})

describe('ImageDocumentWorkspace', () => {
  it.each(['accepted', 'failed', 'project', 'project-failed', 'dispose', 'dispose-failed', 'overlap', 'overlap-dispose'])(
    'settles a local image decode without stale writes or publication (%s)', async (outcome) => {
      vi.stubGlobal('indexedDB', new FakeIDBFactory())
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      vi.stubGlobal('OffscreenCanvas', class {
        getContext() { return { drawImage: () => undefined, getImageData: () => ({ data: rgba }) } }
      })
      let finish!: () => void
      let fail!: (error: Error) => void
      const decoding = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
      let entered = false
      let released = false
      vi.stubGlobal('createImageBitmap', async (file: File) => {
        if (file.name === 'first.png') { entered = true; await decoding }
        return { width: 2, height: 1, close: () => { released = true } }
      })
      const inspect = new ImageDocumentLocalStore(activeProjectId())
      const app = { libraryBackend: () => undefined, showTransientStatus: vi.fn() } as unknown as AppState
      const root = document.createElement('div')
      document.body.append(root)
      let busy = false
      const dispose = render(() => <ImageDocumentWorkspace active app={app}
        onBusyChange={(value) => { busy = value }} onClose={() => undefined} />, root)
      await vi.waitFor(() => expect(root.textContent).toContain('No image documents are open'))
      const input = root.querySelector<HTMLInputElement>('input[type="file"]')!
      const choose = (name: string): void => {
        Object.defineProperty(input, 'files', { configurable: true, value: [new File(['source'], name, { type: 'image/png' })] })
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      choose('first.png')
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(busy).toBe(true)
      if (outcome.startsWith('overlap')) {
        choose('second.png')
        await vi.waitFor(() => expect(root.querySelector('[role="tab"]')?.textContent).toBe('second'))
        expect(busy).toBe(true)
      }
      if (outcome.startsWith('project')) initializeProjectScope('other-project')
      if (outcome.includes('dispose')) dispose()
      if (outcome.includes('failed')) fail(new Error('Raster decode failed'))
      else finish()
      await vi.waitFor(() => expect(busy).toBe(false))
      const expected = outcome === 'accepted' ? ['first'] : outcome === 'overlap' ? ['first', 'second']
        : outcome === 'overlap-dispose' ? ['second'] : []
      await vi.waitFor(async () => expect((await inspect.recoverDrafts()).drafts.map((draft) => draft.name).sort()).toEqual(expected))
      if (!outcome.includes('dispose')) {
        expect([...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent).sort()).toEqual(expected)
        if (outcome === 'failed') expect(root.querySelector('[role="alert"]')?.textContent).toContain('Raster decode failed')
        if (outcome.startsWith('project')) expect(root.querySelector('[role="alert"]')).toBeNull()
        dispose()
      }
      if (!outcome.includes('failed')) await vi.waitFor(() => expect(released).toBe(true))
      await inspect.close()
    },
  )

  it.each(['accepted', 'cancelled', 'replaced', 'backend', 'connection', 'project', 'dispose', 'dispose-bytes', 'replaced-dispose', 'failed'])(
    'settles a graph open without stale publication or local writes (%s)', async (outcome) => {
      const source = new ImageDocumentLocalStore('graph-source', new FakeIDBFactory())
      const seed = await importSingleRaster(new File(['source'], 'Graph source.png', { type: 'image/png' }), source,
        { lineage: 'graph-workspace-open', normalize: async () => ({ width: 2, height: 1, rgba }) })
      const resource = Object.values(seed.document.resources)[0]!
      const staged = (await source.getResource(resource.digest))!
      const text = serializeImageDocument(seed.document)
      const digest = imageDocumentDigest(new TextEncoder().encode(text))
      await source.close()
      vi.stubGlobal('indexedDB', new FakeIDBFactory())
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      const inspect = new ImageDocumentLocalStore(activeProjectId())
      let finish!: () => void
      let fail!: (error: Error) => void
      const rendering = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
      let entered = false
      let settled = false
      let fetches = 0
      const holdBytes = outcome === 'dispose-bytes' || outcome === 'replaced-dispose'
      const dependencies = [{ resourceId: resource.id, ...resource }]
      const connection = {
        id: 'graph-owner', assetUrl: (value: string) => `http://graph.test/${value}`,
        adoptImageDocument: async () => ({ digest, mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
          byteSize: new TextEncoder().encode(text).byteLength, dependencies }),
        renderImageDocument: async () => {
          if (!holdBytes) { entered = true; await rendering }
          return { cacheKey: digest, cached: false,
            asset: { digest: resource.digest, size: staged.bytes.byteLength, mediaType: 'image/png', name: 'render.png', virtualPath: '' },
            provenance: { documentDigest: digest, selector: 'composite', profile: 'dinkster-image-document-v2-cpu-reference',
              rendererContract: 'test-renderer', encoding: 'image/png;dinkster-canonical=1',
              source: { digest, mediaType: IMAGE_DOCUMENT_MEDIA_TYPE, dependencies },
              output: { digest: resource.digest, byteSize: staged.bytes.byteLength, mediaType: 'image/png',
                width: 2, height: 1, encoding: 'image/png;dinkster-canonical=1' } },
          }
        },
        fetchAssetBytes: async () => {
          fetches += 1
          if (holdBytes && fetches === 1) { entered = true; await rendering }
          return Uint8Array.from(staged.bytes).buffer
        },
        retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) =>
          ({ ...owner, ...declaration, revision: declaration.revision + 1 }),
        releaseRetainedAssets: async (owner: RetainedAssetOwner, revision: number) =>
          ({ ...owner, revision: revision + 1, complete: true, digests: [] }),
      }
      const reader = new RetainedAssetReader(connection as unknown as DinksterConnection, {
        scope: 'local', ownerKind: 'shown-result', ownerId: 'graph-owner', revision: 1, complete: false, digests: [],
      }, () => true)
      const values = new DinksterValuesClient({ baseUrl: 'http://graph.test', clientId: 'graph-open',
        admitPeek: async () => reader,
        fetchFn: async (url) => new URL(url).searchParams.has('rendition')
          ? new Response(text, { headers: { 'Content-Type': IMAGE_DOCUMENT_MEDIA_TYPE,
            'X-Dinkster-Type-Id': 'dinkster.layers', 'X-Dinkster-Fingerprint': 'graph-value', 'X-Dinkster-Rendition': 'document' } })
          : new Response(JSON.stringify({ available: true, descriptor: { typeId: 'dinkster.layers', fingerprint: 'graph-value' },
            renditions: [{ kind: 'document', mime: IMAGE_DOCUMENT_MEDIA_TYPE }] }), { headers: { 'Content-Type': 'application/json' } }),
      })
      const ownedConnection = { ...connection, values: () => ({
        peek: values.peek.bind(values), rendition: values.rendition.bind(values),
        read: async (...args: Parameters<typeof values.read>) => {
          try { return await values.read(...args) } finally { settled = true }
        },
      }) } as unknown as DinksterConnection
      let backend = { protocol: 'dinkster', id: 'graph-owner', connection: ownedConnection }
      const request = { connectionId: 'graph-owner', query: { jobId: 'job', nodeId: 'producer', outputId: 'layers' },
        sourceTabId: 'tab', graphId: 'graph', sourceNodeId: 'producer', sourceOutputId: 'layers',
        expectedGraphFingerprint: 'graph' } as GraphImageDocumentRequest
      const [graphRequest, setGraphRequest] = createSignal<GraphImageDocumentRequest | undefined>(request)
      const app = { backendFor: () => backend, libraryBackend: () => undefined,
        showTransientStatus: vi.fn() } as unknown as AppState
      const handled = vi.fn()
      const root = document.createElement('div')
      document.body.append(root)
      let busy = false
      const dispose = render(() => <ImageDocumentWorkspace active app={app} graphRequest={graphRequest()}
        onGraphRequestHandled={handled} onBusyChange={(value) => { busy = value }} onClose={() => undefined} />, root)
      await vi.waitFor(() => expect(entered).toBe(true))
      if (outcome === 'cancelled') setGraphRequest(undefined)
      if (outcome === 'replaced' || outcome === 'replaced-dispose') {
        setGraphRequest({ ...request, query: { ...request.query, nodeId: 'replacement' } })
        if (outcome === 'replaced-dispose') {
          await vi.waitFor(() => expect(root.querySelector('[role="tab"]')?.textContent).toBe('replacement / layers'))
          expect(busy).toBe(true)
          dispose()
        }
      }
      if (outcome === 'backend') backend = { ...backend }
      if (outcome === 'connection') backend.connection = {} as DinksterConnection
      if (outcome === 'project') initializeProjectScope('other-project')
      if (outcome === 'dispose' || outcome === 'dispose-bytes') dispose()
      if (outcome === 'failed') fail(new Error('Reference render failed'))
      else finish()
      await vi.waitFor(() => expect(settled).toBe(true))
      await vi.waitFor(() => expect(busy).toBe(false))
      if (outcome === 'accepted' || outcome === 'replaced' || outcome === 'replaced-dispose') {
        const name = outcome.startsWith('replaced') ? 'replacement / layers' : 'producer / layers'
        if (outcome !== 'replaced-dispose') await vi.waitFor(() => expect(root.querySelector('[role="tab"]')?.textContent).toBe(name))
        expect((await inspect.recoverDraft(seed.document.lineage))?.name).toBe(name)
        expect((await inspect.getResource(resource.digest))?.bytes).toEqual(staged.bytes)
      } else {
        expect(root.querySelector('[role="tab"]')).toBeNull()
        expect(await inspect.recoverDraft(seed.document.lineage)).toBeUndefined()
        expect(await inspect.getResource(resource.digest)).toBeUndefined()
        expect(root.querySelector('[role="alert"]')?.textContent ?? '').toBe(
          outcome === 'failed' ? 'Graph layers could not be opened: Reference render failed' : '',
        )
      }
      await vi.waitFor(async () => expect(await inspect.resourceReads()).toEqual([]))
      if (!['dispose', 'dispose-bytes', 'replaced-dispose'].includes(outcome)) dispose()
      await reader.close()
      await inspect.close()
    },
  )

  it.each([
    ...['accepted', 'close', 'escape', 'backend', 'project', 'dispose', 'failure'].map((outcome) => [outcome, 'source']),
    ...['accepted', 'close', 'dispose'].map((outcome) => [outcome, 'resource']),
  ])(
    'settles a library read without publishing stale bytes (%s, %s)', async (outcome, phase) => {
      vi.stubGlobal('indexedDB', new FakeIDBFactory())
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      const seedStore = new ImageDocumentLocalStore(activeProjectId())
      const seed = await importSingleRaster(
        new File([new Uint8Array([1])], 'Library source.png', { type: 'image/png' }), seedStore,
        { lineage: 'library-open-lifetime', normalize: async () => ({ width: 2, height: 1, rgba }) },
      )
      const text = serializeImageDocument(seed.document)
      const resource = Object.values(seed.document.resources)[0]!
      const staged = (await seedStore.getResource(resource.digest))!
      await seedStore.close()
      vi.stubGlobal('indexedDB', new FakeIDBFactory())
      const store = new ImageDocumentLocalStore(activeProjectId())
      const record = {
        id: 'library-record', scope: 'local', name: 'Library source', digest: imageDocumentDigest(new TextEncoder().encode(text)),
        mediaType: IMAGE_DOCUMENT_MEDIA_TYPE, labels: ['image-document'], revision: 1, created: 1, modified: 1,
      }
      let finish!: (text: string) => void
      let fail!: (error: Error) => void
      const response = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject })
      let finishResource!: (bytes: ArrayBuffer) => void
      const resourceResponse = new Promise<ArrayBuffer>((resolve) => { finishResource = resolve })
      const fetchAssetText = vi.fn(() => phase === 'source' ? response : Promise.resolve(text))
      const fetchAssetBytes = vi.fn(() => phase === 'resource' ? resourceResponse : Promise.resolve(Uint8Array.from(staged.bytes).buffer))
      const release = vi.fn(async (owner: RetainedAssetOwner, revision: number) =>
        ({ ...owner, revision: revision + 1, complete: true, digests: [] }))
      const connection = {
        id: 'library-owner',
        assetUrl: (digest: string) => `http://library.test/${digest}`,
        listLibrary: async () => ({ records: [record] }),
        getLibraryRecord: async () => record,
        fetchAssetText,
        fetchAssetBytes,
        fetchImageDocumentDependencies: async () => Object.values(seed.document.resources).map((resource) => ({
          resourceId: resource.id, ...resource,
        })),
        retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) =>
          ({ ...owner, ...declaration, revision: declaration.revision + 1 }),
        releaseRetainedAssets: release,
      } as unknown as DinksterConnection
      let backend = { id: 'library-owner', connection }
      const app = { libraryBackend: () => backend, showTransientStatus: vi.fn() } as unknown as AppState
      const root = document.createElement('div')
      document.body.append(root)
      let isBusy = true
      const dispose = render(() => <ImageDocumentWorkspace active app={app}
        onBusyChange={(value) => { isBusy = value }} onClose={() => undefined} />, root)
      const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')]
        .find((element) => element.textContent === label)!
      await vi.waitFor(() => expect(button('Open library')?.disabled).toBe(false))
      button('Open library').click()
      await vi.waitFor(() => expect(root.querySelector('[role="dialog"]')).not.toBeNull())
      const select = root.querySelector<HTMLButtonElement>('[role="dialog"] > button')!
      select.click()
      await vi.waitFor(() => expect(fetchAssetText).toHaveBeenCalledOnce())
      if (phase === 'resource') await vi.waitFor(() => expect(fetchAssetBytes).toHaveBeenCalledOnce())
      if (outcome === 'close') button('Close').click()
      if (outcome === 'escape') root.querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      if (outcome === 'backend') backend = { ...backend, connection: {} as DinksterConnection }
      if (outcome === 'project') initializeProjectScope('other-project')
      if (outcome === 'dispose') dispose()
      if (outcome === 'failure') fail(new Error('source failed'))
      else if (phase === 'resource') finishResource(Uint8Array.from(staged.bytes).buffer)
      else finish(text)
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(phase === 'resource' || outcome === 'accepted' ? 2 : 1))
      await vi.waitFor(() => expect(isBusy).toBe(false))
      if (outcome === 'accepted') {
        await vi.waitFor(() => expect(root.querySelector('[role="tab"]')?.textContent).toBe('Library source'))
        expect((await store.recoverDraft(seed.document.lineage))?.name).toBe('Library source')
        expect((await store.getResource(resource.digest))?.bytes).toEqual(staged.bytes)
      } else {
        expect(root.querySelector('[role="tab"]')).toBeNull()
        expect(await store.recoverDraft(seed.document.lineage)).toBeUndefined()
        expect(await store.getResource(resource.digest)).toBeUndefined()
        expect(root.querySelector('[role="alert"]')?.textContent ?? '').toBe(
          outcome === 'failure' ? 'Image could not be opened: source failed' : '',
        )
      }
      await vi.waitFor(async () => expect(await store.resourceReads()).toEqual([]))
      if (outcome !== 'dispose') dispose()
      initializeProjectScope('default')
      await store.close()
    },
  )

  it('updates open workspace chrome without reopening data or translating document values', async () => {
    registerCatalog('de-DE', {
      'imageDocument.workspace.action.back': '[Zuruck zu Arbeitsablaufen]',
      'imageDocument.workspace.action.close': '[Bibliothek schliessen]',
      'imageDocument.workspace.action.openLibrary': '[Bildbibliothek offnen]',
      'imageDocument.workspace.action.sharedImages': '[Geteilte Bilder anzeigen]',
      'imageDocument.workspace.dialog.library.ariaLabel': '[Bilddokument offnen]',
      'imageDocument.workspace.dialog.library.revision': '[Revision {revision}]',
      'imageDocument.workspace.dialog.library.title': '[Bildbibliothek]',
      'imageDocument.workspace.error.sharingRequiresBackend': '[Freigabe braucht ein verbundenes Dinkster-Backend.]',
      'imageDocument.workspace.tablist': '[Offene Bilddokumente]',
    })
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'RAW source.png', { type: 'image/png' }),
      seedStore,
      { lineage: 'RAW-lineage', normalize: async () => ({ width: 2, height: 1, rgba }) },
    )
    await seedStore.close()
    const listLibrary = vi.fn(async () => ({ records: [{
      id: 'RAW-record-id',
      scope: 'local',
      name: 'RAW library document',
      digest: 'blake3:' + '1'.repeat(64),
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      labels: ['image-document'],
      created: 1,
      modified: 1,
      revision: 7,
    }], cursor: undefined }))
    const libraryBackend = { id: 'RAW-backend', connection: { listLibrary } }
    const app = {
      libraryBackend: () => libraryBackend,
      collabBackend: () => undefined,
      backends: { get: () => [] },
      showTransientStatus: vi.fn(),
    } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() =>
      <ImageDocumentWorkspace active app={app} onBusyChange={() => undefined} onClose={() => undefined} />,
      root,
    )

    await vi.waitFor(() => expect(root.textContent).toContain('RAW source'))
    const openLibrary = [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Open library')!
    openLibrary.click()
    await vi.waitFor(() => expect(root.querySelector('[role="dialog"][aria-label="Open image document"]')).not.toBeNull())
    root.querySelector<HTMLButtonElement>('[data-testid="image-collab-browse"]')!.click()
    expect(root.querySelector('.image-document-error[role="alert"]')?.textContent).toBe('Sharing requires a connected native Dinkster backend.')
    const requestsBeforeLocale = listLibrary.mock.calls.length

    setLocale('de-DE')

    expect(root.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('[Offene Bilddokumente]')
    expect(openLibrary.textContent).toBe('[Bildbibliothek offnen]')
    expect(root.querySelector('[data-testid="image-collab-browse"]')?.textContent).toBe('[Geteilte Bilder anzeigen]')
    expect([...root.querySelectorAll('button')].some((button) => button.textContent === '[Zuruck zu Arbeitsablaufen]')).toBe(true)
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('[Bilddokument offnen]')
    expect(dialog.querySelector('strong')?.textContent).toBe('[Bildbibliothek]')
    expect([...dialog.querySelectorAll('button')].some((button) => button.textContent === '[Bibliothek schliessen]')).toBe(true)
    expect(dialog.textContent).toContain('RAW library document')
    expect(dialog.textContent).toContain('[Revision 7]')
    expect(root.querySelector('[role="tab"]')?.textContent).toBe('RAW source')
    expect(root.querySelector('.image-document-error[role="alert"]')?.textContent).toBe('[Freigabe braucht ein verbundenes Dinkster-Backend.]')
    expect(listLibrary).toHaveBeenCalledTimes(requestsBeforeLocale)
    expect(root.querySelector('[role="dialog"]')).not.toBeNull()
    dispose()
  })

  it.each([10, undefined])('refuses invalid numeric commits without saving or adding history (z=%s)', async (z) => {
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const store = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'Numeric source.png', { type: 'image/png' }),
      store,
      { lineage: 'image-workspace-numeric-test', normalize: async () => ({ width: 2, height: 1, rgba }) },
    )
    const seeded = await store.saveDraft({ ...seed.document, layers: {
      ...seed.document.layers,
      l1: { ...seed.document.layers['l1']!, ...(z === undefined ? {} : { z_index: z }) },
    } }, 'Numeric source')
    const app = { libraryBackend: () => undefined, showTransientStatus: vi.fn() } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() =>
      <ImageDocumentWorkspace active app={app} onBusyChange={() => undefined} onClose={() => undefined} />,
      root,
    )
    try {
      await vi.waitFor(() => expect(root.querySelector('[aria-label="Layer z order"]')).not.toBeNull())
      const alert = () => root.querySelector('.image-document-error[role="alert"]')
      for (const [label, original] of [
        ['Layer z order', String(z ?? 0)], ['Canvas width', '2'], ['Canvas height', '1'],
      ] as const) {
        const field = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
        const fill = (value: string): void => {
          field.value = value
          field.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const key = (value: string): void => {
          field.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
        }
        expect(field.value).toBe(original)
        for (const invalid of ['', '   ', 'bad', '1.5', 'Infinity', '9007199254740992']) {
          fill(invalid)
          field.dispatchEvent(new Event('blur', { bubbles: true }))
          expect(field.value).toBe(invalid)
          expect(alert()?.textContent).toContain('Enter a whole number')
          expect((await store.recoverDraft(seed.document.lineage))!.document).toEqual(seeded.document)
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
      expect([...root.querySelectorAll('button')].find((button) => button.textContent === 'Undo')!.disabled).toBe(true)
    } finally {
      dispose()
      await store.close()
    }
  })

  it('recovers a draft and persists command edits with undo', async () => {
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'Workspace source.png', { type: 'image/png' }),
      seedStore,
      { lineage: 'image-workspace-component-test', normalize: async () => ({ width: 2, height: 1, rgba }) },
    )
    await seedStore.close()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const app = {
      libraryBackend: () => undefined,
      showTransientStatus: vi.fn(),
    } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ImageDocumentWorkspace active app={app} onBusyChange={() => undefined} onClose={() => undefined} />, root)

    await vi.waitFor(() => expect(root.textContent).toContain('Workspace source'))
    expect(root.querySelector('[data-testid="image-document-editor"]')).not.toBeNull()
    expect(root.textContent).toContain('Layers')
    expect(root.textContent).toContain('Transform')
    expect(root.textContent).toContain('Masks')
    const outputQuality = root.querySelector<HTMLInputElement>('[aria-label="Output quality"]')!
    expect(outputQuality.disabled).toBe(true)
    root.querySelector<HTMLButtonElement>('[aria-label="Output format"]')!.click()
    document.querySelector<HTMLElement>('[role="option"][data-option-id="webp"]')!.click()
    expect(outputQuality.disabled).toBe(false)
    const name = root.querySelector<HTMLInputElement>('input[aria-label="Image document name"]')!
    name.value = 'Renamed document'
    name.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('[role="tab"]')?.textContent).toBe('Renamed document'))
    const opacity = root.querySelector<HTMLElement>('[role="slider"][aria-label="Layer opacity"]')!
    opacity.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))

    const verify = new ImageDocumentLocalStore(activeProjectId())
    await vi.waitFor(async () => {
      const draft = await verify.recoverDraft(seed.document.lineage)
      expect(draft!.document.layers['l1']!.opacity).toBe(0)
    })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    await vi.waitFor(async () => {
      const draft = await verify.recoverDraft(seed.document.lineage)
      expect(draft!.document.layers['l1']!.opacity).toBe(IMAGE_OPACITY_MAX)
    })
    const remove = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Remove')!
    remove.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Select a layer to edit its properties.'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(root.textContent).toContain('Workspace source'))
    expect(consoleError).not.toHaveBeenCalled()

    dispose()
    await verify.close()
  })

  it('serializes edits made during publication behind the confirmed library link', async () => {
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'Publish source.png', { type: 'image/png' }),
      seedStore,
      { lineage: 'image-workspace-publish-test', normalize: async () => ({ width: 2, height: 1, rgba }) },
    )
    const resource = Object.values(seed.document.resources)[0]!
    const staged = (await seedStore.getResource(resource.digest))!
    await seedStore.close()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    let releaseAdoption!: () => void
    const adoptionGate = new Promise<void>((resolve) => { releaseAdoption = resolve })
    const dependencies = [{
      resourceId: resource.id,
      digest: resource.digest,
      byteSize: resource.byteSize,
      mediaType: resource.mediaType,
      width: resource.width,
      height: resource.height,
      colorSpace: resource.colorSpace,
      channelDepth: resource.channelDepth,
      alphaMode: resource.alphaMode,
    }]
    const createLibraryRecord = vi.fn(async (request: { readonly digest: string; readonly name: string; readonly scope: string }): Promise<LibraryRecord> => ({
      id: 'published-image',
      scope: request.scope,
      name: request.name,
      digest: request.digest,
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      labels: ['image-document'],
      created: 1,
      modified: 1,
      revision: 1,
    }))
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
    const dispose = render(() => <ImageDocumentWorkspace active app={app} onBusyChange={busy} onClose={() => undefined} />, root)

    await vi.waitFor(() => expect(root.textContent).toContain('Publish source'))
    const publish = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Publish')!
    publish.click()
    await vi.waitFor(() => expect(connection.adoptImageDocument).toHaveBeenCalledOnce())
    expect(busy).toHaveBeenLastCalledWith(true)
    root.querySelector<HTMLElement>('[role="slider"][aria-label="Layer opacity"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
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
      new File([new Uint8Array([1])], 'Render source.png', { type: 'image/png' }),
      seedStore,
      { lineage: 'image-workspace-render-test', normalize: async () => ({ width: 2, height: 1, rgba }) },
    )
    const resource = Object.values(seed.document.resources)[0]!
    const staged = (await seedStore.getResource(resource.digest))!
    await seedStore.close()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const dependencies = [{
      resourceId: resource.id,
      digest: resource.digest,
      byteSize: resource.byteSize,
      mediaType: resource.mediaType,
      width: resource.width,
      height: resource.height,
      colorSpace: resource.colorSpace,
      channelDepth: resource.channelDepth,
      alphaMode: resource.alphaMode,
    }]
    const outputDigest = imageDocumentDigest(staged.bytes)
    const createLibraryRecord = vi.fn()
    let renderCount = 0
    const renderImageDocument = vi.fn(async (digest: string, options: { selector?: string }) => {
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
          source: { digest, mediaType: IMAGE_DOCUMENT_MEDIA_TYPE, dependencies },
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
    })
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
    const fetchAssetBytes = vi.fn(async () => Uint8Array.from(staged.bytes).buffer)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:verified-first').mockReturnValueOnce('blob:verified-second')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const connection = {
      id: 'backend-render',
      uploadMediaAsset,
      adoptImageDocument,
      renderImageDocument,
      fetchAssetBytes,
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) =>
        ({ ...owner, ...declaration, revision: declaration.revision + 1 }),
      releaseRetainedAssets: async (owner: RetainedAssetOwner, revision: number) =>
        ({ ...owner, revision: revision + 1, complete: true, digests: [] }),
      assetUrl: vi.fn((digest: string) => `http://assets.test/${digest}`),
      createLibraryRecord,
    } as unknown as DinksterConnection
    const app = {
      libraryBackend: () => ({ id: 'backend-render', connection }),
      showTransientStatus: vi.fn(),
    } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() =>
      <ImageDocumentWorkspace active app={app} onBusyChange={() => undefined} onClose={() => undefined} />,
      root,
    )

    await vi.waitFor(() => expect(root.textContent).toContain('Render source'))
    root.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Authoritative render target"]')!
      .click()
    await vi.waitFor(() => expect([...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .some((option) => option.textContent === 'Layer: Render source')).toBe(true))
    const layerOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === 'Layer: Render source')!
    layerOption.click()
    const renderButton = [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Render')!
    renderButton.click()
    await vi.waitFor(() => expect(root.querySelector('[data-testid="authoritative-image-document-render"]')).not.toBeNull())
    expect(connection.uploadMediaAsset).toHaveBeenCalledOnce()
    expect(connection.adoptImageDocument).toHaveBeenCalledOnce()
    expect(renderImageDocument).toHaveBeenCalledWith(expect.stringMatching(/^blake3:/), {
      scope: 'local', selector: 'layer:l1',
    })
    expect(createLibraryRecord).not.toHaveBeenCalled()
    expect(root.textContent).toContain('Fresh render')
    expect(root.textContent).toContain('dinkster-image-document-v2-cpu-reference')
    expect(root.querySelector<HTMLImageElement>('img[alt="Authoritative ImageDocument output"]')?.src)
      .toBe('blob:verified-first')
    expect(root.querySelector<HTMLAnchorElement>('.image-document-download')?.href).toBe('blob:verified-first')
    expect(createObjectURL.mock.calls[0]![0]).toBeInstanceOf(Blob)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    const editor = root.querySelector('[data-testid="image-document-editor"]')
    const selectedRow = root.querySelector('.image-document-layer-row[aria-pressed="true"]')
    const callsBeforeLocale = {
      adopt: adoptImageDocument.mock.calls.length,
      fetch: fetchAssetBytes.mock.calls.length,
      render: renderImageDocument.mock.calls.length,
      upload: uploadMediaAsset.mock.calls.length,
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setLocale('de-DE')

    await vi.waitFor(() => expect(root.textContent).toContain('[Ebenen]'))
    expect(root.querySelector('[data-testid="image-document-editor"]')).toBe(editor)
    expect(root.querySelector('.image-document-layer-row[aria-pressed="true"]')).toBe(selectedRow)
    expect(root.textContent).toContain('[Verbindliche CPU-Ausgabe]')
    expect(root.textContent).toContain('[Frische Ausgabe]')
    expect(root.textContent).toContain('[Ausgabeprufsumme]')
    expect(root.textContent).toContain('Render source')
    expect(root.textContent).toContain(outputDigest)
    expect(root.textContent).toContain('dinkster-image-document-v2-cpu-reference')
    expect(root.querySelector('[role="combobox"]')?.textContent).toContain('[Ebene: Render source]')
    for (const ariaLabel of [
      '[Leinwand HOHE]', '[Leinwand BREITE]',
      '[Zuschnitt HOHE]', '[Zuschnitt BREITE]', '[Zuschnitt X]', '[Zuschnitt Y]',
      '[Grosse HOHE]', '[Grosse BREITE]',
    ]) {
      expect(root.querySelector(`[aria-label="${ariaLabel}"]`)).not.toBeNull()
    }
    await vi.runOnlyPendingTimersAsync()
    expect(adoptImageDocument).toHaveBeenCalledTimes(callsBeforeLocale.adopt)
    expect(fetchAssetBytes).toHaveBeenCalledTimes(callsBeforeLocale.fetch)
    expect(renderImageDocument).toHaveBeenCalledTimes(callsBeforeLocale.render)
    expect(uploadMediaAsset).toHaveBeenCalledTimes(callsBeforeLocale.upload)
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.useRealTimers()

    root.querySelector<HTMLElement>('[role="slider"][aria-label="[Ebenendeckkraft]"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await vi.waitFor(() => expect(root.textContent).toContain('Stale - render again'))
    const localizedRender = [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '[Referenz rendern]')!
    localizedRender.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Cache hit'))
    expect(root.querySelector<HTMLAnchorElement>('.image-document-download')?.href).toBe('blob:verified-second')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:verified-first')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:verified-second')
    dispose()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:verified-second')
  })

  it('uploads resources before sharing and persists membership until leave', async () => {
    vi.stubGlobal('indexedDB', new FakeIDBFactory())
    const seedStore = new ImageDocumentLocalStore(activeProjectId())
    const seed = await importSingleRaster(
      new File([new Uint8Array([1])], 'Shared source.png', { type: 'image/png' }),
      seedStore,
      { lineage: 'image-workspace-shared-test', normalize: async () => ({ width: 2, height: 1, rgba }) },
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
      fetchOps: async (): Promise<FetchOpsOutcome> => ({ kind: 'ops', ops: [] }),
      fetchSnapshot: async () => ({ revision: 0, document: seed.document }),
      putSnapshot: async (): Promise<PutSnapshotOutcome> => ({ kind: 'ok' }),
      sendPresence: () => undefined,
      onEvent: (next) => {
        listener = next
        next({ kind: 'connected', descriptor })
        return () => { listener = undefined }
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
    const dispose = render(() =>
      <ImageDocumentWorkspace active app={app} onBusyChange={() => undefined} onClose={() => undefined} />,
      root,
    )

    await vi.waitFor(() => expect(root.textContent).toContain('Shared source'))
    root.querySelector<HTMLButtonElement>('[data-testid="image-collab-share"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('.image-document-shared-status')?.textContent).toBe('Shared'))
    expect(order).toEqual(['upload', 'create:image'])
    const verify = new ImageDocumentLocalStore(activeProjectId())
    await vi.waitFor(async () => {
      expect((await verify.recoverDraft(seed.document.lineage))?.collaboration?.sessionId)
        .toBe(descriptor.sessionId)
    })

    root.querySelector<HTMLElement>('[role="slider"][aria-label="Layer opacity"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await vi.waitFor(() => expect(revision).toBe(1))
    root.querySelector<HTMLButtonElement>('[data-testid="image-collab-end"]')!.click()
    expect(root.querySelector('[data-testid="image-collab-end-confirm"]')).not.toBeNull()
    expect(end).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('[data-testid="image-collab-end-cancel"]')!.click()
    expect(root.querySelector('[data-testid="image-collab-end-confirm"]')).toBeNull()
    root.querySelector<HTMLButtonElement>('[data-testid="image-collab-leave"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('[data-testid="image-collab-share"]')).not.toBeNull())
    await vi.waitFor(async () => {
      expect((await verify.recoverDraft(seed.document.lineage))?.collaboration).toBeUndefined()
    })

    dispose()
    await verify.close()
  })
})
