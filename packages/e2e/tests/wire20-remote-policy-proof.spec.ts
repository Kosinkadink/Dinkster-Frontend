import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/audit-f6-p2-proof'

async function rowPoint(page: Page, inputId: string) {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  }, inputId)
}

async function openCombo(page: Page, inputId: string) {
  const point = await rowPoint(page, inputId)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
}

async function value(page: Page, inputId: string) {
  return page.evaluate((inputId) =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values[inputId], inputId)
}

test('proves wire20 manual control policy, CAS, TTL, and phase1 fallback through the current live wire', async ({ page }) => {
  await mkdir(proofDir, { recursive: true })
  const calls = new Map<string, number>()
  let releaseEdit!: () => void
  const editGate = new Promise<void>((resolve) => { releaseEdit = resolve })
  let releaseTtlThird!: () => void
  const ttlThirdGate = new Promise<void>((resolve) => { releaseTtlThird = resolve })

  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1,
    dinkster: { version: 'wire20-remote-policy-proof', schemaWire: 21 },
    nodes: { Wire20RemotePolicyProof: {
      schemaVersion: 21, nodeType: 'Wire20RemotePolicyProof', displayName: 'Wire 20 Remote Policy',
      category: 'test', outputNode: false, signature: 'wire20-remote-policy-proof',
      interface: ['first', 'last', 'edit', 'ttl', 'legacy'].map((id) => ({
        role: 'input', id, required: true,
        type: { kind: 'concrete', types: ['core.combo'] },
        widget: {
          type: 'COMBO', options: [`${id}-old`],
          remote: {
            route: `/api/choices/${id}`, refreshButton: true,
            ...(id === 'first' || id === 'edit' ? { controlAfterRefresh: 'first' } : {}),
            ...(id === 'last' ? { controlAfterRefresh: 'last' } : {}),
            ...(id === 'ttl' ? { refreshMs: 1000, timeoutMs: 60_000 } : {}),
          },
        },
      })),
    } },
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/choices/*', async (route) => {
    const id = route.request().url().split('/').at(-1)!
    const count = (calls.get(id) ?? 0) + 1
    calls.set(id, count)
    if (id === 'edit' && count === 2) await editGate
    if (id === 'ttl' && count === 3) await ttlThirdGate
    await route.fulfill({ json: count === 1 ? [`${id}-old`] : [`${id}-new-a`, `${id}-new-b`] })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(1)
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire20-remote-policy-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type: 'Wire20RemotePolicyProof', values: {
          first: 'first-old', last: 'last-old', edit: 'edit-old', ttl: 'ttl-old', legacy: 'legacy-old',
        } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 160, y: 100 }, size: { width: 430, height: 250 } } } } } },
      ext: { 'dinkster.exposed': [{ graphId: 'g0', nodeId: 'n0', inputId: 'ttl' }] },
    }, 'Wire 20 Remote Policy')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })

  await openCombo(page, 'first')
  await page.getByTestId('remote-refresh').click()
  await expect.poll(() => value(page, 'first')).toBe('first-new-a')
  await page.screenshot({ path: `${proofDir}/01-first-published-and-applied.png`, animations: 'disabled' })
  await page.keyboard.press('Control+z')
  await expect.poll(() => value(page, 'first')).toBe('first-old')
  await openCombo(page, 'first')
  await expect(page.getByRole('option')).toHaveText(['first-old', 'first-new-a', 'first-new-b'])
  await page.screenshot({ path: `${proofDir}/02-first-one-undo-value-only.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await openCombo(page, 'last')
  await page.getByTestId('remote-refresh').click()
  await expect.poll(() => value(page, 'last')).toBe('last-new-b')
  await page.screenshot({ path: `${proofDir}/03-last-applied.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await openCombo(page, 'edit')
  await page.getByTestId('remote-refresh').click()
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n0', inputId: 'edit', value: 'user-edit' },
  }))
  releaseEdit()
  await expect.poll(() => value(page, 'edit')).toBe('user-edit')
  await page.screenshot({ path: `${proofDir}/04-intervening-edit-preserved.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await openCombo(page, 'ttl')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1100)
  await openCombo(page, 'ttl')
  await expect.poll(() => calls.get('ttl')).toBe(2)
  await expect(value(page, 'ttl')).resolves.toBe('ttl-old')
  await page.screenshot({ path: `${proofDir}/05-ttl-refetch-no-advance.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await openCombo(page, 'legacy')
  await page.getByTestId('remote-refresh').click()
  await expect.poll(() => calls.get('legacy')).toBe(2)
  await expect(value(page, 'legacy')).resolves.toBe('legacy-old')
  await page.screenshot({ path: `${proofDir}/06-phase1-no-policy-unchanged.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  const appCombo = page.getByTestId('app-view-combo')
  await appCombo.focus()
  await appCombo.press('Enter')
  const appOptions = page.getByRole('listbox', { name: 'ttl' }).getByRole('option')
  await expect(appOptions).toHaveText(['ttl-old', 'ttl-new-a', 'ttl-new-b'])
  await appCombo.press('Escape')
  await page.waitForTimeout(1100)
  await page.getByTestId('app-view').click({ position: { x: 2, y: 2 } })
  await appCombo.focus()
  await expect.poll(() => calls.get('ttl')).toBe(3)
  await appCombo.press('Enter')
  await expect(appOptions).toHaveText(['ttl-old', 'ttl-new-a', 'ttl-new-b'])
  await appCombo.dispatchEvent('pointerdown')
  await page.waitForTimeout(50)
  expect(calls.get('ttl')).toBe(3)
  releaseTtlThird()
  await expect(appOptions).toHaveText(['ttl-old', 'ttl-new-a', 'ttl-new-b'])
  expect(calls.get('ttl')).toBe(3)
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Graph' }).click()
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('app-view')).toHaveCount(0)
})
