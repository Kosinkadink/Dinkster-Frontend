import { expect, test } from '@playwright/test'

const node = (displayName: string, executionArms?: readonly ('native' | 'comfyui')[]) => ({
  schemaVersion: 22,
  displayName,
  category: 'Execution arms',
  interface: [],
  ...(executionArms !== undefined ? { executionArms } : {}),
})

const catalog = (withArms: boolean) => ({
  schemaVersion: 1,
  epoch: withArms ? 2 : 1,
  dinkster: { version: 'execution-arm-proof', schemaWire: 22 },
  nodes: {
    'proof.native': node('Native Loader', withArms ? ['native'] : undefined),
    'proof.adaptive': node('Adaptive KSampler', withArms ? ['native', 'comfyui'] : undefined),
    'proof.comfyui': node('ComfyUI Saver', withArms ? ['comfyui'] : undefined),
  },
})

const openProof = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'execution-arm-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'Execution arm visibility',
          nodes: {
            load: { id: 'load', type: 'proof.native', values: {} },
            sample: { id: 'sample', type: 'proof.adaptive', values: {} },
            save: { id: 'save', type: 'proof.comfyui', values: {} },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 10,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              load: { position: { x: 120, y: 180 } },
              sample: { position: { x: 460, y: 180 } },
              save: { position: { x: 800, y: 180 } },
            },
          },
        },
      },
    } as never, 'Execution Arms')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(3)
}

test('catalog execution policies do not add implementation badges to node cards', async ({ page }) => {
  let withArms = false
  let baselineWidths: readonly number[] = []
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: {}, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog(withArms) }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)
  await openProof(page)
  baselineWidths = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.map((node) => node.layout.width))
  expect(await page.evaluate(() => {
    const badges = window.__dinksterTest!.renderer!.getBadges() as unknown as Readonly<Record<string, readonly { glyph: string }[]>>
    return Object.values(badges).flat().map((badge) => badge.glyph)
  }))
    .not.toEqual(expect.arrayContaining(['NATIVE', 'N + C', 'COMFYUI']))
  withArms = true
  await page.reload()
  await expect.poll(() => page.evaluate(() => {
    const schema = window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas
      .get('proof.adaptive') as { executionArms?: readonly string[] } | undefined
    return schema?.executionArms
  })).toEqual(['native', 'comfyui'])
  await openProof(page)
  expect(await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.map((node) => node.layout.width)))
    .toEqual(baselineWidths)
  await expect.poll(() => page.evaluate(() => {
    const badges = window.__dinksterTest!.renderer!.getBadges() as unknown as Readonly<Record<string, readonly { glyph: string }[]>>
    return Object.values(badges).flat().map((badge) => badge.glyph)
  }))
    .not.toEqual(expect.arrayContaining(['NATIVE', 'N + C', 'COMFYUI']))
})
