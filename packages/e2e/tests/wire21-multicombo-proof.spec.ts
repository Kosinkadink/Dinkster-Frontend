import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/audit-f7-proof'

async function cssTokenValue(page: Page, property: string, token: string): Promise<string> {
  return page.evaluate(({ property, token }) => {
    const probe = document.createElement('div')
    probe.style.setProperty(property, `var(${token})`)
    document.body.append(probe)
    const value = getComputedStyle(probe).getPropertyValue(property)
    probe.remove()
    return value
  }, { property, token })
}

async function rowPoint(page: Page, inputId: string) {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  }, inputId)
}

async function openMulti(page: Page, inputId: string) {
  const point = await rowPoint(page, inputId)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('multi-combo-dropdown')).toBeVisible()
}

async function stored(page: Page, inputId: string) {
  return page.evaluate((inputId) =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values[inputId], inputId)
}

const multiInterface = [
  { id: 'ordered', widget: { type: 'MULTI_COMBO', options: ['alpha', 'beta'], chip: true } },
  { id: 'oov', widget: { type: 'MULTI_COMBO', options: ['known'], chip: false } },
  { id: 'absent', widget: { type: 'MULTI_COMBO', options: ['plain'] } },
  { id: 'remote', widget: { type: 'MULTI_COMBO', options: [], remote: { route: '/api/choices/providers', refreshButton: true } } },
].map(({ id, widget }) => ({
  role: 'input', id, required: true,
  type: { kind: 'list', element: { kind: 'concrete', types: ['core.combo'] } }, widget,
}))

