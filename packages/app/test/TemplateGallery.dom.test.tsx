// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppState } from '../src/app-state.js'
import { templatesSource } from '../src/collections.js'
import { TemplateGallery } from '../src/TemplateGallery.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('TemplateGallery', () => {
  it('normalizes template identity searches', async () => {
    const app = new AppState({ defaultProtocol: 'dinkster' })
    const backend = app.libraryBackend()!
    vi.spyOn(backend.connection, 'listTemplates').mockResolvedValue({
      templates: [
        {
          pack: 'native', id: 'sd15', name: 'Stable Diffusion 1.5', digest: 'sha256:a',
          family: 'dinkster.sd15', tags: ['starter'],
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
    const app = new AppState({ defaultProtocol: 'dinkster' })
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
    const open = vi.spyOn(app, 'openTemplate').mockResolvedValue(true)
    const close = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <TemplateGallery app={app} visible={() => true} onClose={close} />, host)

    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="template-card"]')).toHaveLength(2))
    const search = host.querySelector<HTMLInputElement>('[data-testid="template-gallery-search"]')!
    search.value = 'SD 1.5'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="template-card"]')).toHaveLength(1))
    expect(host.querySelector('[data-testid="template-card"]')?.textContent).toContain('Stable Diffusion 1.5')
    search.value = ''
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="template-card"]')).toHaveLength(2))
    expect([...host.querySelectorAll('.template-family h3')].map((node) => node.textContent)).toEqual([
      'dinkster.sd15',
      'dinkster.minimax_h3',
    ])
    const h3 = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="template-card"]')]
      .find((card) => card.textContent?.includes('MiniMax H3'))!
    expect(h3.textContent).toContain('2 required model(s) missing')
    expect(h3.textContent).toContain('missing-dit.safetensors, missing-vae.safetensors')
    h3.click()
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('native', 'h3', 'MiniMax H3', backend.id))
    expect(close).toHaveBeenCalled()
    dispose()
  })
})
