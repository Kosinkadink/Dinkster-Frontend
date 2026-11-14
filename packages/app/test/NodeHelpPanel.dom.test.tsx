// @vitest-environment happy-dom

import { resolveObjectURL } from 'node:buffer'
import { createSignal } from '@dinkster/core'
import { createSignal as createSolidSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../src/app-state.js'
import { NodeHelpPanel } from '../src/help/NodeHelpPanel.js'
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
      assets: {
        'assets/demo.mp4': { digest: digest('2'), mediaType: 'video/mp4' },
        'assets/missing.png': { digest: digest('4'), mediaType: 'image/png' },
      },
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

  it('loads and renders the exact descriptor page and digest assets', async () => {
    const request = createSignal({ backendId: 'local' as never, pack: 'demo-pack', nodeType: 'demo.add' })
    const [locale, setLocale] = createSolidSignal('en')
    const listDocs = vi.fn(async () => ({ docs: [descriptor] }))
    const fetchDocsPage = vi.fn(async () => '# Usage\n\n```dinkster-media\nasset = "assets/demo.mp4"\ncaption = "A short demo"\n```')
    const connection = {
      listDocs,
      fetchDocsPage,
      fetchDocsAsset: vi.fn(async (_pack: string, assetDigest: string) => {
        if (assetDigest === digest('4')) throw new Error('Media unavailable')
        return new Blob(['demo'], { type: 'video/mp4' })
      }),
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
    const mediaUrl = host.querySelector('video')?.getAttribute('src')
    expect(mediaUrl).toMatch(/^blob:/)
    expect(await resolveObjectURL(mediaUrl!)?.text()).toBe('demo')
    expect(host.querySelector('.node-help-warning')).not.toBeNull()

    setLocale('zh-Hans-CN')
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Add values zh'))
    expect(fetchDocsPage).toHaveBeenLastCalledWith('demo-pack', digest('3'))
    expect(resolveObjectURL(mediaUrl!)).toBeUndefined()

    setLocale('fr-CA')
    await vi.waitFor(() => expect(host.querySelector('.node-help-fallback')?.textContent).toBe('Shown in English (no fr-CA translation).'))
  })
})