test('proves wire21 MULTI_COMBO editing, presentation, OOV, and remote choices', async ({ page }) => {
  await mkdir(proofDir, { recursive: true })
  const remoteRequests: string[] = []
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1,
    dinkster: { version: 'wire21-multicombo-proof', schemaWire: 1 },
    nodes: { Wire21MultiProof: {
      schemaVersion: 1, nodeType: 'Wire21MultiProof', displayName: 'Wire 21 Multi Combo',
      category: 'test', outputNode: false, signature: 'wire21-multi-proof', interface: multiInterface,
    } },
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/choices/providers', (route) => {
    remoteRequests.push(route.request().url())
    return route.fulfill({ json: ['provider-a', 'provider-b'] })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(1)
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire21-multi-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type: 'Wire21MultiProof', values: {
          ordered: ['alpha', 'beta', 'alpha'], oov: ['missing-static'], absent: ['plain'], remote: ['snapshot-miss'],
        } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 140, y: 90 }, size: { width: 460, height: 250 } } } } } },
    }, 'Wire 21 Multi Combo')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })

  await openMulti(page, 'ordered')
  await expect(page.getByTestId('multi-combo-value')).toHaveText(['alpha', 'beta', 'alpha'])
  await expect(page.getByTestId('multi-combo-dropdown')).toHaveAttribute('data-chip', 'true')
  await expect(page.getByTestId('multi-combo-value').first()).toHaveCSS('border-radius', '999px')
  await page.getByTestId('multi-combo-option').filter({ hasText: 'beta' }).click()
  await expect(page.getByTestId('multi-combo-value')).toHaveText(['alpha', 'beta', 'alpha', 'beta'])
  await page.screenshot({ path: `${proofDir}/01-ordered-duplicates-appended-chip-true.png`, animations: 'disabled' })
  await page.getByTestId('multi-combo-apply').click()
  await expect.poll(() => stored(page, 'ordered')).toEqual(['alpha', 'beta', 'alpha', 'beta'])
  await openMulti(page, 'ordered')
  await expect(page.getByTestId('multi-combo-value')).toHaveText(['alpha', 'beta', 'alpha', 'beta'])
  await page.screenshot({ path: `${proofDir}/02-applied-exact-array.png`, animations: 'disabled' })
  await page.getByTestId('multi-combo-clear').click()
  await page.getByTestId('multi-combo-apply').click()
  await expect.poll(() => stored(page, 'ordered')).toEqual([])
  await openMulti(page, 'ordered')
  await expect(page.getByText('No selections')).toBeVisible()
  await page.screenshot({ path: `${proofDir}/03-clear-applied-empty-array.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await openMulti(page, 'oov')
  await expect(page.getByTestId('multi-combo-dropdown')).toHaveAttribute('data-chip', 'false')
  await expect(page.getByTestId('multi-combo-value')).toHaveAttribute('data-oov', 'error')
  await expect(page.getByTestId('multi-combo-value')).toHaveCSS(
    'border-color', await cssTokenValue(page, 'border-color', '--dinkster-danger-border'),
  )
  await page.screenshot({ path: `${proofDir}/04-static-oov-chip-false.png`, animations: 'disabled' })
  await page.getByTestId('multi-combo-apply').click()
  await expect.poll(() => stored(page, 'oov')).toEqual(['missing-static'])
  await page.keyboard.press('Escape')

  await openMulti(page, 'absent')
  await expect(page.getByTestId('multi-combo-dropdown')).toHaveAttribute('data-chip', 'absent')
  await expect(page.getByTestId('multi-combo-value')).toHaveCSS(
    'border-radius', await cssTokenValue(page, 'border-radius', '--dinkster-radius-small'),
  )
  await page.screenshot({ path: `${proofDir}/05-chip-absent.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await openMulti(page, 'remote')
  await expect(page.getByTestId('multi-combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  await expect(page.getByTestId('multi-combo-option')).toHaveText(['provider-a', 'provider-b'])
  await expect(page.getByTestId('multi-combo-value')).toHaveAttribute('data-oov', 'warning')
  await expect(page.getByTestId('multi-combo-value')).toHaveCSS(
    'border-color', await cssTokenValue(page, 'border-color', '--dinkster-warning-border'),
  )
  expect(remoteRequests).toHaveLength(1)
  expect(new URL(remoteRequests[0]!).pathname).toBe('/api/choices/providers')
  await page.screenshot({ path: `${proofDir}/06-remote-options-snapshot-miss-warning.png`, animations: 'disabled' })
})

test('proves wire21 catalog retains ordinary schema when the server omits a wire22-only node', async ({ page }) => {
  await mkdir(proofDir, { recursive: true })
  const schemaSkips = [{
    nodeType: 'UploadOnly', code: 'schema-wire-required', requiredWire: 22,
    reason: 'source filename input requires schema wire 22',
  }]
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 2,
    dinkster: { version: 'wire21-server-encoded-proof', schemaWire: 1 },
    schemaSkips,
    nodes: { OrdinaryWire21: {
      schemaVersion: 1, nodeType: 'OrdinaryWire21', displayName: 'Ordinary Wire 21', category: 'test',
      outputNode: false, signature: 'ordinary-wire21', interface: [{
        role: 'input', id: 'text', required: true, type: { kind: 'concrete', types: ['core.string'] },
        widget: { type: 'STRING', multiline: false },
      }],
    } },
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const registry = window.__dinksterTest?.app.backends.get()[0]?.registry.get()
    return registry ? [...registry.schemas.keys()] : []
  })).toEqual(['OrdinaryWire21'])
  const proof = await page.evaluate(() => {
    const registry = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!
    return {
      schemas: [...registry.schemas.keys()],
      skip: registry.diagnostics.find((diagnostic) => diagnostic.code === 'schema.dinkster.schemaWireRequired')?.data,
    }
  })
  const schemas = proof.schemas
  expect(schemas).not.toContain('UploadOnly')
  expect(proof.skip).toEqual(schemaSkips[0])
  await page.evaluate((proof) => {
    const banner = document.createElement('pre')
    banner.style.cssText = 'position:fixed;left:80px;top:90px;z-index:10000;background:#102030;color:#e8f4ff;padding:18px;border:2px solid #60a5fa;font-size:18px'
    banner.textContent = `wire 21 server catalog\nloaded: ${proof.schemas.join(', ')}\nwire 22-only node visible: false\nschemaSkips: ${String(proof.skip?.nodeType)} (${String(proof.skip?.code)})`
    document.body.appendChild(banner)
  }, proof)
  await page.screenshot({ path: `${proofDir}/07-wire21-whole-node-skip-ordinary-retained.png`, animations: 'disabled' })
})
