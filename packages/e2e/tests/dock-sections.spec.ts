/**
 * Sectioned dock zones: dropping a tab on the far half of a zone splits it
 * into two stacked (side zones) or side-by-side (bottom) sections, the
 * divider resizes them, the split persists, and moving the last tab out of
 * a section collapses the zone back to one section. Universal dockability:
 * panels that once lived only in one zone now dock in any zone.
 */
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

type DockZone = 'left' | 'right' | 'bottom'
interface SectionedTestApp {
  readonly dock: {
    effective(): {
      readonly zones: Readonly<Record<DockZone, {
        readonly sections: readonly { readonly tabs: readonly string[]; readonly activeTab?: string }[]
        readonly split: number
      }>>
    }
    dock(id: string, zone: DockZone, index?: number, section?: number): boolean
  }
  readonly panels: {
    placementOf(id: string): string | undefined
  }
}

const capture = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_169'] !== '1') return
  await page.screenshot({ path: evidencePath('issue-169', `${name}.png`), animations: 'disabled' })
}

const zoneTab = (page: Page, zone: DockZone, id: string): Locator =>
  page.getByTestId(`dock-zone-${zone}`).locator(`.product-tab[data-tab-id="${id}"]`)

const center = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const zoneSections = (page: Page, zone: DockZone): Promise<readonly (readonly string[])[]> =>
  page.evaluate((id) => {
    const app = window.__dinksterTest!.app as unknown as SectionedTestApp
    return app.dock.effective().zones[id].sections.map((section) => [...section.tabs])
  }, zone)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('dock-zone-right')).toBeVisible()
})

test('dropping a tab on the lower half of the right zone opens a second section that persists', async ({ page }) => {
  const queue = zoneTab(page, 'right', 'queue')
  const from = await center(queue)
  const zoneBox = (await page.getByTestId('dock-zone-right').boundingBox())!

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height * 0.8, { steps: 4 })
  const target = page.getByTestId('panel-drag-target')
  await expect(target).toHaveAttribute('data-kind', 'split')
  await expect(target).toHaveAttribute('data-zone', 'right')
  await expect(target).toHaveAttribute('data-allowed', 'true')
  await capture(page, 'half-zone-target-right')
  await page.mouse.up()

  await expect(page.getByTestId('dock-zone-section-right-1')).toBeVisible()
  await expect(page.getByTestId('dock-section-divider-right')).toBeVisible()
  expect((await zoneSections(page, 'right')).at(-1)).toEqual(['queue'])
  // Both sections render their active panel bodies at the same time.
  const tablists = page.getByTestId('dock-zone-right').locator('[role="tablist"]')
  await expect(tablists).toHaveCount(2)
  await capture(page, 'sectioned-right-zone')

  await page.reload()
  await expect(page.getByTestId('dock-zone-section-right-1')).toBeVisible()
  expect((await zoneSections(page, 'right')).at(-1)).toEqual(['queue'])
})

test('the section divider resizes with the keyboard and the split survives a reload', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as SectionedTestApp
    app.dock.dock('queue', 'right', undefined, 1)
  })
  const divider = page.getByTestId('dock-section-divider-right')
  await expect(divider).toHaveAttribute('aria-valuenow', '50')

  await divider.focus()
  await page.keyboard.press('ArrowDown')
  await expect(divider).toHaveAttribute('aria-valuenow', '55')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(divider).toHaveAttribute('aria-valuenow', '45')

  // The first section's rendered share follows the split.
  const first = (await page.getByTestId('dock-zone-section-right-0').boundingBox())!
  const second = (await page.getByTestId('dock-zone-section-right-1').boundingBox())!
  expect(first.height).toBeLessThan(second.height)

  await page.reload()
  await expect(page.getByTestId('dock-section-divider-right')).toHaveAttribute('aria-valuenow', '45')
})

test('moving the last tab out of a section collapses the zone to one section', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as SectionedTestApp
    app.dock.dock('queue', 'right', undefined, 1)
  })
  await expect(page.getByTestId('dock-zone-section-right-1')).toBeVisible()

  const queue = zoneTab(page, 'right', 'queue')
  const from = await center(queue)
  const firstStrip = page.getByTestId('dock-zone-section-right-0').locator('[role="tablist"]')
  const to = await center(firstStrip)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-allowed', 'true')
  await page.mouse.up()

  await expect(page.getByTestId('dock-zone-section-right-1')).toHaveCount(0)
  await expect(page.getByTestId('dock-section-divider-right')).toHaveCount(0)
  expect(await zoneSections(page, 'right')).toHaveLength(1)
  expect((await zoneSections(page, 'right'))[0]).toContain('queue')
})

test('a bottom-zone panel docks into the right zone', async ({ page }) => {
  await page.getByTestId('logs-toggle').click()
  const logs = zoneTab(page, 'bottom', 'logs')
  await expect(logs).toBeVisible()
  const from = await center(logs)
  const strip = page.getByTestId('dock-zone-right').locator('[role="tablist"]')
  const to = await center(strip)

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-allowed', 'true')
  await page.mouse.up()

  expect((await zoneSections(page, 'right')).flat()).toContain('logs')
  expect(await page.evaluate(() =>
    (window.__dinksterTest!.app as unknown as SectionedTestApp).panels.placementOf('logs'))).toBe('rail')
})

test('the bottom zone splits into side-by-side sections', async ({ page }) => {
  await page.getByTestId('logs-toggle').click()
  await expect(zoneTab(page, 'bottom', 'logs')).toBeVisible()

  // Give the bottom zone a second tab so the far half offers a split.
  const queue = zoneTab(page, 'right', 'queue')
  const queueFrom = await center(queue)
  const bottomStrip = page.getByTestId('dock-zone-bottom').locator('[role="tablist"]')
  const stripTo = await center(bottomStrip)
  await page.mouse.move(queueFrom.x, queueFrom.y)
  await page.mouse.down()
  await page.mouse.move(stripTo.x, stripTo.y, { steps: 4 })
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-allowed', 'true')
  await page.mouse.up()
  expect(await page.evaluate(() =>
    (window.__dinksterTest!.app as unknown as SectionedTestApp).panels.placementOf('queue'))).toBe('bottom')

  const dockedQueue = zoneTab(page, 'bottom', 'queue')
  const from = await center(dockedQueue)
  const zoneBox = (await page.getByTestId('dock-zone-bottom').boundingBox())!
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(zoneBox.x + zoneBox.width * 0.85, zoneBox.y + zoneBox.height * 0.6, { steps: 4 })
  const target = page.getByTestId('panel-drag-target')
  await expect(target).toHaveAttribute('data-kind', 'split')
  await expect(target).toHaveAttribute('data-zone', 'bottom')
  await capture(page, 'half-zone-target-bottom')
  await page.mouse.up()

  await expect(page.getByTestId('dock-zone-section-bottom-1')).toBeVisible()
  const divider = page.getByTestId('dock-section-divider-bottom')
  await expect(divider).toBeVisible()
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
  expect((await zoneSections(page, 'bottom')).at(-1)).toEqual(['queue'])
  // Sections sit side by side: the second starts right of the first.
  const first = (await page.getByTestId('dock-zone-section-bottom-0').boundingBox())!
  const second = (await page.getByTestId('dock-zone-section-bottom-1').boundingBox())!
  expect(second.x).toBeGreaterThan(first.x + first.width - 1)
  await capture(page, 'sectioned-bottom-zone')
})
