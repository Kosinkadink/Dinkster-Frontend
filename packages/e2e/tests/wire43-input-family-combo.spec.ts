import { expect, test, type Page } from '@playwright/test'

const REQUIRED = process.env['DINKSTER_REQUIRE_BACKEND'] === '1'

async function clickChoiceRow(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'route')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'choice')
    if (!row) throw new Error('Route Switch by Name choice row is missing')
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.click(point.x, point.y)
}

test('wire 43 Route Switch by Name edits labels but stores stable member ids', async ({ page }) => {
  const catalog = await page.request.get('/api/nodes', { timeout: 5_000 }).catch(() => undefined)
  if ((!catalog?.ok() || catalog === undefined) && !REQUIRED) {
    test.skip(true, 'no wire-43 Dinkster backend reachable through the dev proxy')
  }
  expect(catalog?.ok(), 'wire-43 Dinkster backend is required').toBe(true)
  const payload = await catalog!.json() as { nodes?: Record<string, unknown> }
  expect(payload.nodes?.['dinkster.route.switch_by_name']).toBeDefined()

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined,
  ), { timeout: 15_000 }).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire43-input-family-combo', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { route: {
          id: 'route', type: 'dinkster.route.switch_by_name',
          values: { choice: 'm7' },
          dynamic: { values: {
            members: ['m7', 'm2'],
            memberLabels: { m7: 'Background', m2: 'Subject' },
          } },
        } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { route: { position: { x: 220, y: 160 } } } } } },
    }, 'Named routing')
  })
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('dinkster.route.switch_by_name') ?? false,
  ), { timeout: 15_000 }).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await clickChoiceRow(page)
  await expect(page.getByTestId('input-family-labels')).toContainText('Stable ID: m7')
  await expect(page.getByRole('option', { name: 'Background', exact: true })).toBeVisible()
  await page.screenshot({ path: '../../docs/evidence/issue-456/wire43-branch-labels.png', fullPage: true })

  await page.getByTestId('input-family-label-m2').fill('Background')
  await expect(page.getByTestId('input-family-label-error')).toHaveText('Duplicate branch labels are not allowed')
  await expect(page.getByTestId('input-family-label-apply')).toBeDisabled()
  await page.getByTestId('input-family-label-m2').fill('Foreground')
  await page.getByTestId('input-family-label-apply').click()

  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.route!.dynamic?.values?.memberLabels,
  )).toEqual({ m7: 'Background', m2: 'Foreground' })

  await clickChoiceRow(page)
  await page.getByRole('option', { name: 'Foreground', exact: true }).click()
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.route!.values.choice,
  )).toBe('m2')
})
