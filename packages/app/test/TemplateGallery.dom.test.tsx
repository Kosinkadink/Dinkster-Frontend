// @vitest-environment happy-dom

import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asNodeId, DINKSTER_SCHEMA_WIRE_VERSION, type NodeSchema } from '@dinkster/core'
import { buildDinksterRegistry, type ModelDownloadJob } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { templatesSource } from '../src/collections.js'
import { TemplatesPage } from '../src/TemplatesPage.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

function enter(control: HTMLInputElement, value: string): void {
  control.value = value
  control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('Template collection', () => {
  it('normalizes template identity searches', async () => {
    const app = new AppState()
    const backend = app.libraryBackend()!
    vi.spyOn(backend.connection, 'listTemplates').mockResolvedValue({
      templates: [
        {
          pack: 'native', id: 'sd15', name: 'Stable Diffusion 1.5', digest: 'sha256:a',
          family: 'dinkster.sd15', tags: ['starter'], description: '\u56fe\u50cf',
        },
        {
          pack: 'native', id: 'sdxl', name: 'Stable Diffusion XL', digest: 'sha256:b',
          family: 'dinkster.sdxl', tags: ['starter'],
        },
      ],
    })

    for (const [query, expected] of [
      ['SD 1.5', 'Stable Diffusion 1.5'],
      ['sd1.5', 'Stable Diffusion 1.5'],
      ['SD15', 'Stable Diffusion 1.5'],
      ['SDXL', 'Stable Diffusion XL'],
      ['Stable Diffusion XL', 'Stable Diffusion XL'],
      ['Stable-Diffusion XL', 'Stable Diffusion XL'],
      ['\u56fe\u50cf', 'Stable Diffusion 1.5'],
    ] as const) {
      const page = await templatesSource(app).page({ query, limit: 10 })
      expect(page.items.map((entry) => entry.title), query).toEqual([expected])
    }
    for (const query of ['stable', 'diffusion']) {
      const page = await templatesSource(app).page({ query, limit: 10 })
      expect(page.items.map((entry) => entry.title), query).toEqual([
        'Stable Diffusion 1.5',
        'Stable Diffusion XL',
      ])
    }
    const diffusion15 = await templatesSource(app).page({ query: 'diffusion 1.5', limit: 10 })
    expect(diffusion15.items.map((entry) => entry.title)).toEqual(['Stable Diffusion 1.5'])
  })

  it('groups templates by family and shows the exact missing model list', async () => {
    const app = new AppState()
    const backend = app.libraryBackend()!
    vi.spyOn(backend.connection, 'listTemplates').mockResolvedValue({
      templates: [
        {
          pack: 'native', id: 'sd15', name: 'Stable Diffusion 1.5', digest: 'sha256:a',
          family: 'dinkster.sd15', models: ['present.safetensors'],
        },
        {
          pack: 'native', id: 'h3', name: 'MiniMax H3', digest: 'sha256:b',
          family: 'dinkster.minimax_h3', models: ['missing-dit.safetensors', 'missing-vae.safetensors'],
        },
      ],
    })
    vi.spyOn(backend.connection, 'guessAssets').mockImplementation(async (names) => names.map((query) => ({
      query,
      candidates: query === 'present.safetensors'
        ? [{ digest: 'blake3:x', name: query, confidence: 'name', held: true }]
        : [],
    })))
    const firstPage = await templatesSource(app).page({ query: '', limit: 1 })
    expect(firstPage.items.map((entry) => entry.title)).toEqual(['Stable Diffusion 1.5'])
    expect(firstPage.cursor).toBeDefined()
    const secondPage = await templatesSource(app).page({ query: '', limit: 1, cursor: firstPage.cursor! })
    expect(secondPage.items.map((entry) => entry.title)).toEqual(['MiniMax H3'])
    expect(secondPage.cursor).toBeUndefined()
    expect(secondPage.items[0]?.details).toEqual(expect.arrayContaining([
      { label: 'model missing', text: 'missing-dit.safetensors' },
      { label: 'model missing', text: 'missing-vae.safetensors' },
    ]))
  })
})

describe('TemplatesPage', () => {
  it('selects without opening, searches across groups and opens with missing models', async () => {
    const app = new AppState()
    const backend = app.libraryBackend()!
    backend.templatesEnabled.set(true)
    backend.registry.set(buildDinksterRegistry(backend.id, {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      dinkster: { version: 'test', schemaWire: 2 },
      nodes: {},
      packs: { native: { displayName: 'Native pack', assets: [
        { id: 'base', name: 'Base', digest: 'blake3:base', size: 8388608 },
        { id: 'vae', name: 'VAE', digest: 'blake3:vae', size: 2097152 },
      ] } },
    }))
    const schema: NodeSchema = {
      type: 'ModelLoader', displayName: 'Load models', category: 'test', source: 'v3', isOutputNode: false,
      body: ['base', 'vae', 'repeated'].map((id) => ({
        kind: 'input', id, optional: false, type: { kind: 'concrete', name: 'ASSET' },
        widget: { widgetType: 'ASSET', kind: id === 'base' ? 'model/checkpoint' : 'model/vae', options: {} },
      })),
    }
    backend.registry.set({ ...backend.registry.get()!, resolve: (type) => type === schema.type ? schema : undefined,
      schemas: new Map([[schema.type, schema]]) })
    const workflow = app.createWorkflow().store.doc
    const vae = { digest: `blake3:${'a'.repeat(64)}`, name: 'VAE', size: 2097152,
      mediaType: 'application/octet-stream', virtualPath: 'models/VAE' }
    const otherVae = { ...vae, digest: `blake3:${'b'.repeat(64)}` }
    vi.spyOn(backend.connection, 'fetchTemplateBody').mockResolvedValue({ ...workflow, graphs: {
      [workflow.root]: { ...workflow.graphs[workflow.root]!, nodes: {
        loader: { id: asNodeId('loader'), type: schema.type, values: { base: 'Base', vae, repeated: otherVae } },
      } },
    } })
    const jobs = new Map<string, ModelDownloadJob>()
    const plan = { name: 'VAE', kind: 'model/vae', status: 'consent-required' as const,
      planId: 'vae', digest: vae.digest, project: 'default', provider: 'huggingface' as const,
      source: 'https://huggingface.co/example/model/resolve/main/vae.safetensors', repo: 'example/model',
      revision: 'c'.repeat(40), file: 'vae.safetensors', sha256: 'd'.repeat(64), size: vae.size,
      license: 'Apache-2.0', destination: '/models/vae.safetensors', mount: 'models' }
    vi.spyOn(backend.connection, 'planModelDownload').mockResolvedValue(plan)
    vi.spyOn(backend.connection, 'startModelDownload').mockImplementation(async () => {
      const job = { ...plan, jobId: 'vae-job', status: 'downloading' as const, received: plan.size / 4 }
      jobs.set(job.jobId, job)
      return job
    })
    vi.spyOn(backend.connection, 'cancelModelDownload').mockImplementation(async (id) => {
      const job = { ...jobs.get(id)!, status: 'cancelled' as const }
      jobs.set(id, job)
      return job
    })
    vi.spyOn(backend.connection, 'fetchModelDownloads').mockImplementation(async () => ({ instance: 'test', jobs: [...jobs.values()] }))
    vi.spyOn(backend.connection, 'listTemplates').mockResolvedValue({ templates: [
      { pack: 'native', id: 'image', name: 'Image starter', description: '\u56fe\u50cf', digest: 'sha256:a', family: 'SD 1.5', tags: ['image'], assets: ['base', 'vae'] },
      { pack: 'native', id: 'video', name: 'Video starter', digest: 'sha256:b', tags: ['video'], models: ['unknown-size'] },
      { pack: 'native', id: 'list', name: 'Count a list', digest: 'sha256:c', tags: ['tool'] },
    ] })
    vi.spyOn(backend.connection, 'fetchModelSettings').mockResolvedValue({
      settings: { version: 1, locations: [], downloadLocation: null },
      locations: [{ id: 'models', path: '/models', mode: 'readwrite', visibility: 'always-on', mounts: ['models'], enabled: true, active: true }],
      revision: 'r1', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [],
    })
    vi.spyOn(backend.connection, 'guessAssets').mockImplementation(async (names) => names.map((query) => ({
      query, candidates: query === 'Base' ? [{ digest: 'blake3:base', name: query, confidence: 'name', held: true }] : [],
    })))
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => {
      const [opened, setOpened] = createSignal('Nothing opened')
      return <><TemplatesPage app={app}
        onOpen={async (entry) => { setOpened(entry.title); return true }}
        onBlank={() => setOpened('Blank workflow')} onOpenStorage={() => undefined} />
        <output>{opened()}</output></>
    }, host)
    const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)!
    const options = (label: string) => [...host.querySelectorAll<HTMLElement>(`[aria-label="${label}"] [role="option"]`)]
    try {
      await vi.waitFor(() => expect(options('Templates')).toHaveLength(3))
      expect(host.querySelector('.dinkster-template-detail')?.textContent).toContain('1 of 2 on this computer')
      expect(button('Download 1 model2 MB')).toBeDefined()
      const tabsBeforeReview = app.tabs.get().length
      button('Download 1 model2 MB').click()
      await vi.waitFor(() => expect(app.assetConsent.get()?.models?.map((model) => model.requirement)).toEqual([
        { name: 'Base', kind: 'model/checkpoint' },
        { name: 'VAE', kind: 'model/vae', asset: vae },
        { name: 'VAE', kind: 'model/vae', asset: otherVae },
      ]))
      expect(app.assetConsent.get()?.retry).toBeUndefined()
      expect(app.tabs.get()).toHaveLength(tabsBeforeReview)
      expect(app.store.executions.get().size).toBe(0)
      await app.assetConsent.get()!.reviewModel!(1)
      await app.assetConsent.get()!.downloadModel!(1)
      await vi.waitFor(() => expect(host.textContent).toContain('Downloading 1 model, 25%'))
      app.assetConsent.set(undefined)
      expect(host.textContent).toContain('Downloading 1 model, 25%')
      button('Stop').click()
      await vi.waitFor(() => expect(host.textContent).not.toContain('Downloading 1 model, 25%'))
      expect(jobs.get('vae-job')?.status).toBe('cancelled')
      const groupOptions = [...host.querySelectorAll<HTMLElement>('.dinkster-template-filter')]
      expect(groupOptions.map((item) => item.textContent)).toEqual(['All3', 'Image1', 'Video1', 'Loops and tools1', 'Other1', 'SD 1.51', 'No models1'])
      groupOptions.find((item) => item.dataset['group'] === 'makes:video')!.click()
      await vi.waitFor(() => expect(options('Templates')).toHaveLength(1))
      expect(host.querySelector('.dinkster-template-detail')?.textContent).toContain('unknown-size')
      expect(button('Download 1 model')).toBeDefined()
      expect(host.querySelector('output')?.textContent).toBe('Nothing opened')

      enter(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'SD1.5')
      await vi.waitFor(() => expect(options('Templates').map((item) => item.textContent)).toEqual(['2 MBImage starterSD 1.5']))
      enter(host.querySelector<HTMLInputElement>('input[type="search"]')!, '\u56fe\u50cf')
      await vi.waitFor(() => expect(options('Templates')).toHaveLength(1))
      button('Use template').click()
      await vi.waitFor(() => expect(host.querySelector('output')?.textContent).toBe('Image starter'))
      backend.templatesEnabled.set(false)
      await vi.waitFor(() => expect(host.querySelector('[data-testid="templates-page"]')).toBeNull())
    } finally { dispose(); app.dispose() }
  })

  it('keeps folder setup in Storage and preserves an empty page with Blank workflow', async () => {
    const app = new AppState()
    const backend = app.libraryBackend()!
    backend.templatesEnabled.set(true)
    let empty = false
    let failure: 'templates' | 'settings' | undefined = 'templates'
    vi.spyOn(backend.connection, 'listTemplates').mockImplementation(async () => {
      if (failure === 'templates') throw new Error('GET /api/templates failed: 503')
      return { templates: empty ? [] : [
        { pack: 'native', id: 'starter', name: 'Starter', digest: 'sha256:a', models: ['missing'] },
      ] }
    })
    vi.spyOn(backend.connection, 'guessAssets').mockResolvedValue([])
    vi.spyOn(backend.connection, 'fetchModelSettings').mockImplementation(async () => {
      if (failure === 'settings') throw new Error('GET /api/models/settings failed: 503')
      return {
        settings: { version: 1, locations: [], downloadLocation: null }, locations: [],
        revision: 'r1', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [],
      }
    })
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => {
      const [action, setAction] = createSignal('')
      const [visible, setVisible] = createSignal(true)
      return <><Show when={visible()}><TemplatesPage app={app} onOpen={async () => true}
        onBlank={() => setAction('Blank workflow')} onOpenStorage={() => setAction('Storage')} /></Show>
        <output>{action()}</output>
        <button onClick={() => { setVisible(false); empty = true; queueMicrotask(() => setVisible(true)) }}>Reload empty</button></>
    }, host)
    try {
      for (const next of ['settings', undefined] as const) {
        await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load templates'))
        expect(host.textContent).not.toContain('GET /api/')
        expect(host.textContent).not.toContain('No templates yet')
        expect(host.querySelector('.dinkster-template-filter')).toBeNull()
        expect(host.querySelector('.dinkster-template-detail')).toBeNull()
        expect(host.querySelector('input[type="search"]')).not.toBeNull()
        failure = next
        ;[...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Retry')!.click()
      }
      await vi.waitFor(() => expect(host.textContent).toContain('No model folder yet'))
      expect(host.querySelector('form')).toBeNull()
      expect([...host.querySelectorAll('button')].some((button) => button.textContent?.startsWith('Download'))).toBe(false)
      ;[...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Open Storage')!.click()
      expect(host.querySelector('output')?.textContent).toBe('Storage')
      ;[...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reload empty')!.click()
      await vi.waitFor(() => expect(host.textContent).toContain('No templates yet. Packs you add can bring their own.'))
      expect(host.querySelector('.dinkster-template-detail')).toBeNull()
      ;[...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Blank workflow')!.click()
      expect(host.querySelector('output')?.textContent).toBe('Blank workflow')
    } finally { dispose() }
  })
})
