import { expect, test, type Page } from '@playwright/test'

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'audit-s2-proof', schemaWire: 21 },
  packs: {},
  nodes: {},
}

async function prepare(page: Page): Promise<void> {
  await page.route('/api/**', (route) => { throw new Error(`unexpected unmocked API request: ${route.request().url()}`) })
  await page.route('/api/settings', (route) => route.fulfill({ json: { categories: { granted: [], available: [] }, settings: {} } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/composition', (route) => route.fulfill({ json: { packs: {} } }))
  await page.route('/api/mounts', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.goto('/')
  await expect(page.getByTestId('minimap')).toBeVisible()
}

test('dense minimap keeps nodes visible and the viewport stroke inside its canvas', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    bridge.app.openDocument(
      bridge.syntheticWorkflow({ chains: 8, chainLength: 8, reroutes: true, groups: true }),
      'Dense minimap proof',
    )
    bridge.renderer!.fitToScene()
    const renderer = bridge.renderer!
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!
    const nodes = renderer.getScene().nodes
    const minX = Math.min(...nodes.map((node) => node.x))
    const minY = Math.min(...nodes.map((node) => node.y))
    const maxX = Math.max(...nodes.map((node) => node.x + node.layout.width))
    const maxY = Math.max(...nodes.map((node) => node.y + node.layout.height))
    const scale = 0.42
    renderer.setViewport({
      x: canvas.clientWidth / 2 - ((minX + maxX) / 2) * scale,
      y: canvas.clientHeight / 2 - ((minY + maxY) / 2) * scale,
      scale,
    })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(64)
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await expect.poll(() => page.getByTestId('minimap').evaluate((canvas: HTMLCanvasElement) => canvas.width > 0)).toBe(true)
  await page.getByTestId('minimap').screenshot({ path: '/tmp/audit-s2-green-contrast.png' })

  const contrast = await page.getByTestId('minimap').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    const colors = new Map<string, number>()
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`
      colors.set(key, (colors.get(key) ?? 0) + 1)
    }
    const css = getComputedStyle(document.documentElement)
    const rgb = (value: string) => {
      const hex = value.trim()
      if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`expected a six-digit hex token, got ${hex}`)
      return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]
    }
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const s = value / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!)
    }
    const background = luminance(rgb(css.getPropertyValue('--dinkster-surface-canvas')))
    const nodeRgb = rgb(css.getPropertyValue('--dinkster-text-disabled'))
    const nodeLuminance = luminance(nodeRgb)
    return {
      ratio: (nodeLuminance + 0.05) / (background + 0.05),
      node: { rgb: nodeRgb, count: colors.get(nodeRgb.join(',')) ?? 0 },
    }
  })
  expect(contrast.node.count).toBeGreaterThan(64)
  expect(contrast.ratio).toBeGreaterThanOrEqual(3)

  await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const scene = renderer.getScene()
    const bounds = [
      ...scene.nodes.map((node) => ({ x: node.x, y: node.y, width: node.layout.width, height: node.layout.height })),
      ...scene.groups,
    ]
    const maxX = Math.max(...bounds.map((box) => box.x + box.width))
    const maxY = Math.max(...bounds.map((box) => box.y + box.height))
    const scale = 1.13
    renderer.setViewport({ x: -maxX * scale, y: -maxY * scale, scale })
  })
  const strokeMetrics = (canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d')!
    const { width, height } = canvas
    const data = ctx.getImageData(0, 0, width, height).data
    const points: { x: number; y: number }[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        if (data[i]! >= 225 && data[i + 1]! >= 225 && data[i + 2]! >= 225 && data[i + 3]! >= 220) points.push({ x, y })
      }
    }
    return {
      count: points.length,
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
      width,
      height,
    }
  }
  await expect.poll(async () => {
    const metrics = await page.getByTestId('minimap').evaluate(strokeMetrics)
    return metrics.count > 0
      && metrics.width - 1 - metrics.maxX <= 4
      && metrics.height - 1 - metrics.maxY <= 4
  }).toBe(true)
  const stroke = await page.getByTestId('minimap').evaluate(strokeMetrics)
  expect(stroke.count).toBeGreaterThan(0)
  expect(stroke.minX).toBeGreaterThanOrEqual(1)
  expect(stroke.minY).toBeGreaterThanOrEqual(1)
  expect(stroke.maxX).toBeLessThan(stroke.width - 1)
  expect(stroke.maxY).toBeLessThan(stroke.height - 1)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})
