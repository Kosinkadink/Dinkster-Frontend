// @vitest-environment happy-dom

import { setLocale } from '@dinkster/core'
import type { DocsDescriptor } from '@dinkster/client'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearnPanel, type LearnBackend } from '../src/help/LearnPanel.js'
import '../src/locale.js'

const digest = (character: string): string => `sha256:${character.repeat(64)}`
const guide = {
  pack: 'dinkster-nodes-foundation',
  kind: 'guide' as const,
  id: 'map-and-gather',
  defaultLocale: 'en',
  tags: ['map', 'subgraph'],
  locales: {
    en: { title: 'Map and Gather', summary: 'Map a list.', digest: digest('1'), assets: {} },
    zh: { title: 'Map and Gather zh', summary: 'Map a list zh.', digest: digest('2'), assets: {} },
  },
} satisfies DocsDescriptor
const fallbackGuide = {
  ...guide,
  id: 'english-only',
  locales: { en: { title: 'English only', summary: 'Fallback guide.', digest: digest('3'), assets: {} } },
}

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  setLocale('en')
})

function submitSearch(host: HTMLElement, value: string): void {
  const input = host.querySelector('input')!
  input.value = value
  input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  host.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

describe('LearnPanel', () => {
  it('pages guides, relabels in place, reads a localized page, and opens its exact template', async () => {
    setLocale('en')
    const [locale, setRequestedLocale] = createSignal('en')
    const listDocs = vi.fn(async (request: { cursor?: string }) => request.cursor === undefined
      ? { docs: [guide, fallbackGuide], cursor: 'next' }
      : { docs: [{ ...guide, id: 'third', locales: { en: { ...guide.locales.en, title: 'Third guide' } } }] })
    const fetchDocsPage = vi.fn(async () => '# Map and Gather\n\n```dinkster-example\ntemplate = "map-and-gather"\ncaption = "Open this workflow"\n```')
    const backend = {
      id: 'backend-owner',
      connection: { listDocs, fetchDocsPage, docsAssetUrl: vi.fn() },
    } as unknown as LearnBackend
    const openTemplate = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <LearnPanel backend={backend} locale={locale()} onOpenTemplate={openTemplate} />, host)

    await vi.waitFor(() => expect(host.querySelectorAll('.learn-guide-card')).toHaveLength(2))
    const search = host.querySelector('input')!
    search.value = 'kept query'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    search.focus()
    setLocale('zh')
    setRequestedLocale('zh')
    await vi.waitFor(() => expect(host.textContent).toContain('Map and Gather zh'))
    expect(host.querySelector('input')).toBe(search)
    expect(search.value).toBe('kept query')
    expect(document.activeElement).toBe(search)
    expect(listDocs).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('\u6b64\u6307\u5357\u6ca1\u6709\u5f53\u524d\u8bed\u8a00\u7684\u7ffb\u8bd1')

    ;(host.querySelector('.learn-load-more') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelectorAll('.learn-guide-card')).toHaveLength(3))
    expect(listDocs).toHaveBeenLastCalledWith({ kind: 'guide', q: '', limit: 50, cursor: 'next' })

    ;(host.querySelector('.learn-guide-card') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('.dinkster-markdown-template button')).not.toBeNull())
    expect(fetchDocsPage).toHaveBeenCalledWith('dinkster-nodes-foundation', digest('2'))
    expect(host.querySelector('article')?.getAttribute('lang')).toBe('zh')
    expect(host.textContent).toContain('dinkster-nodes-foundation')
    ;(host.querySelector('.dinkster-markdown-template button') as HTMLButtonElement).click()
    expect(openTemplate).toHaveBeenCalledWith('dinkster-nodes-foundation', 'map-and-gather', 'Map and Gather zh', 'backend-owner')
  })

  it('rejects a stale search completion', async () => {
    let resolveFirst!: (value: { docs: readonly DocsDescriptor[] }) => void
    let resolveSecond!: (value: { docs: readonly DocsDescriptor[] }) => void
    const first = new Promise<{ docs: readonly DocsDescriptor[] }>((resolve) => { resolveFirst = resolve })
    const second = new Promise<{ docs: readonly DocsDescriptor[] }>((resolve) => { resolveSecond = resolve })
    const listDocs = vi.fn((request: { q?: string }) => {
      if (request.q === 'first') return first
      if (request.q === 'second') return second
      return Promise.resolve({ docs: [] })
    })
    const backend = {
      id: 'owner',
      connection: { listDocs, fetchDocsPage: vi.fn(), docsAssetUrl: vi.fn() },
    } as unknown as LearnBackend
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <LearnPanel backend={backend} locale="en" onOpenTemplate={vi.fn()} />, host)
    await vi.waitFor(() => expect(listDocs).toHaveBeenCalledTimes(1))

    submitSearch(host, 'first')
    submitSearch(host, 'second')
    resolveSecond({ docs: [{ ...guide, id: 'second', locales: { en: { ...guide.locales.en, title: 'Second result' } } }] })
    await vi.waitFor(() => expect(host.textContent).toContain('Second result'))
    resolveFirst({ docs: [{ ...guide, id: 'first', locales: { en: { ...guide.locales.en, title: 'Stale result' } } }] })
    await Promise.resolve()
    expect(host.textContent).not.toContain('Stale result')
  })

  it('rejects a stale guide body after the locale changes', async () => {
    setLocale('en')
    const [locale, setRequestedLocale] = createSignal('en')
    let resolveEnglish!: (value: string) => void
    let resolveChinese!: (value: string) => void
    const englishPage = new Promise<string>((resolve) => { resolveEnglish = resolve })
    const chinesePage = new Promise<string>((resolve) => { resolveChinese = resolve })
    const fetchDocsPage = vi.fn((_pack: string, requestedDigest: string) =>
      requestedDigest === digest('1') ? englishPage : chinesePage,
    )
    const backend = {
      id: 'owner',
      connection: {
        listDocs: vi.fn(async () => ({ docs: [guide] })),
        fetchDocsPage,
        docsAssetUrl: vi.fn(),
      },
    } as unknown as LearnBackend
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <LearnPanel backend={backend} locale={locale()} onOpenTemplate={vi.fn()} />, host)
    await vi.waitFor(() => expect(host.querySelector('.learn-guide-card')).not.toBeNull())
    ;(host.querySelector('.learn-guide-card') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(fetchDocsPage).toHaveBeenCalledWith('dinkster-nodes-foundation', digest('1')))

    setLocale('zh')
    setRequestedLocale('zh')
    await vi.waitFor(() => expect(fetchDocsPage).toHaveBeenCalledWith('dinkster-nodes-foundation', digest('2')))
    resolveChinese('# Current Chinese page')
    await vi.waitFor(() => expect(host.textContent).toContain('Current Chinese page'))
    resolveEnglish('# Stale English page')
    await Promise.resolve()
    expect(host.textContent).not.toContain('Stale English page')
  })
})
