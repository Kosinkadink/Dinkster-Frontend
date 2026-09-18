// @vitest-environment happy-dom

import { createSignal } from '@dinkster/core'
import { createSignal as createSolidSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../src/app-state.js'
import { NodeHelpPanel, selectDocsLocale } from '../src/help/NodeHelpPanel.js'
import '../src/locale.js'

const digest = (character: string): string => `sha256:${character.repeat(64)}`
const descriptor = {
  pack: 'demo-pack',
  kind: 'node' as const,
  id: 'demo.add',
  defaultLocale: 'en',
  locales: {
    en: {
      title: 'Add values', summary: 'Adds two values.', schemaVersion: 1, digest: digest('1'),
      assets: { 'assets/demo.mp4': { digest: digest('2'), mediaType: 'video/mp4' } },
    },
    'zh-hans': {
      title: 'Add values zh', summary: 'Summary zh', digest: digest('3'), assets: {},
    },
  },
}

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

describe('NodeHelpPanel', () => {
  it('selects exact, language, then declared default locales', () => {
    expect(selectDocsLocale(descriptor, ['zh-Hans-CN'])).toMatchObject({ locale: 'zh-hans', fallback: false })
    expect(selectDocsLocale(descriptor, ['fr'])).toMatchObject({ locale: 'en', fallback: true })
  })

  it('prefers a base locale before another regional variant', () => {
    const withBaseAfterVariant = {
      ...descriptor,
      locales: {
        'zh-hans': descriptor.locales['zh-hans'],
        zh: { title: 'Add values zh base', summary: 'Summary zh base', digest: digest('4'), assets: {} },
        en: descriptor.locales.en,
      },
    }
    expect(selectDocsLocale(withBaseAfterVariant, ['zh-Hant'])).toMatchObject({ locale: 'zh', fallback: false })
  })

  it('normalizes mixed-case underscores in requested and descriptor locale tags', () => {
    const withUnderscoreDescriptor = {
      ...descriptor,
      locales: {
        Zh_Hans: descriptor.locales['zh-hans'],
        en: descriptor.locales.en,
      },
    }
    expect(selectDocsLocale(withUnderscoreDescriptor, ['ZH_HANS_CN'])).toMatchObject({ locale: 'Zh_Hans', fallback: false })

    const withUnderscoreBaseAfterVariant = {
      ...descriptor,
      locales: {
        zh_Hans: descriptor.locales['zh-hans'],
        ZH: { title: 'Add values zh base', summary: 'Summary zh base', digest: digest('5'), assets: {} },
        en: descriptor.locales.en,
      },
    }
    expect(selectDocsLocale(withUnderscoreBaseAfterVariant, ['ZH_HANT'])).toMatchObject({ locale: 'ZH', fallback: false })
  })

  it('loads and renders the exact descriptor page and digest assets', async () => {
    const request = createSignal({ backendId: 'local' as never, pack: 'demo-pack', nodeType: 'demo.add' })
    const [locale, setLocale] = createSolidSignal('en')
    const listDocs = vi.fn(async () => ({ docs: [descriptor] }))
    const fetchDocsPage = vi.fn(async () => '# Usage\n\n```dinkster-media\nasset = "assets/demo.mp4"\ncaption = "A short demo"\n```')
    const connection = {
      listDocs,
      fetchDocsPage,
      docsAssetUrl: vi.fn((_pack: string, assetDigest: string) => `/docs/${assetDigest}`),
    }
    const registry = createSignal({ resolve: () => ({ ext: { dinkster: { version: 2 } } }) })
    const app = {
      nodeHelpRequest: request,
      backendFor: () => ({ protocol: 'dinkster', connection, registry }),
    } as unknown as AppState
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <NodeHelpPanel app={app} locale={locale()} />, host)

    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Add values'))
    expect(listDocs).toHaveBeenCalledWith({ kind: 'node', pack: 'demo-pack', id: 'demo.add', limit: 1 })
    expect(fetchDocsPage).toHaveBeenCalledWith('demo-pack', digest('1'))
    expect(host.querySelector('.dinkster-markdown h1')?.textContent).toBe('Usage')
    expect(host.querySelector('video')?.getAttribute('src')).toBe(`/docs/${digest('2')}`)
    expect(host.querySelector('.node-help-warning')).not.toBeNull()

    setLocale('zh-Hans-CN')
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Add values zh'))
    expect(fetchDocsPage).toHaveBeenLastCalledWith('demo-pack', digest('3'))

    setLocale('fr-CA')
    await vi.waitFor(() => expect(host.querySelector('.node-help-fallback')?.textContent).toBe('Shown in English (no fr-CA translation).'))
  })
})
