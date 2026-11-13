// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppPreviewSurface } from '../src/AppPreviewSurface.js'
import { AppView } from '../src/AppView.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import type { PreviewLoader } from '../src/node-previews.js'
import type { RetainedAssets } from '@dinkster/client'
import { asPromptId } from '@dinkster/core'

afterEach(() => document.body.replaceChildren())

describe('AppView document-owned previews', () => {
  it('reveals a saved output from App View through its execution owner', async () => {
    const app = createWorkflowApp([{
      type: 'ImageOutput', displayName: 'Image output', category: 'test', source: 'v3', isOutputNode: true,
      emitsPreviews: true, items: [],
    }])
    const owner = app.addBackend('http://owner.test:3639', 'Execution owner', false, 'dinkster')!
    owner.registry.set({ ...app.registry.get()!, connection: owner.id })
    vi.spyOn(owner.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(owner.connection, 'retainAssets').mockImplementation(async (holder, declaration) =>
      ({ ...holder, ...declaration, revision: declaration.revision + 1 }))
    app.widgetRegistry.registerPreviewRenderer({ id: 'test.image', canRender: (mime) => mime === 'image/png', mediaKind: 'image', drawCompact: () => {} })
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-output-reveal', root: 'root',
      graphs: { root: { id: 'root', name: 'Workflow', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        nodes: { save: { id: 'save', type: 'ImageOutput', values: {} } } } },
      view: { graphs: { root: { nodes: {} } } },
      ext: { 'dinkster.exposedPreviews': [{ graphId: 'root', nodeId: 'save', label: 'Saved image' }] },
    }, 'Saved image')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, owner.id)
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('Image output fixture did not compile')
    const ref = { connection: owner.id, prompt: asPromptId('saved-image') }
    app.registerRun(tab, ref, compiled.artifact, 1)
    const runtimeNodeId = Object.values(compiled.artifact.provenance.fromSource).flat()[0]!
    const digest = `blake3:${'e'.repeat(64)}`
    app.store.apply({ kind: 'started', execution: ref, timestamp: 2 })
    app.store.hydrateArtifacts(ref, [{ nodeId: runtimeNodeId, digest, name: 'saved.png',
      mediaType: 'image/png', size: 7, virtualPath: 'output/saved.png' }])
    const revealFile = vi.fn().mockResolvedValue(undefined)
    window.dinksterDesktop = { fileCapabilities: async () => ({ nativeFolderChoice: true, reveal: true }), revealFile } as any
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    vi.stubGlobal('Image', class { src = ''; naturalWidth = 2; naturalHeight = 1; decode = async () => {} })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })))
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AppView app={app} />, root)
    try {
      const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === label)
      await vi.waitFor(() => expect(button('Open image viewer')).toBeDefined())
      button('Open image viewer')!.click()
      await vi.waitFor(() => expect(button('Show in folder')).toBeDefined())
      button('Show in folder')!.click()
      await vi.waitFor(() => expect(revealFile).toHaveBeenCalledWith('http://owner.test:3639/', {
        digest, scope: 'local', project: 'default',
      }))
    } finally {
      dispose(); app.dispose(); delete window.dinksterDesktop; vi.restoreAllMocks(); vi.unstubAllGlobals()
    }
  })

  it.each(['live', 'edited', 'closed'] as const)('admits exposed input images and refuses stale publication: %s', async (scenario) => {
    const app = createWorkflowApp([{
      type: 'ImageInput', displayName: 'Image input', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', optional: false, type: { kind: 'concrete', name: 'core.ASSET' },
        widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } }],
    }])
    app.widgetRegistry.registerPreviewRenderer({ id: 'test.image', canRender: (mime) => mime === 'image/png', mediaKind: 'image', drawCompact: () => {} })
    const asset = (letter: string) => ({ digest: `blake3:${letter.repeat(64)}`, name: `${letter}.png`, size: 7,
      mediaType: 'image/png', virtualPath: '' })
    expect((await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-reader', root: 'root',
      graphs: { root: { id: 'root', name: 'Workflow', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        nodes: { image: { id: 'image', type: 'ImageInput', values: { image: asset('a') } } } } },
      view: { graphs: { root: { nodes: {} } } },
      ext: { 'dinkster.exposedPreviews': [{ graphId: 'root', nodeId: 'image', label: 'Selected image' }] },
    }, 'App reader'))).toEqual([])
    const tab = app.activeTab()!
    let acknowledge!: (receipt: RetainedAssets) => void
    const admission = new Promise<RetainedAssets>((resolve) => { acknowledge = resolve })
    let receipt: RetainedAssets | undefined
    vi.mocked(app.connection.retainAssets).mockImplementationOnce((owner, declaration) => {
      receipt = { ...owner, ...declaration, revision: 1 }
      return admission
    })
    const decodes: Array<{ src: string; finish: () => void }> = []
    class Image {
      src = ''
      naturalWidth = 13
      naturalHeight = 7
      decode() { return new Promise<void>((resolve) => { decodes.push({ src: this.src, finish: resolve }) }) }
    }
    vi.stubGlobal('Image', Image)
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AppView app={app} />, root)
    try {
      await vi.waitFor(() => expect(receipt).toBeDefined())
      expect(receipt!.digests).toEqual([asset('a').digest])
      expect(decodes).toHaveLength(0)
      expect(root.querySelector('[data-testid="app-preview-image"]')).toBeNull()
      if (scenario === 'closed') app.closeTab(tab.id)
      acknowledge(receipt!)
      if (scenario === 'closed') {
        await admission
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        expect(decodes).toHaveLength(0)
        expect(root.querySelector('[data-testid="app-preview-image"]')).toBeNull()
        return
      }
      await vi.waitFor(() => expect(decodes).toHaveLength(1))
      if (scenario === 'edited') {
        expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
          graphId: 'root', nodeId: 'image', inputId: 'image', value: asset('b'),
        } })).ok).toBe(true)
        await vi.waitFor(() => expect(decodes).toHaveLength(2))
        expect(decodeURIComponent(decodes[1]!.src)).toContain(asset('b').digest)
        decodes[0]!.finish()
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        expect(root.querySelector('[data-testid="app-preview-image"]')).toBeNull()
        decodes[1]!.finish()
      } else decodes[0]!.finish()
      await vi.waitFor(() => expect(root.querySelector('canvas')?.width).toBe(13))
      expect(root.querySelector('canvas')?.height).toBe(7)
    } finally { dispose(); app.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
  })
})

describe('AppPreviewSurface', () => {

  it.each([[undefined, undefined], ['PQ to sRGB', undefined], [undefined, true]] as const)('labels color conversion %s and bounded preview %s', (colorTransform, previewOnly) => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <AppPreviewSurface
        surface={{
          preview: {
            kind: 'model3d',
            src: '/api/assets/model',
            download: { src: '/api/assets/model', name: 'trellis2.glb', ...(previewOnly === true ? { previewOnly } : {}) },
            status: 'failed',
            ...(colorTransform === undefined ? {} : { colorTransform }),
          },
        }}
        loader={{} as PreviewLoader}
        ariaLabelledBy="preview-label"
      />
    ), root)

    const download = root.querySelector<HTMLAnchorElement>('[data-testid="app-preview-download"]')!
    expect(download.getAttribute('href')).toBe('/api/assets/model')
    expect(download.download).toBe('trellis2.glb')
    expect(download.textContent).toBe(previewOnly === true || colorTransform !== undefined ? 'Download preview' : 'Download output')
    expect(root.querySelector('[data-testid="app-preview-color-transform"]')?.textContent)
      .toBe(colorTransform === undefined ? undefined : `Preview color: ${colorTransform}`)
    dispose()
  })
})
