import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/audit-f6-proof'

async function rowPoint(page: Page, inputId: string) {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + node.layout.width / 2,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  }, inputId)
}

test('proves remote COMBO editing implementation consumer states and OOV authority', async ({ page }) => {
  await mkdir(proofDir, { recursive: true })
  let releaseReady!: () => void
  const readyGate = new Promise<void>((resolve) => { releaseReady = resolve })
  let readyRequests = 0

  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'remote-combo-m1-proof', schemaWire: 1 },
    packs: { test: { displayName: 'Test' } },
    nodes: { RemoteComboProof: {
      schemaVersion: 1,
      nodeType: 'RemoteComboProof',
      displayName: 'Remote COMBO editing implementation',
      category: 'test',
      outputNode: false,
      signature: 'remote-combo-m1-proof-node',
      interface: [
        {
          role: 'input', id: 'ready', required: true,
          type: { kind: 'concrete', types: ['core.combo'] },
          widget: {
            type: 'COMBO', options: ['static-fallback'],
            remote: { route: '/api/choices/proof-ready', refreshButton: true },
          },
        },
        {
          role: 'input', id: 'unavailable', required: true,
          type: { kind: 'concrete', types: ['core.combo'] },
          widget: {
            type: 'COMBO', options: ['static-fallback'],
            remote: { route: '/api/choices/proof-unavailable', refreshButton: true },
          },
        },
      ],
    } },
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/choices/proof-ready', async (route) => {
    readyRequests += 1
    if (readyRequests === 1) {
      await readyGate
      await route.fulfill({ json: ['remote-b', 'remote-a', 'remote-c', 'remote-d'] })
      return
    }
    if (readyRequests === 2) {
      await route.fulfill({ json: ['remote-b', 'remote-a'] })
      return
    }
    if (readyRequests === 3) {
      await route.fulfill({ json: ['remote-b'] })
      return
    }
    await route.fulfill({ status: 400, body: 'permanent refresh failure' })
  })
  await page.route('**/api/choices/proof-unavailable', (route) =>
    route.fulfill({ status: 400, body: 'permanent initial failure' }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(1)
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'remote-combo-m1-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type: 'RemoteComboProof', values: {
          ready: 'selected-oov', unavailable: 'unavailable-oov',
        } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 180, y: 160 }, size: { width: 420, height: 180 } } } } } },
    }, 'Remote COMBO editing implementation')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const readyPoint = await rowPoint(page, 'ready')
  await page.mouse.click(readyPoint.x, readyPoint.y)
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toHaveAttribute('data-remote', 'loading')
  await expect(dropdown.getByRole('option', { name: 'selected-oov' })).toBeVisible()
  await expect(dropdown.getByRole('option', { name: 'static-fallback' })).toBeVisible()
  await page.screenshot({ path: `${proofDir}/01-loading-static-oov.png`, animations: 'disabled' })

  releaseReady()
  await expect(dropdown).toHaveAttribute('data-remote', 'ready')
  await expect(dropdown.getByRole('option')).toHaveText(['selected-oov', 'remote-b', 'remote-a', 'remote-c', 'remote-d'])
  await page.screenshot({ path: `${proofDir}/02-ready-remote-oov.png`, animations: 'disabled' })

  const search = page.getByTestId('combo-search')
  await search.fill('remote')
  await search.press('End')
  await expect(dropdown.locator('.combo-option.active')).toHaveText('remote-d')
  await page.getByTestId('remote-refresh').click()
  await expect(dropdown).toHaveAttribute('data-remote', 'ready')
  await expect(dropdown.getByRole('option')).toHaveText(['remote-b', 'remote-a'])
  await page.screenshot({ path: `${proofDir}/03-filtered-refresh-clamped.png`, animations: 'disabled' })
  await expect(dropdown.locator('.combo-option.active')).toHaveText('remote-a')
  await expect(dropdown.locator('.combo-option.active')).toHaveAttribute('aria-selected', 'true')

  await search.fill('')
  await search.press('End')
  await expect(dropdown.locator('.combo-option.active')).toHaveText('remote-a')
  await page.getByTestId('remote-refresh').click()
  await expect(dropdown).toHaveAttribute('data-remote', 'ready')
  await expect(dropdown.getByRole('option')).toHaveText(['selected-oov', 'remote-b'])
  await page.screenshot({ path: `${proofDir}/04-unfiltered-refresh-clamped.png`, animations: 'disabled' })
  await expect(dropdown.locator('.combo-option.active')).toHaveText('remote-b')
  await expect(dropdown.locator('.combo-option.active')).toHaveAttribute('aria-selected', 'true')

  await page.getByTestId('remote-refresh').click()
  await expect(dropdown).toHaveAttribute('data-remote', 'stale')
  await expect(dropdown.getByRole('option')).toHaveText(['selected-oov', 'remote-b'])
  await expect(dropdown.getByText('remote options stale', { exact: true })).toBeVisible()
  await page.screenshot({ path: `${proofDir}/05-refresh-failure-stale.png`, animations: 'disabled' })

  await page.keyboard.press('Escape')
  const unavailablePoint = await rowPoint(page, 'unavailable')
  await page.mouse.click(unavailablePoint.x, unavailablePoint.y)
  await expect(dropdown).toHaveAttribute('data-remote', 'unavailable')
  await expect(dropdown.getByRole('option')).toHaveText(['unavailable-oov', 'static-fallback'])
  await expect(dropdown.getByText('remote options unavailable', { exact: true })).toBeVisible()
  await page.screenshot({ path: `${proofDir}/06-permanent-unavailable-fallback.png`, animations: 'disabled' })

  const values = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values)
  expect(values).toMatchObject({ ready: 'selected-oov', unavailable: 'unavailable-oov' })
})
