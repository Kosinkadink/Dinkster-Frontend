import { expect, test, type Page } from '@playwright/test'

const EN_DIGEST = `sha256:${'a'.repeat(64)}`
const ZH_DIGEST = `sha256:${'b'.repeat(64)}`

interface RegistryView {
  readonly hash: string
  readonly resolve: (type: string) => {
    readonly displayName: string
    readonly items: readonly {
      readonly kind: string
      readonly widget?: { readonly options: Readonly<Record<string, unknown>> }
    }[]
  } | undefined
  readonly packs?: ReadonlyMap<string, {
    readonly blueprints?: readonly { readonly id: string; readonly name: string; readonly digest: string }[]
  }>
}

const catalogs: Readonly<Record<string, unknown>> = {
  [EN_DIGEST]: {
    nodes: {
      'proof.localized': {
        displayName: 'Localized Paint',
        description: 'English fallback description from the pack catalog.',
        inputs: { color: { displayName: 'Color', doc: 'English fallback port help.' } },
        outputs: { image: { displayName: 'Image' } },
        combos: { color: { red: 'Red', blue: 'Blue' } },
      },
    },
    blueprints: { starter: { name: 'Starter workflow' } },
    searchTerms: { 'proof.localized': ['paint'] },
  },
  [ZH_DIGEST]: {
    nodes: {
      'proof.localized': {
        displayName: '\u672c\u5730\u5316\u7ed8\u753b',
        inputs: { color: { displayName: '\u989c\u8272' } },
        outputs: { image: { displayName: '\u56fe\u50cf' } },
        combos: { color: { red: '\u7ea2\u8272' } },
      },
    },
    blueprints: { starter: { name: '\u5165\u95e8\u5de5\u4f5c\u6d41' } },
    searchTerms: { 'proof.localized': ['\u7ed8\u753b'] },
  },
}

async function openPalette(page: Page): Promise<void> {
  const canvas = page.getByTestId('graph-canvas')
  const box = (await canvas.boundingBox())!
  await canvas.dispatchEvent('dblclick', {
    bubbles: true,
    button: 0,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  })
  await expect(page.getByTestId('node-palette')).toBeVisible()
}

test('wire 44 pack presentation updates live with exact fallback and no schema refetch', async ({ page }) => {
  let nodeRequests = 0
  const localeRequests: string[] = []
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/api/nodes*', (route) => {
    nodeRequests += 1
    return route.fulfill({ json: {
      schemaVersion: 1,
      epoch: 1,
      dinkster: { version: 'wire44-proof', schemaWire: 1 },
      packs: {
        proof: {
          displayName: 'RAW proof pack',
          locales: { en: EN_DIGEST, zh: ZH_DIGEST },
          blueprints: [{ id: 'starter', name: 'RAW starter', digest: `sha256:${'c'.repeat(64)}` }],
        },
      },
      nodes: {
        'proof.localized': {
          schemaVersion: 1,
          displayName: 'RAW untranslated node',
          description: 'RAW untranslated description',
          category: 'proof',
          pack: 'proof',
          interface: [
            {
              role: 'input', id: 'color', displayName: 'RAW color', required: true,
              type: { kind: 'concrete', types: ['core.combo'] },
              widget: { type: 'COMBO', options: ['red', 'blue'] },
            },
            {
              role: 'output', id: 'image', displayName: 'RAW image',
              type: { kind: 'concrete', types: ['dinkster.image'] },
            },
          ],
        },
      },
    } })
  })
  await page.route('**/api/packs/proof/locales/**', (route) => {
    const digest = decodeURIComponent(route.request().url().slice(route.request().url().lastIndexOf('/') + 1))
    localeRequests.push(digest)
    return route.fulfill({ json: catalogs[digest] })
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const registry = window.__dinksterTest?.app.backends.get()[0]?.registry.get() as unknown as RegistryView
    return registry?.resolve('proof.localized')?.displayName
  })).toBe('Localized Paint')
  const registryHash = await page.evaluate(() =>
    (window.__dinksterTest!.app.backends.get()[0]!.registry.get() as unknown as RegistryView).hash,
  )

  await openPalette(page)
  const search = page.getByTestId('palette-search')
  await search.fill('paint')
  const result = page.locator('[data-node-type="proof.localized"]')
  await expect(result).toContainText('Localized Paint')
  await result.hover()
  await expect(page.getByTestId('palette-preview')).toContainText('English fallback description from the pack catalog.')
  await expect(page.getByTestId('palette-preview')).toContainText('Color')
  await expect(page.getByTestId('palette-preview')).toContainText('Image')
  await page.screenshot({ path: '../../docs/evidence/issue-457/pack-locale-overlay-en.png', fullPage: true })
  const nodeRequestsBeforeLocaleChange = nodeRequests

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { readonly settings: { set(id: string, value: string): void } }
    app.settings.set('dinkster.locale', 'zh')
  })

  await search.fill('\u7ed8\u753b')
  await expect(result).toContainText('\u672c\u5730\u5316\u7ed8\u753b')
  await result.hover()
  await expect(page.getByTestId('palette-preview')).toContainText('English fallback description from the pack catalog.')
  await expect(page.getByTestId('palette-preview')).toContainText('\u989c\u8272')
  await expect(page.getByTestId('palette-preview')).toContainText('\u56fe\u50cf')
  const registryFacts = await page.evaluate(() => {
    const registry = window.__dinksterTest!.app.backends.get()[0]!.registry.get() as unknown as RegistryView
    const node = registry.resolve('proof.localized')!
    const input = node.items.find((item) => item.kind === 'input')
    return {
      hash: registry.hash,
      options: input?.kind === 'input' ? input.widget?.options['options'] : undefined,
      blueprint: registry.packs?.get('proof')?.blueprints?.[0],
    }
  })
  expect(registryFacts.options).toEqual([
    { value: 'red', label: '\u7ea2\u8272' },
    { value: 'blue', label: 'Blue' },
  ])
  expect(registryFacts.blueprint).toMatchObject({
    id: 'starter', name: '\u5165\u95e8\u5de5\u4f5c\u6d41', digest: `sha256:${'c'.repeat(64)}`,
  })
  expect(registryFacts.hash).toBe(registryHash)
  expect(nodeRequests).toBe(nodeRequestsBeforeLocaleChange)
  expect(localeRequests).toEqual([EN_DIGEST, ZH_DIGEST])
  await page.screenshot({ path: '../../docs/evidence/issue-457/pack-locale-overlay-zh.png', fullPage: true })
})
